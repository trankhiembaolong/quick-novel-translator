"""
Google Colab GPU Multi-Worker Runner for VieNeu-TTS Server (Quick Novel Translator / STV).

Supports NVIDIA Tesla T4 (6 workers), NVIDIA L4 (8 workers), NVIDIA A100 (12 workers),
or automatic VRAM-based scaling (`VIENEU_COLAB_GPU_TIER=auto`).
Exposes OpenAI-compatible `/v1/audio/speech`, `/v1/voices`, `/health`, and `/v1/workers/mode`
with permissive CORS so the browser extension can connect over an HTTPS Cloudflare Tunnel.
"""
from __future__ import annotations

import atexit
import io
import json
import logging
import os
import re
import shutil
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


def _resample_float32(arr, src_sr: int, target_sr: int):
    """Resample a 1D float32 numpy waveform from ``src_sr`` to ``target_sr``."""
    import numpy as np

    if arr.size == 0 or target_sr == src_sr:
        return arr
    try:
        import soxr

        return np.asarray(soxr.resample(arr, src_sr, target_sr, quality="HQ"), dtype=np.float32)
    except Exception:
        out_len = max(1, int(round(arr.size * (target_sr / float(src_sr)))))
        xp = np.linspace(0.0, 1.0, arr.size, endpoint=False)
        x = np.linspace(0.0, 1.0, out_len, endpoint=False)
        return np.asarray(np.interp(x, xp, arr), dtype=np.float32)


def _float32_to_pcm16_bytes(arr, oai=None) -> bytes:
    """Encode a 1D float32 numpy waveform into little-endian s16le PCM bytes."""
    import numpy as np

    pcm_fn = getattr(oai, "_pcm16", None) if oai is not None else None
    if callable(pcm_fn):
        return pcm_fn(arr)
    return (np.asarray(arr, dtype=np.float32) * 32767).clip(-32768, 32767).astype("<i2").tobytes()


def _wav_to_pcm16_bytes(wav, src_sr: int, target_sr: int, oai) -> bytes:
    """Resample float32 waveform from ``src_sr`` to ``target_sr`` and encode s16le PCM."""
    import numpy as np

    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return b""
    arr = _resample_float32(arr, src_sr, target_sr)
    return _float32_to_pcm16_bytes(arr, oai)


def _trim_anchor_float32(arr, sr: int):
    """Trim leading ``Một.`` anchor prefix using 10ms RMS frame scan matching client createAnchorTrimmer."""
    import numpy as np

    if arr.size == 0:
        return arr
    eff_sr = int(sr or 24000)
    hop = max(160, int(round(eff_sr * 0.01)))
    n_frames = arr.size // hop
    if n_frames <= 0:
        return arr
    scan_frames = min(n_frames, 85)
    frames = arr[: scan_frames * hop].reshape(scan_frames, hop)
    rms_vals = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))

    anchor_start = -1
    valley_start = -1
    for f in range(scan_frames):
        rms = float(rms_vals[f])
        if anchor_start == -1:
            if f < 55 and rms > 0.02:
                anchor_start = f
            continue
        if f < anchor_start + 8:
            continue
        if rms < 0.012:
            if valley_start == -1:
                valley_start = f
            continue
        if valley_start != -1 and (f - valley_start) >= 7:
            cut_frame = max(valley_start + 2, f - 3)
            return arr[min(arr.size, cut_frame * hop):]
        valley_start = -1

    if valley_start != -1 and (scan_frames - valley_start) >= 7:
        return arr[min(arr.size, (valley_start + 2) * hop):]
    return arr


def _apply_fade_in_float32(arr, sr: int, fade_sec: float = 0.005):
    """Apply linear fade-in ramp over the first ``fade_sec`` seconds."""
    import numpy as np

    if arr.size == 0:
        return arr
    fade_len = min(arr.size, int(round(int(sr or 24000) * fade_sec)))
    if fade_len <= 1:
        return arr
    out = np.array(arr, dtype=np.float32, copy=True)
    out[:fade_len] *= np.linspace(0.0, 1.0, fade_len, endpoint=False, dtype=np.float32)
    return out


def _build_atempo_filter(speed: float) -> str:
    """Build chained ffmpeg ``atempo`` filter expression (each factor in [0.5, 2.0])."""
    s = max(0.5, min(3.0, float(speed)))
    filters = []
    while s > 2.0 + 1e-6:
        filters.append("atempo=2.0")
        s /= 2.0
    while s < 0.5 - 1e-6:
        filters.append("atempo=0.5")
        s /= 0.5
    filters.append(f"atempo={s:.6f}".rstrip("0").rstrip("."))
    return ",".join(filters)


def _stretch_speed_float32(arr, sr: int, speed: float):
    """Time-stretch float32 waveform without pitch shift via ffmpeg ``atempo``."""
    import numpy as np

    if arr.size == 0 or abs(float(speed) - 1.0) < 0.001 or not shutil.which("ffmpeg"):
        return arr
    eff_sr = int(sr or 24000)
    af = _build_atempo_filter(float(speed))
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "f32le",
                "-ar",
                str(eff_sr),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-af",
                af,
                "-f",
                "f32le",
                "-ar",
                str(eff_sr),
                "-ac",
                "1",
                "pipe:1",
            ],
            input=np.asarray(arr, dtype="<f4").tobytes(),
            capture_output=True,
            check=True,
        )
        out = np.frombuffer(proc.stdout, dtype="<f4").copy()
        return out if out.size > 0 else arr
    except Exception as exc:
        log.warning("ffmpeg atempo speed stretch failed (speed=%.2f): %s", speed, exc)
        return arr


def _render_batch_to_pcm16(
    wavs,
    src_sr: int,
    target_sr: int,
    speed: float = 1.0,
    trim_anchor: bool = True,
    inter_seg_sec: float = 0.03,
    oai=None,
) -> bytes:
    """Clean, trim anchor prefix, fade-in, time-stretch, resample, and stitch a batch into s16le PCM."""
    import numpy as np

    eff_src_sr = int(src_sr or 24000)
    eff_target_sr = int(target_sr or 24000)
    eff_speed = max(0.5, min(3.0, float(speed or 1.0)))

    processed = []
    for wav in wavs or ():
        if wav is None:
            continue
        arr = np.asarray(wav, dtype=np.float32).reshape(-1)
        if arr.size == 0:
            continue
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0).clip(-1.0, 1.0)
        if trim_anchor:
            arr = _trim_anchor_float32(arr, eff_src_sr)
            if arr.size == 0:
                continue
        arr = _apply_fade_in_float32(arr, eff_src_sr, 0.005)
        processed.append(arr)

    if not processed:
        return b""

    if abs(eff_speed - 1.0) >= 0.001:
        gap_samples = max(0, int(round(eff_src_sr * inter_seg_sec * eff_speed)))
        if len(processed) == 1 or gap_samples == 0:
            joined = np.concatenate(processed) if len(processed) > 1 else processed[0]
        else:
            gap = np.zeros(gap_samples, dtype=np.float32)
            parts = []
            for idx, seg in enumerate(processed):
                if idx > 0:
                    parts.append(gap)
                parts.append(seg)
            joined = np.concatenate(parts)
        stretched = _stretch_speed_float32(joined, eff_src_sr, eff_speed)
        resampled = _resample_float32(stretched, eff_src_sr, eff_target_sr)
        return _float32_to_pcm16_bytes(resampled, oai)

    gap_bytes = b"\x00\x00" * max(0, int(round(eff_target_sr * inter_seg_sec)))
    chunks = []
    for idx, seg in enumerate(processed):
        if idx > 0 and gap_bytes:
            chunks.append(gap_bytes)
        resampled = _resample_float32(seg, eff_src_sr, eff_target_sr)
        chunks.append(_float32_to_pcm16_bytes(resampled, oai))
    return b"".join(chunks)


def _detect_opus_encoder() -> str:
    """Return available OGG/Opus encoder: ``soundfile``, ``ffmpeg``, or ``none``."""
    try:
        import soundfile as sf

        subtypes = sf.available_subtypes("OGG")
        if isinstance(subtypes, dict) and "OPUS" in subtypes:
            return "soundfile"
    except Exception:
        pass
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    return "none"


def _wav_to_opus_bytes(wav, src_sr: int, encoder: str) -> bytes:
    """Encode 1D float32 waveform into OGG/Opus container bytes (~6-8x smaller than PCM)."""
    import numpy as np

    arr = np.asarray(wav, dtype=np.float32).reshape(-1)
    if arr.size == 0:
        return b""
    arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0).clip(-1.0, 1.0)
    enc_sr = src_sr if src_sr in (8000, 12000, 16000, 24000, 48000) else 48000
    arr = _resample_float32(arr, src_sr, enc_sr)

    if encoder == "soundfile":
        import soundfile as sf

        buf = io.BytesIO()
        try:
            sf.write(buf, arr, enc_sr, format="OGG", subtype="OPUS", compression_level=0.8)
        except TypeError:
            buf = io.BytesIO()
            sf.write(buf, arr, enc_sr, format="OGG", subtype="OPUS")
        return buf.getvalue()

    if encoder == "ffmpeg":
        proc = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "f32le",
                "-ar",
                str(enc_sr),
                "-ac",
                "1",
                "-i",
                "pipe:0",
                "-c:a",
                "libopus",
                "-b:a",
                "56k",
                "-vbr",
                "on",
                "-f",
                "ogg",
                "pipe:1",
            ],
            input=arr.astype("<f4").tobytes(),
            capture_output=True,
            check=True,
        )
        return proc.stdout

    raise RuntimeError("No OGG/Opus encoder available")


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


class DriveExportManager:
    """Manage staged batch PCM chunks on local SSD and assemble final audio directly to Google Drive."""

    _SUPPORTED_FORMATS = ("wav", "mp3", "m4a")
    _STREAM_READ_BYTES = 1024 * 1024

    def __init__(
        self,
        export_dir: Path,
        display_dir: str = "",
        default_format: str = "wav",
        staging_root: Optional[Path] = None,
    ) -> None:
        self.export_dir = Path(export_dir)
        self.export_dir.mkdir(parents=True, exist_ok=True)
        self.display_dir = str(display_dir or self.export_dir)
        fmt = str(default_format or "wav").strip().lower()
        self.default_format = fmt if fmt in self._SUPPORTED_FORMATS else "wav"
        self.staging_root = Path(
            staging_root or os.environ.get("VIENEU_EXPORT_STAGING_DIR", "/content/stv_exports")
        )
        self.staging_root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._sessions: dict[str, dict] = {}

    @staticmethod
    def _sanitize_id(raw: str) -> str:
        cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(raw or "").strip())[:64].strip("_")
        return cleaned or f"exp_{uuid.uuid4().hex[:12]}"

    @classmethod
    def _normalize_format(cls, raw_fmt: Optional[str], fallback: str = "wav") -> str:
        fmt = str(raw_fmt or fallback).strip().lower()
        return fmt if fmt in cls._SUPPORTED_FORMATS else fallback

    @staticmethod
    def _sanitize_filename(filename: Optional[str], fallback_stem: str, ext: str) -> str:
        raw_name = os.path.basename(str(filename or "").strip())
        stem = os.path.splitext(raw_name)[0] if raw_name else fallback_stem
        safe_stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", stem).strip(" .")
        if not safe_stem:
            safe_stem = fallback_stem
        return f"{safe_stem[:140]}.{ext}"

    @staticmethod
    def _dedup_target_path(directory: Path, filename: str) -> Path:
        candidate = directory / filename
        if not candidate.exists():
            return candidate
        stem, ext = os.path.splitext(filename)
        idx = 2
        while True:
            alt = directory / f"{stem} ({idx}){ext}"
            if not alt.exists():
                return alt
            idx += 1

    def _evict_stale_sessions(self, ttl_sec: float = 7200.0) -> None:
        now = time.monotonic()
        stale_ids = [
            sid
            for sid, sess in self._sessions.items()
            if (now - float(sess.get("updated_at", now))) > ttl_sec
        ]
        for sid in stale_ids:
            sess = self._sessions.pop(sid, None)
            if sess and sess.get("staging_dir"):
                shutil.rmtree(sess["staging_dir"], ignore_errors=True)

    @staticmethod
    def _plan_stitch_layout(batches: dict, sr: int) -> Tuple[List[dict], bytes, bytes, int, int]:
        inter_batch_samples = max(0, int(round(sr * 0.03)))
        inter_chap_samples = max(0, int(round(sr * 0.8)))
        inter_batch_silence = b"\x00\x00" * inter_batch_samples
        inter_chap_silence = b"\x00\x00" * inter_chap_samples

        ordered: List[dict] = []
        total_pcm_bytes = 0
        prev_chap: Optional[int] = None
        chapters_seen = set()
        for key in sorted(batches.keys()):
            entry = batches[key]
            chunk_bytes = int(entry.get("bytes", 0))
            if chunk_bytes <= 0:
                continue
            chap_idx = int(key[0])
            chapters_seen.add(chap_idx)
            if prev_chap is not None:
                gap = inter_batch_silence if chap_idx == prev_chap else inter_chap_silence
                total_pcm_bytes += len(gap)
            total_pcm_bytes += chunk_bytes
            ordered.append({"chap": chap_idx, "path": entry["path"], "bytes": chunk_bytes})
            prev_chap = chap_idx
        return ordered, inter_batch_silence, inter_chap_silence, total_pcm_bytes, len(chapters_seen)

    @classmethod
    def _iter_stitched_pcm(
        cls,
        ordered: List[dict],
        inter_batch_silence: bytes,
        inter_chap_silence: bytes,
    ):
        prev_chap: Optional[int] = None
        for entry in ordered:
            chap_idx = entry["chap"]
            if prev_chap is not None:
                gap = inter_batch_silence if chap_idx == prev_chap else inter_chap_silence
                if gap:
                    yield gap
            with open(entry["path"], "rb") as f:
                while True:
                    buf = f.read(cls._STREAM_READ_BYTES)
                    if not buf:
                        break
                    yield buf
            prev_chap = chap_idx

    @classmethod
    def _write_wav_from_stitched_pcm(
        cls,
        out_path: Path,
        sample_rate: int,
        total_pcm_bytes: int,
        ordered: List[dict],
        inter_batch_silence: bytes,
        inter_chap_silence: bytes,
    ) -> None:
        header = struct.pack(
            "<4sI4s4sIHHIIHH4sI",
            b"RIFF",
            36 + total_pcm_bytes,
            b"WAVE",
            b"fmt ",
            16,
            1,
            1,
            sample_rate,
            sample_rate * 2,
            2,
            16,
            b"data",
            total_pcm_bytes,
        )
        with open(out_path, "wb") as out_f:
            out_f.write(header)
            for chunk in cls._iter_stitched_pcm(ordered, inter_batch_silence, inter_chap_silence):
                out_f.write(chunk)

    @classmethod
    def _encode_ffmpeg_from_stitched_pcm(
        cls,
        out_path: Path,
        fmt: str,
        sample_rate: int,
        ordered: List[dict],
        inter_batch_silence: bytes,
        inter_chap_silence: bytes,
        err_log_path: Path,
    ) -> bool:
        if not shutil.which("ffmpeg"):
            return False
        codec_args = (
            ["-c:a", "libmp3lame", "-b:a", "128k"]
            if fmt == "mp3"
            else ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"]
        )
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            "-i",
            "pipe:0",
            *codec_args,
            str(out_path),
        ]
        try:
            with open(err_log_path, "wb") as err_f:
                proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=err_f)
                assert proc.stdin is not None
                for chunk in cls._iter_stitched_pcm(ordered, inter_batch_silence, inter_chap_silence):
                    proc.stdin.write(chunk)
                proc.stdin.close()
                rc = proc.wait()
            return rc == 0 and out_path.is_file() and out_path.stat().st_size > 0
        except Exception as exc:
            log.warning("ffmpeg %s encode failed, falling back to wav: %s", fmt, exc)
            return False

    def start_session(
        self,
        session_id: str,
        sample_rate: int = 24000,
        speed: float = 1.0,
        output_format: Optional[str] = None,
        title_hint: str = "",
    ) -> dict:
        sid = self._sanitize_id(session_id)
        sr = int(sample_rate) if int(sample_rate or 24000) in (8000, 16000, 24000, 48000) else 24000
        eff_speed = max(0.5, min(3.0, float(speed or 1.0)))
        fmt = self._normalize_format(output_format, self.default_format)
        staging_dir = self.staging_root / sid

        with self._lock:
            self._evict_stale_sessions()
            old = self._sessions.pop(sid, None)
            if old and old.get("staging_dir"):
                shutil.rmtree(old["staging_dir"], ignore_errors=True)
            if staging_dir.exists():
                shutil.rmtree(staging_dir, ignore_errors=True)
            staging_dir.mkdir(parents=True, exist_ok=True)
            self._sessions[sid] = {
                "session_id": sid,
                "sample_rate": sr,
                "speed": eff_speed,
                "output_format": fmt,
                "title_hint": str(title_hint or ""),
                "staging_dir": staging_dir,
                "batches": {},
                "updated_at": time.monotonic(),
            }

        return {
            "ok": True,
            "session_id": sid,
            "sample_rate": sr,
            "output_format": fmt,
            "drive_dir": self.display_dir,
        }

    def write_batch(
        self,
        session_id: str,
        chapter_index: int,
        batch_index: int,
        pcm_bytes: bytes,
        item_count: int = 0,
    ) -> dict:
        sid = self._sanitize_id(session_id)
        chap_i = max(1, int(chapter_index))
        batch_i = max(0, int(batch_index))

        with self._lock:
            sess = self._sessions.get(sid)
            if sess is None:
                raise KeyError(f"Unknown export session: {sid}")
            staging_dir: Path = sess["staging_dir"]
            sr = int(sess["sample_rate"])
            chunk_path = staging_dir / f"c{chap_i:04d}_b{batch_i:04d}.pcm"
            tmp_path = staging_dir / f"c{chap_i:04d}_b{batch_i:04d}.pcm.tmp"

        with open(tmp_path, "wb") as f:
            f.write(pcm_bytes)
        os.replace(tmp_path, chunk_path)

        batch_samples = len(pcm_bytes) // 2
        with self._lock:
            sess = self._sessions.get(sid)
            if sess is None:
                raise KeyError(f"Unknown export session: {sid}")
            sess["batches"][(chap_i, batch_i)] = {
                "path": chunk_path,
                "bytes": len(pcm_bytes),
                "samples": batch_samples,
                "items": int(item_count),
            }
            sess["updated_at"] = time.monotonic()
            _, _, _, total_pcm_bytes, chap_count = self._plan_stitch_layout(sess["batches"], sr)

        total_samples = total_pcm_bytes // 2
        return {
            "session_id": sid,
            "batch_audio_sec": round(batch_samples / float(sr), 3),
            "total_audio_sec": round(total_samples / float(sr), 3),
            "total_samples": total_samples,
            "chapters_count": chap_count,
        }

    def finalize_session(
        self,
        session_id: str,
        filename: Optional[str] = None,
        chapters: Optional[int] = None,
        output_format: Optional[str] = None,
    ) -> dict:
        sid = self._sanitize_id(session_id)
        with self._lock:
            sess = self._sessions.get(sid)
            if sess is None:
                raise KeyError(f"Unknown export session: {sid}")
            sr = int(sess["sample_rate"])
            staging_dir: Path = sess["staging_dir"]
            batches_snapshot = dict(sess["batches"])
            sess_fmt = sess["output_format"]
            sess["updated_at"] = time.monotonic()

        ordered, inter_batch_silence, inter_chap_silence, total_pcm_bytes, detected_chaps = (
            self._plan_stitch_layout(batches_snapshot, sr)
        )
        if total_pcm_bytes <= 0 or not ordered:
            self.abort_session(sid)
            raise ValueError("No audio data recorded in export session")

        total_sec = (total_pcm_bytes // 2) / float(sr)
        chap_count = max(1, int(chapters)) if (chapters is not None and int(chapters) > 0) else max(1, detected_chaps)
        requested_fmt = self._normalize_format(output_format, sess_fmt)
        actual_fmt = requested_fmt
        if actual_fmt in ("mp3", "m4a") and not shutil.which("ffmpeg"):
            actual_fmt = "wav"

        fallback_stem = f"stv-audio-{max(1, round(total_sec / 60.0))}p-{chap_count}ch"
        self.export_dir.mkdir(parents=True, exist_ok=True)
        safe_name = self._sanitize_filename(filename, fallback_stem, actual_fmt)
        target_path = self._dedup_target_path(self.export_dir, safe_name)
        local_out = staging_dir / target_path.name

        try:
            encoded_ok = False
            if actual_fmt in ("mp3", "m4a"):
                encoded_ok = self._encode_ffmpeg_from_stitched_pcm(
                    local_out,
                    actual_fmt,
                    sr,
                    ordered,
                    inter_batch_silence,
                    inter_chap_silence,
                    staging_dir / "ffmpeg.log",
                )
                if not encoded_ok:
                    actual_fmt = "wav"
                    safe_name = self._sanitize_filename(filename, fallback_stem, "wav")
                    target_path = self._dedup_target_path(self.export_dir, safe_name)
                    local_out = staging_dir / target_path.name

            if actual_fmt == "wav":
                self._write_wav_from_stitched_pcm(
                    local_out,
                    sr,
                    total_pcm_bytes,
                    ordered,
                    inter_batch_silence,
                    inter_chap_silence,
                )

            tmp_drive = target_path.parent / f".{target_path.name}.{sid}.tmp"
            try:
                shutil.copyfile(local_out, tmp_drive)
                os.replace(tmp_drive, target_path)
            finally:
                if tmp_drive.exists():
                    try:
                        tmp_drive.unlink()
                    except OSError:
                        pass

            byte_length = target_path.stat().st_size
            drive_display_path = (
                f"{self.display_dir.rstrip('/')}/{target_path.name}"
                if self.display_dir
                else str(target_path)
            )
            log.info(
                "💾 DRIVE saved: path=%s size=%.2fMB audio=%.1fs chapters=%d format=%s",
                drive_display_path,
                byte_length / (1024.0 * 1024.0),
                total_sec,
                chap_count,
                actual_fmt,
            )
            return {
                "ok": True,
                "session_id": sid,
                "filename": target_path.name,
                "drive_path": drive_display_path,
                "format": actual_fmt,
                "audio_sec": round(total_sec, 2),
                "chapters": chap_count,
                "byte_length": byte_length,
            }
        finally:
            with self._lock:
                self._sessions.pop(sid, None)
            shutil.rmtree(staging_dir, ignore_errors=True)

    def abort_session(self, session_id: str) -> dict:
        sid = self._sanitize_id(session_id)
        with self._lock:
            sess = self._sessions.pop(sid, None)
        staging_dir = sess.get("staging_dir") if sess else (self.staging_root / sid)
        if staging_dir:
            shutil.rmtree(staging_dir, ignore_errors=True)
        return {"ok": True, "session_id": sid}


def create_drive_export_manager_from_env() -> Optional[DriveExportManager]:
    """Create a ``DriveExportManager`` when ``VIENEU_DRIVE_EXPORT_DIR`` is configured."""
    raw_dir = str(os.environ.get("VIENEU_DRIVE_EXPORT_DIR", "") or "").strip()
    if not raw_dir:
        return None
    try:
        return DriveExportManager(
            export_dir=Path(raw_dir),
            display_dir=str(os.environ.get("VIENEU_DRIVE_EXPORT_DISPLAY", "") or raw_dir).strip(),
            default_format=str(os.environ.get("VIENEU_DRIVE_EXPORT_FORMAT", "wav") or "wav").strip().lower(),
        )
    except Exception as exc:
        log.warning("Drive export disabled (failed to initialize %s): %s", raw_dir, exc)
        return None


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
    drive_exporter: Optional[DriveExportManager] = None,
) -> None:
    from fastapi import Depends, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse, StreamingResponse
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
                "X-Batch-Codec",
                "X-Sample-Rate",
            ],
        )

    # Bind into module globals so FastAPI resolves annotations under `from __future__ import annotations`.
    global ColabWorkerModeRequest, ColabBatchSpeechRequest, ColabDriveExportStartRequest, ColabDriveExportBatchRequest, ColabDriveExportFinalizeRequest, ColabDriveExportAbortRequest

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
        audio_format: str = "pcm"
        temperature: float = Field(0.4, ge=0.0, le=2.0, allow_inf_nan=False)
        top_k: int = Field(12, ge=1, le=1024)
        top_p: float = Field(0.85, gt=0.0, le=1.0, allow_inf_nan=False)
        repetition_penalty: float = Field(1.05, ge=1.0, le=2.0, allow_inf_nan=False)
        max_chars: int = Field(380, ge=64, le=512)
        batch_size: Optional[int] = Field(default=None, ge=1, le=64)

    class ColabDriveExportStartRequest(BaseModel):
        session_id: str = Field(min_length=1, max_length=128)
        sample_rate: int = 24000
        speed: float = Field(1.0, ge=0.5, le=3.0, allow_inf_nan=False)
        output_format: Optional[str] = None
        title_hint: Optional[str] = ""

    class ColabDriveExportBatchRequest(BaseModel):
        session_id: str = Field(min_length=1, max_length=128)
        chapter_index: int = Field(1, ge=1, le=10000)
        batch_index: int = Field(0, ge=0, le=10000)
        inputs: List[str] = Field(min_length=1, max_length=64)
        voice: Optional[str] = None
        sample_rate: int = 24000
        speed: float = Field(1.0, ge=0.5, le=3.0, allow_inf_nan=False)
        trim_anchor: bool = True
        temperature: float = Field(0.4, ge=0.0, le=2.0, allow_inf_nan=False)
        top_k: int = Field(12, ge=1, le=1024)
        top_p: float = Field(0.85, gt=0.0, le=1.0, allow_inf_nan=False)
        repetition_penalty: float = Field(1.05, ge=1.0, le=2.0, allow_inf_nan=False)
        max_chars: int = Field(380, ge=64, le=512)
        batch_size: Optional[int] = Field(default=None, ge=1, le=64)

    class ColabDriveExportFinalizeRequest(BaseModel):
        session_id: str = Field(min_length=1, max_length=128)
        filename: Optional[str] = None
        chapters: Optional[int] = Field(default=None, ge=1, le=10000)
        output_format: Optional[str] = None

    class ColabDriveExportAbortRequest(BaseModel):
        session_id: str = Field(min_length=1, max_length=128)

    oai.app.router.routes = [
        r
        for r in oai.app.router.routes
        if getattr(r, "path", None) not in (
            "/health",
            "/v1/workers/mode",
            "/v1/audio/batch",
            "/v1/export/start",
            "/v1/export/batch",
            "/v1/export/finalize",
            "/v1/export/abort",
        )
    ]

    active_leases: dict[str, float] = {}
    lease_lock = threading.Lock()
    batch_lock = threading.Lock()
    batch_stats = {"total_batches": 0, "total_audio_sec": 0.0, "last_speedup": 0.0}
    opus_encoder = _detect_opus_encoder()

    def _run_tts_batch_texts(req_obj) -> Tuple[List[int], dict[int, object], int, int, int]:
        if req_obj.sample_rate not in (48000, 24000, 16000, 8000):
            raise HTTPException(400, "sample_rate must be one of (48000, 24000, 16000, 8000)")
        tts = getattr(eng, "tts", None)
        if tts is None:
            raise HTTPException(503, "speech engine not ready")
        if req_obj.voice and hasattr(tts, "resolve_voice_name") and tts.resolve_voice_name(req_obj.voice) is None:
            raise HTTPException(400, f"unknown voice '{req_obj.voice}'; see GET /v1/voices")

        non_empty_indices: List[int] = []
        non_empty_texts: List[str] = []
        for idx, raw_text in enumerate(req_obj.inputs):
            txt = str(raw_text or "").strip()
            if txt:
                non_empty_indices.append(idx)
                non_empty_texts.append(txt)

        effective_bs = max(1, min(batch_cap, int(req_obj.batch_size or batch_cap)))
        src_sr = int(getattr(tts, "sample_rate", getattr(oai, "SAMPLE_RATE", 48000)) or 48000)
        wavs_by_index: dict[int, object] = {}
        total_src_samples = 0
        if non_empty_texts:
            with batch_lock:
                if hasattr(tts, "infer_batch"):
                    wavs = tts.infer_batch(
                        non_empty_texts,
                        voice=req_obj.voice or None,
                        apply_watermark=getattr(eng, "watermark", False),
                        temperature=req_obj.temperature,
                        top_k=req_obj.top_k,
                        top_p=req_obj.top_p,
                        repetition_penalty=req_obj.repetition_penalty,
                        max_chars=req_obj.max_chars,
                        batch_size=effective_bs,
                    )
                else:
                    wavs = [
                        tts.infer(
                            t,
                            voice=req_obj.voice or None,
                            apply_watermark=getattr(eng, "watermark", False),
                            temperature=req_obj.temperature,
                            top_k=req_obj.top_k,
                            top_p=req_obj.top_p,
                            repetition_penalty=req_obj.repetition_penalty,
                            max_chars=req_obj.max_chars,
                        )
                        for t in non_empty_texts
                    ]
            for idx, w in zip(non_empty_indices, wavs):
                wavs_by_index[idx] = w
                if w is not None:
                    total_src_samples += len(w)
        return non_empty_indices, wavs_by_index, total_src_samples, effective_bs, src_sr

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
            "batch_codecs": (["opus", "pcm"] if opus_encoder != "none" else ["pcm"]),
            "drive_export_supported": bool(drive_exporter is not None),
            "drive_export_dir": (drive_exporter.display_dir if drive_exporter is not None else ""),
            "drive_export_format": (drive_exporter.default_format if drive_exporter is not None else ""),
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
        t0 = time.perf_counter()
        _, wavs_by_index, total_src_samples, effective_bs, src_sr = _run_tts_batch_texts(req)

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

        use_opus = str(req.audio_format or "pcm").strip().lower() == "opus" and opus_encoder != "none"
        stvb_version = 2 if use_opus else 1
        codec_label = "opus" if use_opus else "pcm"
        wire_sr = 48000 if use_opus else req.sample_rate

        def _stream_stvb():
            t_stream = time.perf_counter()
            total_bytes = 16
            yield b"STVB" + struct.pack("<III", stvb_version, wire_sr, len(req.inputs))
            for idx in range(len(req.inputs)):
                if idx in wavs_by_index:
                    if use_opus:
                        item_bytes = _wav_to_opus_bytes(wavs_by_index[idx], src_sr, opus_encoder)
                    else:
                        item_bytes = _wav_to_pcm16_bytes(wavs_by_index[idx], src_sr, req.sample_rate, oai)
                else:
                    item_bytes = b""
                total_bytes += 4 + len(item_bytes)
                yield struct.pack("<I", len(item_bytes))
                if item_bytes:
                    yield item_bytes
            log.info(
                "📦 BATCH sent: items=%d codec=%s size=%.2fMB stream=%.2fs",
                len(req.inputs),
                codec_label,
                total_bytes / (1024.0 * 1024.0),
                time.perf_counter() - t_stream,
            )

        return StreamingResponse(
            _stream_stvb(),
            media_type="application/octet-stream",
            headers={
                "X-Sample-Rate": str(req.sample_rate),
                "X-Batch-Audio-Sec": f"{audio_sec:.2f}",
                "X-Batch-Wall-Sec": f"{wall_sec:.2f}",
                "X-Batch-Speedup": f"{speedup:.1f}",
                "X-Batch-Dtype": actual_dtype,
                "X-Batch-Codec": codec_label,
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

    @oai.app.post("/v1/export/start", dependencies=[Depends(oai._auth)])
    def drive_export_start(req: ColabDriveExportStartRequest):
        if drive_exporter is None:
            raise HTTPException(503, "Google Drive export is not enabled on this Colab runtime")
        return drive_exporter.start_session(
            req.session_id,
            sample_rate=req.sample_rate,
            speed=req.speed,
            output_format=req.output_format,
            title_hint=req.title_hint or "",
        )

    @oai.app.post("/v1/export/batch", dependencies=[Depends(oai._auth)])
    def drive_export_batch(req: ColabDriveExportBatchRequest):
        if drive_exporter is None:
            raise HTTPException(503, "Google Drive export is not enabled on this Colab runtime")
        t0 = time.perf_counter()
        _, wavs_by_index, total_src_samples, effective_bs, src_sr = _run_tts_batch_texts(req)
        ordered_wavs = [wavs_by_index.get(idx) for idx in range(len(req.inputs))]
        pcm_bytes = _render_batch_to_pcm16(
            ordered_wavs,
            src_sr,
            req.sample_rate,
            speed=req.speed,
            trim_anchor=req.trim_anchor,
            oai=oai,
        )
        try:
            write_res = drive_exporter.write_batch(
                req.session_id,
                req.chapter_index,
                req.batch_index,
                pcm_bytes,
                item_count=len(req.inputs),
            )
        except KeyError as exc:
            raise HTTPException(404, str(exc))

        raw_audio_sec = total_src_samples / float(src_sr or 48000)
        wall_sec = max(1e-3, time.perf_counter() - t0)
        speedup = raw_audio_sec / wall_sec
        actual_dtype = _detect_model_dtype_label(eng, model_dtype)
        batch_stats["total_batches"] += 1
        batch_stats["total_audio_sec"] += write_res["batch_audio_sec"]
        batch_stats["last_speedup"] = speedup
        log.info(
            "⚡ BATCH done: items=%d bs=%d audio=%.1fs wall=%.2fs speed=%.1fx dtype=%s (drive)",
            len(req.inputs),
            effective_bs,
            write_res["batch_audio_sec"],
            wall_sec,
            speedup,
            actual_dtype,
        )
        return {
            "ok": True,
            "session_id": write_res.get("session_id", req.session_id),
            "chapter_index": req.chapter_index,
            "batch_index": req.batch_index,
            "items": len(req.inputs),
            "audio_sec": write_res["batch_audio_sec"],
            "total_audio_sec": write_res["total_audio_sec"],
            "wall_sec": round(wall_sec, 2),
            "speedup": round(speedup, 1),
            "dtype": actual_dtype,
        }

    @oai.app.post("/v1/export/finalize", dependencies=[Depends(oai._auth)])
    def drive_export_finalize(req: ColabDriveExportFinalizeRequest):
        if drive_exporter is None:
            raise HTTPException(503, "Google Drive export is not enabled on this Colab runtime")
        try:
            return drive_exporter.finalize_session(
                req.session_id,
                filename=req.filename,
                chapters=req.chapters,
                output_format=req.output_format,
            )
        except KeyError as exc:
            raise HTTPException(404, str(exc))
        except ValueError as exc:
            raise HTTPException(400, str(exc))

    @oai.app.post("/v1/export/abort", dependencies=[Depends(oai._auth)])
    def drive_export_abort(req: ColabDriveExportAbortRequest):
        if drive_exporter is None:
            return {"ok": True, "session_id": req.session_id}
        return drive_exporter.abort_session(req.session_id)


def configure_colab_server() -> None:
    import apps.openai_speech as oai

    gpu_name, vram_gb = detect_cuda_gpu()
    requested_tier = os.environ.get("VIENEU_COLAB_GPU_TIER", "auto")
    gpu_tier, listen_streams, export_cap = resolve_tier_limits(requested_tier, vram_gb, gpu_name)
    batch_cap = resolve_batch_limit(gpu_tier)
    requested_dtype = _patch_cuda_dtype_for_colab()
    drive_exporter = create_drive_export_manager_from_env()

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
        drive_exporter=drive_exporter,
    )

    log.info(
        "VieNeu Colab GPU Server ready: gpu=%s tier=%s vram=%.2fGB dtype=%s batch=%d listen=%d export_max=%d backend=%s drive_export=%s",
        gpu_name,
        gpu_tier,
        vram_gb,
        actual_dtype,
        batch_cap,
        listen_streams,
        export_cap,
        getattr(eng, "backend", "unknown"),
        (drive_exporter.display_dir if drive_exporter is not None else "disabled"),
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(name)s: %(message)s")
    import apps.openai_speech as oai

    configure_colab_server()
    oai.main()


if __name__ == "__main__":
    main()
