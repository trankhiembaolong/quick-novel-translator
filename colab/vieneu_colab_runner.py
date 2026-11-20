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
import struct
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

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

_GPU_BATCH_LIMITS = {
    "T4": 16,
    "L4": 32,
    "A100": 32,
}


def resolve_batch_limit(gpu_tier: str) -> int:
    """Resolve static batch size (power-of-two aligned for FusedFrame CUDA graphs)."""
    default_bs = _GPU_BATCH_LIMITS.get(str(gpu_tier or "T4").strip().upper(), 16)
    try:
        return max(1, min(64, int(os.environ.get("VIENEU_BATCH_SIZE", str(default_bs)))))
    except ValueError:
        return default_bs


def _patch_cuda_dtype_for_colab() -> str:
    """Force native Tensor Core dtype: FP16 on Turing T4 (sm_75), BF16 on Ampere+ (sm_80+).

    VieNeu-TTS v3 Turbo's default ``_resolve_dtype`` checks ``torch.cuda.is_bf16_supported()``,
    which returns True on Turing T4 via slow software emulation, and ``hub_load_v3_turbo._apply_dtype``
    has no ``float16`` branch so it leaves weights in FP32 even when FP16 is requested.
    """
    try:
        import torch
        if not torch.cuda.is_available():
            return "cpu"

        try:
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
        except Exception:
            pass

        raw_dtype = str(os.environ.get("VIENEU_COLAB_DTYPE", "auto") or "auto").strip().lower()
        major, _minor = torch.cuda.get_device_capability(0)
        if raw_dtype in ("fp16", "float16"):
            target_dtype, dtype_label = torch.float16, "float16"
        elif raw_dtype in ("bf16", "bfloat16"):
            target_dtype, dtype_label = torch.bfloat16, "bfloat16"
        elif raw_dtype in ("fp32", "float32"):
            target_dtype, dtype_label = torch.float32, "float32"
        elif major >= 8:
            target_dtype, dtype_label = torch.bfloat16, "bfloat16"
        elif major == 7:
            target_dtype, dtype_label = torch.float16, "float16"
        else:
            target_dtype, dtype_label = torch.float32, "float32"

        import vieneu._v3_turbo_engine.hub_load_v3_turbo as hub_load_mod
        import vieneu._v3_turbo_engine.inference_v3_turbo as inf_mod

        def _colab_apply_dtype(model, device: torch.device, dtype: torch.dtype):
            model = model.to(device=device)
            if dtype == torch.float32:
                return model.float()
            if device.type == "cuda":
                if dtype == torch.float16:
                    return model.to(dtype=torch.float16)
                if dtype == torch.bfloat16:
                    return model.to(dtype=torch.bfloat16)
            return model

        def _colab_resolve_dtype(self, dtype: str) -> torch.dtype:
            if dtype == "auto":
                if self.device.type == "cuda":
                    return target_dtype
                return torch.float32
            return {
                "float32": torch.float32,
                "float16": torch.float16,
                "bfloat16": torch.bfloat16,
            }[dtype]

        hub_load_mod._apply_dtype = _colab_apply_dtype
        inf_mod.VieNeuTTSv3Turbo._resolve_dtype = _colab_resolve_dtype
        return dtype_label
    except Exception as exc:
        log.debug("Colab CUDA dtype patch skipped: %s", exc)
        return "unknown"


def _detect_model_dtype_label(eng, fallback: str = "unknown") -> str:
    """Read actual parameter dtype of loaded v3 Turbo model when available."""
    try:
        model = getattr(getattr(getattr(eng, "tts", None), "engine", None), "model", None)
        if model is not None:
            param = next(model.parameters(), None)
            if param is not None:
                return str(param.dtype).replace("torch.", "")
    except Exception:
        pass
    return fallback


def _wav_to_pcm16_bytes(wav, src_sr: int, target_sr: int, oai) -> bytes:
    """Resample float32 waveform from ``src_sr`` to ``target_sr`` and encode s16le PCM."""
    import numpy as np

    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return b""
    if target_sr != src_sr:
        try:
            import soxr

            arr = np.asarray(soxr.resample(arr, src_sr, target_sr, quality="HQ"), dtype=np.float32)
        except Exception:
            out_len = max(1, int(round(arr.size * (target_sr / float(src_sr)))))
            xp = np.linspace(0.0, 1.0, arr.size, endpoint=False)
            x = np.linspace(0.0, 1.0, out_len, endpoint=False)
            arr = np.asarray(np.interp(x, xp, arr), dtype=np.float32)
    pcm_fn = getattr(oai, "_pcm16", None)
    if callable(pcm_fn):
        return pcm_fn(arr)
    return (np.asarray(arr, dtype=np.float32) * 32767).clip(-32768, 32767).astype("<i2").tobytes()


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


def _setup_cors_and_routes(
    oai,
    eng,
    pool: Optional[ColabEnginePool],
    *,
    gpu_name: str,
    gpu_tier: str,
    vram_gb: float,
    listen_streams: int,
    export_cap: int,
    batch_cap: int = 16,
    model_dtype: str = "auto",
) -> None:
    from fastapi import Depends, HTTPException, Response
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
            expose_headers=[
                "X-Batch-Audio-Sec",
                "X-Batch-Wall-Sec",
                "X-Batch-Speedup",
                "X-Batch-Dtype",
                "X-Sample-Rate",
            ],
        )

    # Bind into module globals so FastAPI resolves annotations under `from __future__ import annotations`.
    global ColabWorkerModeRequest, ColabBatchSpeechRequest

    class ColabWorkerModeRequest(BaseModel):
        mode: str = "listen"
        lease_id: Optional[str] = None
        workers: Optional[int] = Field(default=None, ge=1, le=12)
        ttl_sec: float = Field(default=_DEFAULT_EXPORT_LEASE_TTL_SEC, ge=10.0, le=600.0)
        gpu_tier: Optional[str] = None

    class ColabBatchSpeechRequest(BaseModel):
        model: str = "vieneu-v3-turbo"
        inputs: List[str] = Field(min_length=1, max_length=64)
        voice: Optional[str] = None
        sample_rate: int = 24000
        temperature: float = Field(0.4, ge=0.0, le=2.0, allow_inf_nan=False)
        top_k: int = Field(12, ge=1, le=1024)
        top_p: float = Field(0.85, gt=0.0, le=1.0, allow_inf_nan=False)
        repetition_penalty: float = Field(1.05, ge=1.0, le=2.0, allow_inf_nan=False)
        max_chars: int = Field(380, ge=64, le=512)
        batch_size: Optional[int] = Field(default=None, ge=1, le=64)

    oai.app.router.routes = [
        r
        for r in oai.app.router.routes
        if getattr(r, "path", None) not in ("/health", "/v1/workers/mode", "/v1/audio/batch")
    ]

    active_leases: dict[str, float] = {}
    lease_lock = threading.Lock()
    batch_lock = threading.Lock()
    batch_stats = {"total_batches": 0, "total_audio_sec": 0.0, "last_speedup": 0.0}

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
            "batch_supported": True,
            "batch_max_size": batch_cap,
            "model_dtype": _detect_model_dtype_label(eng, model_dtype),
            "stats": {
                "total_batches": batch_stats["total_batches"],
                "total_audio_sec": round(batch_stats["total_audio_sec"], 2),
                "last_speedup": round(batch_stats["last_speedup"], 2),
            },
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

    @oai.app.post("/v1/audio/batch", dependencies=[Depends(oai._auth)])
    def speech_batch(req: ColabBatchSpeechRequest):
        if req.sample_rate not in (48000, 24000, 16000, 8000):
            raise HTTPException(400, "sample_rate must be one of (48000, 24000, 16000, 8000)")
        tts = getattr(eng, "tts", None)
        if tts is None:
            raise HTTPException(503, "speech engine not ready")
        if req.voice and hasattr(tts, "resolve_voice_name") and tts.resolve_voice_name(req.voice) is None:
            raise HTTPException(400, f"unknown voice '{req.voice}'; see GET /v1/voices")

        non_empty_indices: List[int] = []
        non_empty_texts: List[str] = []
        for idx, raw_text in enumerate(req.inputs):
            txt = str(raw_text or "").strip()
            if txt:
                non_empty_indices.append(idx)
                non_empty_texts.append(txt)

        t0 = time.perf_counter()
        effective_bs = max(1, min(batch_cap, int(req.batch_size or batch_cap)))
        src_sr = int(getattr(tts, "sample_rate", getattr(oai, "SAMPLE_RATE", 48000)) or 48000)

        wavs_by_index: dict[int, object] = {}
        total_src_samples = 0
        if non_empty_texts:
            with batch_lock:
                if hasattr(tts, "infer_batch"):
                    wavs = tts.infer_batch(
                        non_empty_texts,
                        voice=req.voice or None,
                        apply_watermark=getattr(eng, "watermark", False),
                        temperature=req.temperature,
                        top_k=req.top_k,
                        top_p=req.top_p,
                        repetition_penalty=req.repetition_penalty,
                        max_chars=req.max_chars,
                        batch_size=effective_bs,
                    )
                else:
                    wavs = [
                        tts.infer(
                            t,
                            voice=req.voice or None,
                            apply_watermark=getattr(eng, "watermark", False),
                            temperature=req.temperature,
                            top_k=req.top_k,
                            top_p=req.top_p,
                            repetition_penalty=req.repetition_penalty,
                            max_chars=req.max_chars,
                        )
                        for t in non_empty_texts
                    ]
            for idx, w in zip(non_empty_indices, wavs):
                wavs_by_index[idx] = w
                if w is not None:
                    total_src_samples += len(w)

        pcm_items = [
            _wav_to_pcm16_bytes(wavs_by_index[idx], src_sr, req.sample_rate, oai)
            if idx in wavs_by_index
            else b""
            for idx in range(len(req.inputs))
        ]

        payload = bytearray(b"STVB")
        payload.extend(struct.pack("<III", 1, req.sample_rate, len(pcm_items)))
        for pcm_bytes in pcm_items:
            payload.extend(struct.pack("<I", len(pcm_bytes)))
            payload.extend(pcm_bytes)

        audio_sec = total_src_samples / float(src_sr or 48000)
        wall_sec = max(1e-3, time.perf_counter() - t0)
        speedup = audio_sec / wall_sec
        actual_dtype = _detect_model_dtype_label(eng, model_dtype)
        batch_stats["total_batches"] += 1
        batch_stats["total_audio_sec"] += audio_sec
        batch_stats["last_speedup"] = speedup
        log.info(
            "⚡ BATCH done: items=%d bs=%d audio=%.1fs wall=%.2fs speed=%.1fx dtype=%s",
            len(req.inputs),
            effective_bs,
            audio_sec,
            wall_sec,
            speedup,
            actual_dtype,
        )

        return Response(
            content=bytes(payload),
            media_type="application/octet-stream",
            headers={
                "X-Sample-Rate": str(req.sample_rate),
                "X-Batch-Audio-Sec": f"{audio_sec:.2f}",
                "X-Batch-Wall-Sec": f"{wall_sec:.2f}",
                "X-Batch-Speedup": f"{speedup:.1f}",
                "X-Batch-Dtype": actual_dtype,
                "Cache-Control": "no-store",
            },
        )

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
    batch_cap = resolve_batch_limit(gpu_tier)
    requested_dtype = _patch_cuda_dtype_for_colab()

    os.environ.setdefault("HOST", "127.0.0.1")
    os.environ.setdefault("PORT", "8000")
    os.environ.setdefault("VIENEU_WATERMARK", "0")
    os.environ.setdefault("VIENEU_MAX_STREAMS", str(export_cap))
    os.environ.setdefault("VIENEU_QUEUE", str(max(64, export_cap * 8)))
    os.environ.setdefault("VIENEU_QUEUE_TIMEOUT", "180")

    eng = oai.engine()
    if hasattr(eng, "tts") and hasattr(eng.tts, "max_batch_size"):
        cur_bs = int(getattr(eng.tts, "max_batch_size", 32) or 32)
        eng.tts.max_batch_size = max(cur_bs, batch_cap)
    actual_dtype = _detect_model_dtype_label(eng, requested_dtype)
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
        eng._gate = ResizableGate(export_cap)
        eng.max_streams = export_cap

    eng.queue_timeout = 180.0
    eng.max_queue = max(64, export_cap * 8)

    _setup_cors_and_routes(
        oai,
        eng,
        pool,
        gpu_name=gpu_name,
        gpu_tier=gpu_tier,
        vram_gb=vram_gb,
        listen_streams=listen_streams,
        export_cap=export_cap,
        batch_cap=batch_cap,
        model_dtype=actual_dtype,
    )

    log.info(
        "VieNeu Colab GPU Server ready: gpu=%s tier=%s vram=%.2fGB dtype=%s batch=%d listen=%d export_max=%d backend=%s",
        gpu_name,
        gpu_tier,
        vram_gb,
        actual_dtype,
        batch_cap,
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
