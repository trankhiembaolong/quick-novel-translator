"""
Google Colab GPU Multi-Worker Runner for VieNeu-TTS Server (Quick Novel Translator / STV).

Supports NVIDIA Tesla T4 (6 workers), NVIDIA L4 (8 workers), NVIDIA A100 (12 workers),
or automatic VRAM-based scaling (`VIENEU_COLAB_GPU_TIER=auto`).
Exposes OpenAI-compatible `/v1/audio/speech`, `/v1/voices`, `/health`, and `/v1/workers/mode`
with permissive CORS so the browser extension can connect over an HTTPS Cloudflare Tunnel.
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

for _env_key in (
    "OPENBLAS_NUM_THREADS",
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
):
    os.environ.setdefault(_env_key, "1")

log = logging.getLogger("vieneu.colab")
_tls = threading.local()

_DEFAULT_EXPORT_LEASE_TTL_SEC = 180.0
_V3_REPO = "pnnbao-ump/VieNeu-TTS-v3-Turbo"

_GPU_TIER_LIMITS = {
    "T4": (4, 6),
    "L4": (4, 8),
    "A100": (6, 12),
}


def detect_cuda_gpu() -> Tuple[str, float]:
    """Return ``(gpu_name, vram_gb)`` using PyTorch CUDA or ``nvidia-smi``."""
    try:
        import torch

        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            name = str(getattr(props, "name", "") or torch.cuda.get_device_name(0)).strip()
            vram_gb = float(getattr(props, "total_memory", 0)) / (1024 ** 3)
            if name:
                return name, round(vram_gb, 2)
    except Exception as exc:
        log.debug("torch.cuda detection skipped: %s", exc)

    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5,
        ).strip()
        if out:
            first_line = out.splitlines()[0]
            parts = [p.strip() for p in first_line.split(",")]
            name = parts[0] or "NVIDIA GPU"
            vram_mb = float(parts[1]) if len(parts) > 1 else 0.0
            return name, round(vram_mb / 1024.0, 2)
    except Exception as exc:
        log.debug("nvidia-smi detection skipped: %s", exc)

    return "CPU Fallback", 0.0


def resolve_tier_limits(requested_tier: Optional[str], vram_gb: float, gpu_name: str = "") -> Tuple[str, int, int]:
    """Resolve ``(tier, listen_streams, export_max_streams)`` from user tier and GPU VRAM."""
    raw = str(requested_tier or "auto").strip().upper()
    if raw in ("T4", "L4", "A100"):
        tier = raw
    else:
        upper_name = gpu_name.upper()
        if "A100" in upper_name or vram_gb >= 35.0:
            tier = "A100"
        elif "L4" in upper_name or vram_gb >= 20.0:
            tier = "L4"
        else:
            tier = "T4"

    listen_default, export_default = _GPU_TIER_LIMITS.get(tier, (4, 6))
    try:
        export_cap = max(1, min(12, int(os.environ.get("VIENEU_EXPORT_MAX_STREAMS", str(export_default)))))
    except ValueError:
        export_cap = export_default

    try:
        listen_streams = max(1, min(export_cap, int(os.environ.get("VIENEU_MAX_STREAMS", str(listen_default)))))
    except ValueError:
        listen_streams = min(listen_default, export_cap)

    return tier, listen_streams, export_cap


def _patch_fast_sampling(eng) -> None:
    """Use contiguous C-order head weights & preallocated buffers for faster acoustic sampling."""
    if getattr(eng, "_fast_sampling_patched", False):
        return
    if not all(hasattr(eng, attr) for attr in ("audio_emb", "text_emb", "n_vq", "hidden", "L_loc", "sgs", "eos_speech", "sess_ac", "_empty_past", "_split_past", "_sample")):
        return

    import numpy as np

    eng._audio_emb_C = [np.ascontiguousarray(eng.audio_emb[ch], dtype=np.float32) for ch in range(eng.n_vq)]
    eng._text_emb_C = np.ascontiguousarray(eng.text_emb, dtype=np.float32)
    eng._ac_pos_init = np.array([[0, 1]], dtype=np.int64)
    eng._ac_pos_steps = [np.array([[ch + 1]], dtype=np.int64) for ch in range(eng.n_vq)]
    eng._ac_empty_past_tmpl = eng._empty_past()
    eng._ac_tok_buf = np.empty((1, 2, eng.hidden), dtype=np.float32)
    eng._ac_tok_buf[0, 1] = eng.text_emb[eng.sgs]

    def _fast_acoustic_frame(h, temperature, top_k, top_p, rep_pen, hist):
        hidden_dim = eng.hidden
        tok = eng._ac_tok_buf
        tok[0, 0] = h[0]
        feed = {"token_emb": tok, "position_ids": eng._ac_pos_init}
        feed.update(eng._ac_empty_past_tmpl)
        out = eng.sess_ac.run(None, feed)
        hidden = out[0]
        pk, pv = eng._split_past(out, eng.L_loc)
        slot0 = hidden[0, 0]

        def _sample_channel(ch: int, vec: np.ndarray) -> int:
            logits = eng._audio_emb_C[ch] @ np.asarray(vec, dtype=np.float32)
            prev = hist[ch] if hist is not None else None
            code = eng._sample(logits, temperature, top_k, top_p, rep_pen, prev)
            if hist is not None:
                hist[ch].add(code)
            return code

        codes = [_sample_channel(0, hidden[0, 1])]
        for ch in range(1, eng.n_vq):
            emb = eng.audio_emb[ch - 1][codes[-1]]
            step_feed = {
                "token_emb": emb.reshape(1, 1, hidden_dim),
                "position_ids": eng._ac_pos_steps[ch],
            }
            for i in range(eng.L_loc):
                step_feed[f"past_k_{i}"] = pk[i]
                step_feed[f"past_v_{i}"] = pv[i]
            out = eng.sess_ac.run(None, step_feed)
            hidden = out[0]
            pk, pv = eng._split_past(out, eng.L_loc)
            codes.append(_sample_channel(ch, hidden[0, 0]))

        text_logits = eng._text_emb_C @ np.asarray(slot0, dtype=np.float32)
        eos = int(text_logits.argmax()) == eng.eos_speech
        return codes, eos

    eng._acoustic_frame = _fast_acoustic_frame
    eng._fast_sampling_patched = True


def _wrap_fast_stream(eng) -> None:
    if not hasattr(eng, "tts") or not hasattr(eng.tts, "infer_stream"):
        return
    orig_infer_stream = eng.tts.infer_stream

    def fast_aware_infer_stream(*args, **kwargs):
        is_fast = int(kwargs.get("max_chars", 256) or 256) >= 280
        gen = orig_infer_stream(*args, **kwargs)
        try:
            while True:
                _tls.fast_decode = is_fast
                try:
                    chunk = next(gen)
                finally:
                    _tls.fast_decode = False
                yield chunk
        except StopIteration:
            return
        finally:
            gen.close()

    eng.tts.infer_stream = fast_aware_infer_stream


class ResizableGate:
    """Thread-safe admission gate supporting live scaling up to 12 concurrent streams."""

    def __init__(self, limit: int = 1):
        self._cond = threading.Condition()
        self._limit = max(1, int(limit))
        self._in_use = 0

    @property
    def limit(self) -> int:
        with self._cond:
            return self._limit

    def set_limit(self, new_limit: int) -> None:
        with self._cond:
            self._limit = max(1, int(new_limit))
            self._cond.notify_all()

    def acquire(self, blocking: bool = True, timeout: Optional[float] = None) -> bool:
        deadline = None if (timeout is None or timeout < 0) else (time.monotonic() + float(timeout))
        with self._cond:
            while self._in_use >= self._limit:
                if not blocking:
                    return False
                if deadline is not None:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    self._cond.wait(timeout=remaining)
                else:
                    self._cond.wait()
            self._in_use += 1
            return True

    def release(self) -> None:
        with self._cond:
            if self._in_use > 0:
                self._in_use -= 1
            self._cond.notify_all()


@dataclass
class _WorkerSlot:
    worker: object
    is_extra: bool
    priority: int
    busy: bool = False
    retired: bool = False


def _new_cuda_session_options(ort, intra_threads: int = 2):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.inter_op_num_threads = 1
    so.intra_op_num_threads = max(1, int(intra_threads))
    return so


def _resolve_onnx_dirs(primary) -> Tuple[Path, Path]:
    from huggingface_hub import hf_hub_download

    onnx_dir = os.environ.get("VIENEU_ONNX_DIR")
    if onnx_dir:
        vd = Path(onnx_dir)
    else:
        vd = Path(
            hf_hub_download(
                primary.checkpoint_path,
                "vieneu_prefill.onnx",
                repo_type="model",
                subfolder="onnx_update",
                local_files_only=True,
            )
        ).parent
    cd = Path(primary._codec_enc_path).parent
    return vd, cd


def _clone_onnx_cuda_worker(primary, ort, tokenizers_mod, providers: list):
    from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine

    vd, cd = _resolve_onnx_dirs(primary)
    w = object.__new__(OnnxV3LiteEngine)
    w._lock = threading.RLock()
    for attr in (
        "device", "checkpoint_path", "cfg", "n_vq", "hidden", "L", "L_loc",
        "nH_loc", "hd_loc", "audio_pad", "tps", "tpe", "sgs", "eos_speech",
        "ref_slot", "text_vocab", "default_style_id", "style_labels",
        "use_speaker_embedding", "speaker_embedding_dim", "speaker_encoder_filename",
        "text_emb", "audio_emb",
    ):
        setattr(w, attr, getattr(primary, attr))

    if getattr(primary, "xvec_w", None) is not None:
        w.xvec_w = primary.xvec_w
        w.xvec_b = primary.xvec_b
        w.xvec_ln_w = primary.xvec_ln_w
        w.xvec_ln_b = primary.xvec_ln_b
        w.xvec_ln_eps = primary.xvec_ln_eps
    else:
        w.xvec_w = None

    w.tokenizer = tokenizers_mod.Tokenizer.from_file(str(vd / "tokenizer.json"))
    so = _new_cuda_session_options(ort, 2)
    w._so = so
    w.ort_intra_op_threads = 2
    w.sess_pre = ort.InferenceSession(str(vd / "vieneu_prefill.onnx"), so, providers=providers)
    w.sess_dec = ort.InferenceSession(str(vd / "vieneu_decode_step.onnx"), so, providers=providers)
    w.sess_ac = ort.InferenceSession(str(vd / "vieneu_acoustic_cached.onnx"), so, providers=providers)
    w.sess_codec_dec = ort.InferenceSession(str(cd / "moss_audio_tokenizer_decode_full.onnx"), so, providers=providers)
    w._codec_stream_spec = primary._codec_stream_spec
    if primary.sess_codec_step is not None and primary._codec_stream_spec is not None:
        w.sess_codec_step = ort.InferenceSession(str(cd / "moss_audio_tokenizer_decode_step.onnx"), so, providers=providers)
        w._codec_step_out_names = [o.name for o in w.sess_codec_step.get_outputs()]
    else:
        w.sess_codec_step = None
    w._codec_enc_path = primary._codec_enc_path
    w._sess_codec_enc = None
    w.speaker_encoder = primary.speaker_encoder
    w.denoiser = primary.denoiser
    w.babble_retries = getattr(primary, "babble_retries", 0)
    w.sample_rate = getattr(primary, "sample_rate", 48_000)
    _patch_fast_sampling(w)
    return w


class ColabEnginePool:
    """Multi-worker pool for Colab GPU export scaling (1..12 streams)."""

    def __init__(self, primary, *, eng, listen_streams: int, export_capacity: int, providers: list):
        _patch_fast_sampling(primary)
        self._primary = primary
        self._eng = eng
        self._providers = providers
        self._export_capacity = max(1, min(12, int(export_capacity)))
        self._listen_streams = max(1, min(self._export_capacity, int(listen_streams)))
        self._cond = threading.Condition()
        self._scale_lock = threading.Lock()
        self._active_leases: dict[str, float] = {}
        self._closed = False

        self._slots: list[_WorkerSlot] = [
            _WorkerSlot(worker=primary, is_extra=False, priority=0)
        ]
        for idx in range(1, self._listen_streams):
            slot = self._create_extra_slot(idx)
            if slot is None:
                break
            self._slots.append(slot)

        self._sync_engine_limits(len(self._slots))
        atexit.register(self.close)

    @property
    def size(self) -> int:
        with self._cond:
            return sum(1 for s in self._slots if not s.retired)

    @property
    def export_capacity(self) -> int:
        return self._export_capacity

    def __getattr__(self, name: str):
        return getattr(self._primary, name)

    def _create_extra_slot(self, slot_index: int) -> Optional[_WorkerSlot]:
        try:
            import onnxruntime as ort
            import tokenizers

            worker = _clone_onnx_cuda_worker(self._primary, ort, tokenizers, self._providers)
            return _WorkerSlot(worker=worker, is_extra=True, priority=slot_index)
        except Exception as exc:
            log.warning("Colab extra worker #%d creation failed: %s", slot_index + 1, exc)
            return None

    def _sync_engine_limits(self, active_count: int) -> None:
        count = max(1, int(active_count))
        self._eng.max_streams = count
        gate = getattr(self._eng, "_gate", None)
        if isinstance(gate, ResizableGate):
            gate.set_limit(count)
        else:
            self._eng._gate = ResizableGate(count)
        self._eng.max_queue = max(count * 4, int(os.environ.get("VIENEU_QUEUE", "32")))

    def acquire_export_lease(
        self,
        lease_id: Optional[str] = None,
        requested_workers: Optional[int] = None,
        ttl_sec: float = _DEFAULT_EXPORT_LEASE_TTL_SEC,
    ) -> dict:
        lid = str(lease_id or f"colab-{uuid.uuid4().hex[:8]}")
        ttl = max(10.0, min(600.0, float(ttl_sec or _DEFAULT_EXPORT_LEASE_TTL_SEC)))
        target = max(1, min(self._export_capacity, int(requested_workers or self._export_capacity)))

        with self._scale_lock:
            now = time.monotonic()
            for k in [k for k, dl in self._active_leases.items() if dl <= now]:
                del self._active_leases[k]
            self._active_leases[lid] = now + ttl

            with self._cond:
                next_idx = sum(1 for s in self._slots if not s.retired)
            while next_idx < target:
                slot = self._create_extra_slot(next_idx)
                if slot is None:
                    break
                with self._cond:
                    self._slots.append(slot)
                    self._cond.notify_all()
                next_idx += 1

            active_count = self.size
            self._sync_engine_limits(active_count)
            return {
                "ok": True,
                "mode": "export" if active_count > 1 else "listen",
                "max_streams": active_count,
                "active_workers": active_count,
                "export_capacity": self._export_capacity,
                "lease_id": lid,
            }

    def release_export_lease(self, lease_id: Optional[str] = None) -> dict:
        with self._scale_lock:
            if lease_id is None:
                self._active_leases.clear()
            else:
                self._active_leases.pop(str(lease_id), None)

            active_count = self.size
            if not self._active_leases:
                # Keep listen_streams slots warm in Colab memory
                with self._cond:
                    for s in list(self._slots):
                        if s.is_extra and s.priority >= self._listen_streams:
                            s.retired = True
                            if not s.busy:
                                self._slots.remove(s)
                    active_count = sum(1 for s in self._slots if not s.retired)
                self._sync_engine_limits(active_count)

            return {
                "ok": True,
                "mode": "export" if active_count > 1 else "listen",
                "max_streams": active_count,
                "active_workers": active_count,
                "export_capacity": self._export_capacity,
            }

    def _acquire_slot(self) -> _WorkerSlot:
        with self._cond:
            while True:
                active = [s for s in self._slots if not s.retired]
                active.sort(key=lambda s: s.priority)
                for s in active:
                    if not s.busy:
                        s.busy = True
                        return s
                self._cond.wait()

    def _release_slot(self, slot: _WorkerSlot) -> None:
        with self._cond:
            slot.busy = False
            if slot.retired and slot in self._slots:
                self._slots.remove(slot)
            self._cond.notify_all()

    def infer(self, *args, **kwargs):
        slot = self._acquire_slot()
        try:
            return slot.worker.infer(*args, **kwargs)
        finally:
            self._release_slot(slot)

    def infer_stream(self, *args, **kwargs):
        is_fast = bool(getattr(_tls, "fast_decode", False))
        slot = self._acquire_slot()
        try:
            if is_fast:
                orig_retries = getattr(slot.worker, "babble_retries", 0)
                slot.worker.babble_retries = 0
                try:
                    yield slot.worker.infer(*args, **kwargs)
                finally:
                    slot.worker.babble_retries = orig_retries
            else:
                yield from slot.worker.infer_stream(*args, **kwargs)
        finally:
            self._release_slot(slot)

    def prepare_reference(self, *args, **kwargs):
        with self._primary._lock:
            return self._primary.prepare_reference(*args, **kwargs)

    def extract_speaker_emb(self, *args, **kwargs):
        with self._primary._lock:
            return self._primary.extract_speaker_emb(*args, **kwargs)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        with self._cond:
            self._slots = [s for s in self._slots if not s.is_extra]


def _setup_cors_and_routes(oai, eng, pool: Optional[ColabEnginePool], *, gpu_name: str, gpu_tier: str, vram_gb: float, listen_streams: int, export_cap: int) -> None:
    from fastapi import Depends
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel, Field

    # Allow Chrome extension / browser requests over Cloudflare / ngrok HTTPS tunnel
    has_cors = any(getattr(m, "cls", None) is CORSMiddleware for m in getattr(oai.app, "user_middleware", []))
    if not has_cors:
        oai.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    class ColabWorkerModeRequest(BaseModel):
        mode: str = "listen"
        lease_id: Optional[str] = None
        workers: Optional[int] = Field(default=None, ge=1, le=12)
        ttl_sec: float = Field(default=_DEFAULT_EXPORT_LEASE_TTL_SEC, ge=10.0, le=600.0)
        gpu_tier: Optional[str] = None

    oai.app.router.routes = [
        r
        for r in oai.app.router.routes
        if getattr(r, "path", None) not in ("/health", "/v1/workers/mode")
    ]

    active_leases: dict[str, float] = {}
    lease_lock = threading.Lock()

    @oai.app.get("/health")
    def health():
        active_workers = pool.size if pool is not None else eng.max_streams
        cap = pool.export_capacity if pool is not None else export_cap
        body = {
            "status": "ok",
            "colab": True,
            "gpu_name": gpu_name,
            "gpu_tier": gpu_tier,
            "vram_gb": vram_gb,
            "backend": "colab_cuda",
            "underlying_backend": getattr(eng, "backend", "unknown"),
            "max_streams": eng.max_streams,
            "workers": active_workers,
            "worker_mode": "export" if active_workers > 1 else "listen",
            "export_max_streams": cap,
            "active": eng.active,
            "waiting": eng.waiting,
            "sample_rate": getattr(oai, "SAMPLE_RATE", 24000),
        }
        err = eng.stream_error() if hasattr(eng, "stream_error") else None
        if err is not None:
            return JSONResponse(
                {**body, "status": "error", "error": f"stream scheduler is down: {err!r}"},
                status_code=503,
            )
        return body

    @oai.app.post("/v1/workers/mode", dependencies=[Depends(oai._auth)])
    def set_worker_mode(req: ColabWorkerModeRequest):
        mode = str(req.mode or "listen").strip().lower()
        if pool is not None:
            if mode == "export":
                res = pool.acquire_export_lease(
                    lease_id=req.lease_id,
                    requested_workers=req.workers,
                    ttl_sec=req.ttl_sec,
                )
            else:
                res = pool.release_export_lease(lease_id=req.lease_id)
            return {**res, "gpu_name": gpu_name, "gpu_tier": gpu_tier, "vram_gb": vram_gb}

        with lease_lock:
            now = time.monotonic()
            for k in [k for k, dl in active_leases.items() if dl <= now]:
                del active_leases[k]

            lid = str(req.lease_id or f"colab-{uuid.uuid4().hex[:8]}")
            if mode == "export":
                active_leases[lid] = now + max(10.0, min(600.0, float(req.ttl_sec)))
                target = max(1, min(export_cap, int(req.workers or export_cap)))
            else:
                if req.lease_id:
                    active_leases.pop(str(req.lease_id), None)
                else:
                    active_leases.clear()
                target = listen_streams if not active_leases else eng.max_streams

            eng.max_streams = target
            eng.max_queue = max(target * 4, int(os.environ.get("VIENEU_QUEUE", "32")))
            gate = getattr(eng, "_gate", None)
            if isinstance(gate, ResizableGate):
                gate.set_limit(target)
            else:
                eng._gate = ResizableGate(target)

            return {
                "ok": True,
                "mode": "export" if target > 1 else "listen",
                "max_streams": target,
                "active_workers": target,
                "export_capacity": export_cap,
                "lease_id": lid,
                "gpu_name": gpu_name,
                "gpu_tier": gpu_tier,
                "vram_gb": vram_gb,
            }


def configure_colab_server() -> None:
    import apps.openai_speech as oai

    gpu_name, vram_gb = detect_cuda_gpu()
    requested_tier = os.environ.get("VIENEU_COLAB_GPU_TIER", "auto")
    gpu_tier, listen_streams, export_cap = resolve_tier_limits(requested_tier, vram_gb, gpu_name)

    os.environ.setdefault("HOST", "127.0.0.1")
    os.environ.setdefault("PORT", "8000")
    os.environ.setdefault("VIENEU_WATERMARK", "0")

    eng = oai.engine()
    pool: Optional[ColabEnginePool] = None

    if getattr(eng, "backend", None) == "onnx":
        try:
            import onnxruntime as ort

            avail = ort.get_available_providers()
            providers = (
                ["CUDAExecutionProvider", "CPUExecutionProvider"]
                if "CUDAExecutionProvider" in avail
                else ["CPUExecutionProvider"]
            )
            primary = eng.tts.engine
            _patch_fast_sampling(primary)
            _wrap_fast_stream(eng)
            pool = ColabEnginePool(
                primary,
                eng=eng,
                listen_streams=listen_streams,
                export_capacity=export_cap,
                providers=providers,
            )
            eng.tts.engine = pool
        except Exception as exc:
            log.warning("Colab ONNX pool setup fell back to single gate scaling: %s", exc)
            pool = None

    if pool is None:
        eng._gate = ResizableGate(listen_streams)
        eng.max_streams = listen_streams
        eng.max_queue = max(export_cap * 4, int(os.environ.get("VIENEU_QUEUE", "32")))

    _setup_cors_and_routes(
        oai,
        eng,
        pool,
        gpu_name=gpu_name,
        gpu_tier=gpu_tier,
        vram_gb=vram_gb,
        listen_streams=listen_streams,
        export_cap=export_cap,
    )

    log.info(
        "VieNeu Colab GPU Server ready: gpu=%s tier=%s vram=%.2fGB listen=%d export_max=%d backend=%s",
        gpu_name,
        gpu_tier,
        vram_gb,
        listen_streams,
        export_cap,
        getattr(eng, "backend", "unknown"),
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(name)s: %(message)s")
    import apps.openai_speech as oai

    configure_colab_server()
    oai.main()


if __name__ == "__main__":
    main()
