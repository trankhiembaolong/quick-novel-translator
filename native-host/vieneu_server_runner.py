"""
Dynamic 1-worker (web listening) <-> 3-worker (WAV export) DirectML + CPU ONNX runner
for VieNeu-TTS server.

- Normal web listening starts and stays at 1 worker (discrete AMD DirectML GPU when
  available, otherwise tuned CPU FP32/INT8) with single-thread BLAS/OMP and non-spinning
  ONNX Runtime thread pools so browser playback stays smooth and RAM/CPU stay low.
- During offline WAV export (`POST /v1/workers/mode` with `mode="export"`), the pool
  scales up on demand to up to 3 workers:
  - Worker 0: In-process DML-Hybrid (GPU prefill + decode_step + codec_full; CPU acoustic)
  - Worker 1: Isolated child process DML-Hybrid (`--dml-worker-subprocess`)
  - Worker 2: In-process CPU worker running in parallel
- When export finishes, cancels, or its lease expires, extra workers are retired and
  disposed immediately to reclaim RAM/VRAM.
"""
from __future__ import annotations

import os

for _env_key in (
    "OPENBLAS_NUM_THREADS",
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
    "NUMEXPR_NUM_THREADS",
):
    os.environ.setdefault(_env_key, "1")

import atexit
import gc
import json
import logging
import pickle
import struct
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Tuple

log = logging.getLogger("vieneu.runner")
_tls = threading.local()

_MIN_DISCRETE_VRAM_BYTES = 1_000_000_000  # 1 GB threshold for auto-enabling DML hybrid
_SUBPROC_READY_MAGIC = b"RDY!"
_DEFAULT_EXPORT_LEASE_TTL_SEC = 120.0

_V3_REPO = "pnnbao-ump/VieNeu-TTS-v3-Turbo"
_CODEC_REPO = "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX"
_GRAPH_FILES = (
    "vieneu_prefill.onnx",
    "vieneu_decode_step.onnx",
    "vieneu_acoustic_cached.onnx",
    "vieneu_backbone_shared.data",
    "vieneu_v3_heads.npz",
    "config.json",
    "tokenizer.json",
)
_CODEC_FILES = (
    "moss_audio_tokenizer_decode_full.onnx",
    "moss_audio_tokenizer_decode_shared.data",
    "moss_audio_tokenizer_decode_step.onnx",
    "codec_browser_onnx_meta.json",
    "moss_audio_tokenizer_encode.onnx",
    "moss_audio_tokenizer_encode.data",
)


def _enable_offline_hf_if_cached(precision: str) -> bool:
    """Enable `HF_HUB_OFFLINE=1` if all required ONNX artifacts are already cached locally."""
    if os.environ.get("VIENEU_ONNX_DIR") or "HF_HUB_OFFLINE" in os.environ:
        return False
    try:
        from huggingface_hub import hf_hub_download

        onnx_subfolder = "onnx_int8" if str(precision).lower() == "int8" else "onnx_update"
        hf_hub_download(_V3_REPO, "config.json", repo_type="model", local_files_only=True)
        for fn in _GRAPH_FILES:
            hf_hub_download(
                _V3_REPO,
                fn,
                repo_type="model",
                subfolder=onnx_subfolder,
                local_files_only=True,
            )
        for fn in _CODEC_FILES:
            hf_hub_download(_CODEC_REPO, fn, repo_type="model", local_files_only=True)
        os.environ["HF_HUB_OFFLINE"] = "1"
        log.info("Local HF cache verified (%s); enabled HF_HUB_OFFLINE=1 for fast startup.", onnx_subfolder)
        return True
    except Exception:
        return False


def detect_amd_dml_device_id(require_discrete: bool = False) -> Optional[Tuple[int, str, int]]:
    """Return ``(dxgi_device_id, adapter_name, dedicated_vram_bytes)`` for the best GPU.

    Uses Windows DXGI ``IDXGIFactory1::EnumAdapters1`` so the discrete GPU (e.g. AMD
    Radeon RX 6550M) is chosen rather than defaulting blindly to index 0.
    Returns ``None`` if no suitable hardware adapter is found or not on Windows.
    """
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes
        import uuid as _uuid

        class LUID(ctypes.Structure):
            _fields_ = [("LowPart", wintypes.DWORD), ("HighPart", wintypes.LONG)]

        class DXGI_ADAPTER_DESC1(ctypes.Structure):
            _fields_ = [
                ("Description", wintypes.WCHAR * 128),
                ("VendorId", wintypes.UINT),
                ("DeviceId", wintypes.UINT),
                ("SubSysId", wintypes.UINT),
                ("Revision", wintypes.UINT),
                ("DedicatedVideoMemory", ctypes.c_size_t),
                ("DedicatedSystemMemory", ctypes.c_size_t),
                ("SharedSystemMemory", ctypes.c_size_t),
                ("AdapterLuid", LUID),
                ("Flags", wintypes.UINT),
            ]

        class GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        iid = GUID.from_buffer_copy(_uuid.UUID("770aae78-f26f-4dba-a829-253c83d1b387").bytes_le)
        dxgi = ctypes.windll.dxgi
        factory = ctypes.c_void_p()
        if dxgi.CreateDXGIFactory1(ctypes.byref(iid), ctypes.byref(factory)) != 0:
            return None

        vt_f = ctypes.cast(
            ctypes.cast(factory, ctypes.POINTER(ctypes.c_void_p))[0],
            ctypes.POINTER(ctypes.c_void_p),
        )
        enum_adapters = ctypes.WINFUNCTYPE(
            ctypes.c_long, ctypes.c_void_p, wintypes.UINT, ctypes.POINTER(ctypes.c_void_p)
        )(vt_f[12])
        release_factory = ctypes.WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(vt_f[2])

        best: Optional[Tuple[int, int, str, int]] = None  # (score, idx, name, vram)
        idx = 0
        try:
            while True:
                adp = ctypes.c_void_p()
                if enum_adapters(factory, idx, ctypes.byref(adp)) != 0:
                    break
                vt_a = ctypes.cast(
                    ctypes.cast(adp, ctypes.POINTER(ctypes.c_void_p))[0],
                    ctypes.POINTER(ctypes.c_void_p),
                )
                get_desc = ctypes.WINFUNCTYPE(
                    ctypes.c_long, ctypes.c_void_p, ctypes.POINTER(DXGI_ADAPTER_DESC1)
                )(vt_a[10])
                release_adp = ctypes.WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(vt_a[2])
                desc = DXGI_ADAPTER_DESC1()
                hr_desc = get_desc(adp, ctypes.byref(desc))
                release_adp(adp)

                if hr_desc == 0:
                    name = str(desc.Description).strip()
                    lower = name.lower()
                    is_software = bool(desc.Flags & 2)
                    is_virtual = any(tok in lower for tok in ("virtual", "mumu", "basic render"))
                    vram = int(desc.DedicatedVideoMemory)
                    if not is_software and not is_virtual and vram > 0:
                        score = vram
                        if desc.VendorId == 0x1002 and ("rx " in lower or "radeon rx" in lower):
                            score += 10**12
                        if best is None or score > best[0]:
                            best = (score, idx, name, vram)
                idx += 1
        finally:
            release_factory(factory)

        if best is None:
            return None
        _, dev_id, name, vram = best
        if require_discrete and vram < _MIN_DISCRETE_VRAM_BYTES:
            return None
        return dev_id, name, vram
    except Exception as exc:
        log.debug("DXGI adapter enumeration unavailable: %s", exc)
        return None


def _patch_fast_sampling(eng) -> None:
    """Use zero-copy contiguous C-order head weights & preallocated buffers for acoustic sampling."""
    if getattr(eng, "_fast_sampling_patched", False):
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


def _resolve_onnx_dirs(primary, onnx_subfolder: str) -> Tuple[Path, Path]:
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
                subfolder=onnx_subfolder,
                local_files_only=True,
            )
        ).parent
    cd = Path(primary._codec_enc_path).parent
    return vd, cd


def _new_session_options(ort, intra_threads: int, enable_dml: bool):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.inter_op_num_threads = 1
    so.add_session_config_entry("session.intra_op.allow_spinning", "0")
    so.add_session_config_entry("session.inter_op.allow_spinning", "0")
    so.add_session_config_entry("session.set_denormal_as_zero", "1")
    if enable_dml:
        # Required by DirectML when tensor dimensions (prompt length T, KV length P) vary per step
        so.enable_mem_pattern = False
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.intra_op_num_threads = 1
    else:
        so.intra_op_num_threads = max(1, int(intra_threads))
        try:
            so.add_session_config_entry("memory.enable_memory_arena_shrinkage", "cpu:0")
        except Exception:
            pass
    return so


class _LazyInferenceSession:
    """Lazily create an ONNX Runtime InferenceSession on first use and allow unloading when idle."""

    def __init__(self, session_ctor: Callable[..., object], model_path: str, options_factory: Callable[[], object], providers: list):
        self._session_ctor = session_ctor
        self._model_path = str(model_path)
        self._options_factory = options_factory
        self._providers = providers
        self._lock = threading.Lock()
        self._sess = None

    def _ensure(self):
        with self._lock:
            if self._sess is None:
                self._sess = self._session_ctor(
                    self._model_path,
                    self._options_factory(),
                    providers=self._providers,
                )
            return self._sess

    def run(self, *args, **kwargs):
        return self._ensure().run(*args, **kwargs)

    def get_inputs(self):
        return self._ensure().get_inputs()

    def get_outputs(self):
        return self._ensure().get_outputs()

    def unload(self) -> bool:
        with self._lock:
            if self._sess is None:
                return False
            self._sess = None
            return True

    def __getattr__(self, name: str):
        return getattr(self._ensure(), name)


def _populate_dml_or_cpu_sessions(
    w,
    ort,
    vd: Path,
    cd: Path,
    intra_threads: int,
    dml_device_id: Optional[int],
    include_codec_step: bool,
    has_codec_step: bool,
    codec_stream_spec,
    lazy_full_codec: bool = False,
) -> None:
    so_cpu = _new_session_options(ort, intra_threads, enable_dml=False)
    w._so = so_cpu
    w.ort_intra_op_threads = max(1, int(intra_threads))
    cpu_prov = ["CPUExecutionProvider"]

    if dml_device_id is not None:
        so_dml = _new_session_options(ort, 1, enable_dml=True)
        dml_prov = [("DmlExecutionProvider", {"device_id": int(dml_device_id)}), "CPUExecutionProvider"]
        w.sess_pre = ort.InferenceSession(str(vd / "vieneu_prefill.onnx"), so_dml, providers=dml_prov)
        w.sess_dec = ort.InferenceSession(str(vd / "vieneu_decode_step.onnx"), so_dml, providers=dml_prov)
        w.sess_ac = ort.InferenceSession(str(vd / "vieneu_acoustic_cached.onnx"), so_cpu, providers=cpu_prov)
    else:
        w.sess_pre = ort.InferenceSession(str(vd / "vieneu_prefill.onnx"), so_cpu, providers=cpu_prov)
        w.sess_dec = ort.InferenceSession(str(vd / "vieneu_decode_step.onnx"), so_cpu, providers=cpu_prov)
        w.sess_ac = ort.InferenceSession(str(vd / "vieneu_acoustic_cached.onnx"), so_cpu, providers=cpu_prov)

    # Keep MOSS codec decoder on CPU: DirectML ConvTranspose exhibits stride harmonics.
    codec_full_path = str(cd / "moss_audio_tokenizer_decode_full.onnx")
    if lazy_full_codec:
        w.sess_codec_dec = _LazyInferenceSession(ort.InferenceSession, codec_full_path, lambda: so_cpu, cpu_prov)
    else:
        w.sess_codec_dec = ort.InferenceSession(codec_full_path, so_cpu, providers=cpu_prov)

    w._codec_stream_spec = codec_stream_spec
    if include_codec_step and has_codec_step and codec_stream_spec is not None:
        w.sess_codec_step = ort.InferenceSession(
            str(cd / "moss_audio_tokenizer_decode_step.onnx"), so_cpu, providers=cpu_prov
        )
        w._codec_step_out_names = [o.name for o in w.sess_codec_step.get_outputs()]
    else:
        w.sess_codec_step = None


def _clone_onnx_worker(
    primary,
    ort,
    tokenizers_mod,
    onnx_subfolder: str,
    dml_device_id: Optional[int] = None,
    cpu_threads_override: Optional[int] = None,
    include_codec_step: bool = True,
    lazy_full_codec: bool = False,
):
    """Create another OnnxV3LiteEngine worker sharing read-only NumPy tables."""
    from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine

    vd, cd = _resolve_onnx_dirs(primary, onnx_subfolder)

    w = object.__new__(OnnxV3LiteEngine)
    w._lock = threading.RLock()
    w.device = primary.device
    w.checkpoint_path = primary.checkpoint_path
    w.cfg = primary.cfg
    w.n_vq = primary.n_vq
    w.hidden = primary.hidden
    w.L = primary.L
    w.L_loc = primary.L_loc
    w.nH_loc = primary.nH_loc
    w.hd_loc = primary.hd_loc
    w.audio_pad = primary.audio_pad
    w.tps = primary.tps
    w.tpe = primary.tpe
    w.sgs = primary.sgs
    w.eos_speech = primary.eos_speech
    w.ref_slot = primary.ref_slot
    w.text_vocab = primary.text_vocab
    w.default_style_id = primary.default_style_id
    w.style_labels = primary.style_labels
    w.use_speaker_embedding = primary.use_speaker_embedding
    w.speaker_embedding_dim = primary.speaker_embedding_dim
    w.speaker_encoder_filename = primary.speaker_encoder_filename

    w.text_emb = primary.text_emb
    w.audio_emb = primary.audio_emb
    if primary.xvec_w is not None:
        w.xvec_w = primary.xvec_w
        w.xvec_b = primary.xvec_b
        w.xvec_ln_w = primary.xvec_ln_w
        w.xvec_ln_b = primary.xvec_ln_b
        w.xvec_ln_eps = primary.xvec_ln_eps
    else:
        w.xvec_w = None

    w.tokenizer = tokenizers_mod.Tokenizer.from_file(str(vd / "tokenizer.json"))
    intra_threads = max(1, int(cpu_threads_override or primary.ort_intra_op_threads))
    _populate_dml_or_cpu_sessions(
        w,
        ort,
        vd,
        cd,
        intra_threads=intra_threads,
        dml_device_id=dml_device_id,
        include_codec_step=include_codec_step,
        has_codec_step=primary.sess_codec_step is not None,
        codec_stream_spec=primary._codec_stream_spec,
        lazy_full_codec=lazy_full_codec,
    )
    w._codec_enc_path = primary._codec_enc_path
    w._sess_codec_enc = None
    w.speaker_encoder = primary.speaker_encoder
    w.denoiser = primary.denoiser
    w.babble_retries = getattr(primary, "babble_retries", 0)
    w.sample_rate = getattr(primary, "sample_rate", 48_000)
    _patch_fast_sampling(w)
    return w


def _read_exact(stream, n: int) -> Optional[bytes]:
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def _run_dml_subprocess_worker() -> None:
    """Isolated DML GPU worker process (own D3D12 device/command queue on discrete AMD GPU)."""
    stdout_fd = os.dup(1)
    try:
        os.dup2(2, 1)
    except OSError:
        devnull_fd = os.open(os.devnull, os.O_WRONLY)
        os.dup2(devnull_fd, 1)
        os.close(devnull_fd)
    if sys.platform == "win32":
        import msvcrt

        msvcrt.setmode(0, os.O_BINARY)
        msvcrt.setmode(stdout_fd, os.O_BINARY)
    ipc_out = os.fdopen(stdout_fd, "wb", buffering=0)
    ipc_in = os.fdopen(0, "rb", buffering=0)

    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer
    from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine, _Dev

    vd = Path(os.environ["VIENEU_SUBPROC_VD"])
    cd = Path(os.environ["VIENEU_SUBPROC_CD"])
    dev_id = int(os.environ.get("VIENEU_DML_DEVICE_ID", "0"))
    intra_threads = max(1, int(os.environ.get("VIENEU_DML_CPU_THREADS", "2")))

    c = json.loads((vd / "config.json").read_text(encoding="utf-8"))
    z = np.load(vd / "vieneu_v3_heads.npz")

    w = object.__new__(OnnxV3LiteEngine)
    w._lock = threading.RLock()
    w.device = _Dev()
    w.checkpoint_path = os.environ.get("VIENEU_SUBPROC_CKPT", _V3_REPO)
    w.cfg = c
    w.n_vq = int(c["n_vq"])
    w.hidden = int(c["hidden_size"])
    w.L = int(c["num_hidden_layers"])
    w.L_loc = int(c.get("local_num_hidden_layers", 1))
    w.nH_loc = int(c.get("local_num_attention_heads", 8))
    w.hd_loc = w.hidden // w.nH_loc
    w.audio_pad = int(c["audio_pad_token_id"])
    w.tps = int(c["text_prompt_start_token_id"])
    w.tpe = int(c["text_prompt_end_token_id"])
    w.sgs = int(c["speech_generation_start_token_id"])
    w.eos_speech = int(c["speech_generation_end_token_id"])
    w.ref_slot = int(c["audio_ref_slot_token_id"])
    w.text_vocab = int(c["text_vocab_size"])
    w.default_style_id = int(c.get("default_style_token_id", 16))
    w.style_labels = dict(c.get("style_labels", {}))
    w.use_speaker_embedding = bool(c.get("use_speaker_embedding", False))
    w.speaker_embedding_dim = int(c.get("speaker_embedding_dim", 192))
    w.speaker_encoder_filename = c.get("speaker_encoder_filename", "speaker_encoder.onnx")
    w.text_emb = z["text_emb"].astype(np.float32)
    w.audio_emb = z["audio_emb"].astype(np.float32)
    if w.use_speaker_embedding and "xvec_w" in z:
        w.xvec_w = z["xvec_w"].astype(np.float32)
        w.xvec_b = z["xvec_b"].astype(np.float32)
        w.xvec_ln_w = z["xvec_ln_w"].astype(np.float32)
        w.xvec_ln_b = z["xvec_ln_b"].astype(np.float32)
        w.xvec_ln_eps = float(z["xvec_ln_eps"])
    else:
        w.xvec_w = None

    w.tokenizer = Tokenizer.from_file(str(vd / "tokenizer.json"))
    _populate_dml_or_cpu_sessions(
        w,
        ort,
        vd,
        cd,
        intra_threads=intra_threads,
        dml_device_id=dev_id,
        include_codec_step=False,
        has_codec_step=False,
        codec_stream_spec=None,
    )
    w._codec_enc_path = str(cd / "moss_audio_tokenizer_encode.onnx")
    w._sess_codec_enc = None
    w.speaker_encoder = None
    w.denoiser = None
    w.babble_retries = 0
    w.sample_rate = 48_000
    _patch_fast_sampling(w)

    ipc_out.write(_SUBPROC_READY_MAGIC)
    ipc_out.flush()

    while True:
        hdr = _read_exact(ipc_in, 4)
        if not hdr:
            break
        (req_len,) = struct.unpack("<I", hdr)
        payload = _read_exact(ipc_in, req_len)
        if not payload:
            break
        try:
            args, kwargs = pickle.loads(payload)
            wav = w.infer(*args, **kwargs)
            raw = np.asarray(wav, dtype="<f4").tobytes()
            ipc_out.write(struct.pack("<BI", 0, len(raw)))
            ipc_out.write(raw)
        except Exception as exc:
            err_bytes = f"{type(exc).__name__}: {exc}".encode("utf-8", errors="replace")
            ipc_out.write(struct.pack("<BI", 1, len(err_bytes)))
            ipc_out.write(err_bytes)
        ipc_out.flush()


class SubprocessDmlWorker:
    """Proxy for an isolated child process running OnnxV3LiteEngine with DirectML."""

    def __init__(self, primary, dev_id: int, vd: Path, cd: Path, cpu_threads: int = 2):
        self._lock = threading.Lock()
        self._atexit_registered = False
        self.babble_retries = getattr(primary, "babble_retries", 0)
        self.sample_rate = getattr(primary, "sample_rate", 48_000)

        env = os.environ.copy()
        for k in (
            "OPENBLAS_NUM_THREADS",
            "OMP_NUM_THREADS",
            "MKL_NUM_THREADS",
            "VECLIB_MAXIMUM_THREADS",
            "NUMEXPR_NUM_THREADS",
        ):
            env[k] = "1"
        env["HF_HUB_OFFLINE"] = "1"
        env["VIENEU_DML_DEVICE_ID"] = str(dev_id)
        env["VIENEU_DML_CPU_THREADS"] = str(max(1, int(cpu_threads)))
        env["VIENEU_SUBPROC_VD"] = str(vd)
        env["VIENEU_SUBPROC_CD"] = str(cd)
        env["VIENEU_SUBPROC_CKPT"] = str(primary.checkpoint_path)

        creation_flags = 0
        if sys.platform == "win32":
            creation_flags = (
                getattr(subprocess, "CREATE_NO_WINDOW", 0)
                | getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0x00004000)
            )
        py_exec = Path(sys.executable)
        py_console = py_exec.with_name("python.exe")
        exe = str(py_console if (sys.platform == "win32" and py_console.exists()) else py_exec)

        child_stderr = subprocess.DEVNULL
        try:
            if sys.stderr is not None and sys.stderr.fileno() >= 0:
                child_stderr = sys.stderr
        except Exception:
            child_stderr = subprocess.DEVNULL

        self._proc = subprocess.Popen(
            [exe, str(Path(__file__).resolve()), "--dml-worker-subprocess"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=child_stderr,
            env=env,
            creationflags=creation_flags,
        )
        atexit.register(self.close)
        self._atexit_registered = True

        magic = _read_exact(self._proc.stdout, len(_SUBPROC_READY_MAGIC))
        if magic != _SUBPROC_READY_MAGIC:
            rc = self._proc.poll()
            self.close()
            raise RuntimeError(f"DML subprocess handshake failed (rc={rc}, got={magic!r})")

    def infer(self, *args, **kwargs):
        import numpy as np

        data = pickle.dumps((args, kwargs), protocol=pickle.HIGHEST_PROTOCOL)
        with self._lock:
            proc = getattr(self, "_proc", None)
            if proc is None or proc.poll() is not None:
                rc = proc.returncode if proc is not None else None
                raise RuntimeError(f"DML subprocess exited unexpectedly (rc={rc})")
            proc.stdin.write(struct.pack("<I", len(data)))
            proc.stdin.write(data)
            proc.stdin.flush()

            hdr = _read_exact(proc.stdout, 5)
            if not hdr:
                raise RuntimeError("DML subprocess closed pipe before replying")
            status, payload_len = struct.unpack("<BI", hdr)
            payload = _read_exact(proc.stdout, payload_len) if payload_len > 0 else b""
            if payload is None:
                raise RuntimeError("Truncated response from DML subprocess")
            if status != 0:
                raise RuntimeError(payload.decode("utf-8", errors="replace"))
            return np.frombuffer(payload, dtype="<f4").copy()

    def infer_stream(self, *args, **kwargs):
        yield self.infer(*args, **kwargs)

    def close(self) -> None:
        if getattr(self, "_atexit_registered", False):
            try:
                atexit.unregister(self.close)
            except Exception:
                pass
            self._atexit_registered = False

        proc = getattr(self, "_proc", None)
        if proc is None:
            return
        self._proc = None
        try:
            if proc.stdin:
                proc.stdin.close()
        except Exception:
            pass
        try:
            if proc.stdout:
                proc.stdout.close()
        except Exception:
            pass
        try:
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


class ResizableGate:
    """Thread-safe admission gate supporting live concurrency limit scaling (1 <-> 3)."""

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
    kind: str
    is_extra: bool
    streaming_capable: bool
    priority: int
    busy: bool = False
    retired: bool = False


class OnnxEnginePool:
    """Dynamic pool of OnnxV3LiteEngine / SubprocessDmlWorker with 1-worker default and on-demand export scaling."""

    def __init__(
        self,
        primary,
        pool_size: int = 1,
        workers: Optional[list] = None,
        *,
        eng=None,
        dml_info: Optional[Tuple[int, str, int]] = None,
        onnx_subfolder: str = "onnx_update",
        export_capacity: Optional[int] = None,
        subproc_factory: Optional[Callable[[], object]] = None,
        cpu_clone_factory: Optional[Callable[[], object]] = None,
        watchdog_interval_sec: float = 5.0,
    ):
        _patch_fast_sampling(primary)
        self._primary = primary
        self._eng = eng
        self._dml_info = dml_info
        self._onnx_subfolder = onnx_subfolder
        self._subproc_factory = subproc_factory
        self._cpu_clone_factory = cpu_clone_factory

        self._cond = threading.Condition()
        self._scale_lock = threading.Lock()
        self._active_leases: dict[str, float] = {}
        self._closed = False
        self._watchdog_interval = max(0.2, float(watchdog_interval_sec))

        base_kind = "gpu_dml" if dml_info is not None else "cpu"
        self._slots: list[_WorkerSlot] = []

        if workers is not None:
            for idx, w in enumerate(workers):
                is_subproc = isinstance(w, SubprocessDmlWorker)
                self._slots.append(
                    _WorkerSlot(
                        worker=w,
                        kind="subproc_dml" if is_subproc else ("gpu_dml" if idx == 0 and dml_info is not None else "cpu"),
                        is_extra=(idx > 0),
                        streaming_capable=(idx == 0 and not is_subproc),
                        priority=idx,
                    )
                )
        else:
            self._slots.append(
                _WorkerSlot(
                    worker=primary,
                    kind=base_kind,
                    is_extra=False,
                    streaming_capable=True,
                    priority=0,
                )
            )
            if pool_size > 1:
                for idx in range(1, pool_size):
                    try:
                        extra_slot = self._create_extra_slot(idx)
                        if extra_slot is not None:
                            self._slots.append(extra_slot)
                        else:
                            break
                    except Exception as exc:
                        log.warning("Could not initialize ONNX worker #%d: %s", idx + 1, exc)
                        break

        if export_capacity is not None:
            self._export_capacity = max(1, int(export_capacity))
        elif dml_info is not None:
            _, _, dev_vram = dml_info
            self._export_capacity = 3 if dev_vram >= 2_500_000_000 else 2
        else:
            self._export_capacity = max(1, len(self._slots))

        if self._eng is not None:
            self._sync_engine_limits(len(self._slots))

        self._watchdog_stop = threading.Event()
        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop,
            name="vieneu-worker-lease-watchdog",
            daemon=True,
        )
        self._watchdog_thread.start()
        atexit.register(self.close)

    @property
    def size(self) -> int:
        with self._cond:
            return sum(1 for s in self._slots if not s.retired)

    @property
    def export_capacity(self) -> int:
        return self._export_capacity

    @property
    def worker_mode(self) -> str:
        return "export" if self.size > 1 else "listen"

    def __getattr__(self, name: str):
        return getattr(self._primary, name)

    def _set_babble_retries(self, value: int) -> None:
        with self._cond:
            for s in self._slots:
                if not s.retired:
                    s.worker.babble_retries = value

    def _sync_engine_limits(self, active_count: int) -> None:
        if self._eng is None:
            return
        count = max(1, int(active_count))
        self._eng.max_streams = count
        gate = getattr(self._eng, "_gate", None)
        if isinstance(gate, ResizableGate):
            gate.set_limit(count)
        else:
            self._eng._gate = ResizableGate(count)
        self._eng.max_queue = max(count * 4, int(os.environ.get("VIENEU_QUEUE", "16")))

    def _dispose_worker(self, worker) -> None:
        if worker is None or worker is self._primary:
            return
        if hasattr(worker, "close") and callable(worker.close):
            try:
                worker.close()
                return
            except Exception as exc:
                log.debug("Error closing extra worker: %s", exc)
        for attr in ("sess_pre", "sess_dec", "sess_ac", "sess_codec_dec", "sess_codec_step", "tokenizer"):
            if hasattr(worker, attr):
                try:
                    setattr(worker, attr, None)
                except Exception:
                    pass

    def _create_extra_slot(self, slot_index: int) -> Optional[_WorkerSlot]:
        # Slot 1 on discrete AMD GPU (>=2.5GB VRAM): isolated DML child process
        if self._dml_info is not None and slot_index == 1:
            dev_id, _, dev_vram = self._dml_info
            if dev_vram >= 2_500_000_000:
                subproc = None
                try:
                    if self._subproc_factory is not None:
                        subproc = self._subproc_factory()
                    else:
                        vd, cd = _resolve_onnx_dirs(self._primary, self._onnx_subfolder)
                        subproc = SubprocessDmlWorker(self._primary, dev_id, vd, cd, cpu_threads=2)
                        self._warmup_worker(subproc)
                    return _WorkerSlot(
                        worker=subproc,
                        kind="subproc_dml",
                        is_extra=True,
                        streaming_capable=False,
                        priority=1,
                    )
                except Exception as exc:
                    log.warning("Secondary GPU subprocess init failed (%s); falling back to CPU worker.", exc)
                    if subproc is not None:
                        try:
                            subproc.close()
                        except Exception:
                            pass

        # Fallback or Slot 2: parallel in-process CPU ONNX worker
        if self._cpu_clone_factory is not None:
            cpu_worker = self._cpu_clone_factory()
        else:
            import onnxruntime as ort
            import tokenizers

            cpu_threads = 3 if self._dml_info is not None else max(2, getattr(self._primary, "ort_intra_op_threads", 2))
            cpu_worker = _clone_onnx_worker(
                self._primary,
                ort,
                tokenizers,
                self._onnx_subfolder,
                dml_device_id=None,
                cpu_threads_override=cpu_threads,
                include_codec_step=False,
                lazy_full_codec=False,
            )
            self._warmup_worker(cpu_worker)
        return _WorkerSlot(
            worker=cpu_worker,
            kind="cpu",
            is_extra=True,
            streaming_capable=False,
            priority=slot_index,
        )

    def _warmup_worker(self, worker) -> None:
        if self._eng is None or not hasattr(self._eng, "tts"):
            return
        try:
            voice_data = self._eng.tts.get_preset_voice(None)
            if voice_data:
                _ = worker.infer(
                    text="Xin chào.",
                    ref_codes=voice_data.get("codes"),
                    speaker_emb=voice_data.get("speaker_emb"),
                )
        except Exception as exc:
            log.debug("Extra worker warmup skipped/failed: %s", exc)

    def _acquire_slot(self, need_streaming: bool) -> _WorkerSlot:
        with self._cond:
            while True:
                active = [s for s in self._slots if not s.retired]
                candidates = [s for s in active if (not need_streaming or s.streaming_capable)]
                if not candidates and need_streaming:
                    candidates = active
                candidates.sort(key=lambda s: s.priority)
                for s in candidates:
                    if not s.busy:
                        s.busy = True
                        return s
                self._cond.wait()

    def _release_slot(self, slot: _WorkerSlot) -> None:
        to_dispose = None
        with self._cond:
            slot.busy = False
            if slot.retired:
                if slot in self._slots:
                    self._slots.remove(slot)
                to_dispose = slot.worker
            self._cond.notify_all()
        if to_dispose is not None:
            self._dispose_worker(to_dispose)

    def _prune_expired_leases_locked(self, now: float) -> None:
        expired = [k for k, deadline in self._active_leases.items() if deadline <= now]
        for k in expired:
            del self._active_leases[k]

    def _scale_down_to_base_locked(self) -> int:
        to_dispose = []
        with self._cond:
            for s in list(self._slots):
                if s.is_extra:
                    s.retired = True
                    if not s.busy:
                        self._slots.remove(s)
                        to_dispose.append(s.worker)
            active_count = sum(1 for s in self._slots if not s.retired)
            base_idle = not self._slots[0].busy if self._slots else False
            self._cond.notify_all()

        self._sync_engine_limits(active_count)

        for w in to_dispose:
            self._dispose_worker(w)

        if base_idle:
            codec_dec = getattr(self._primary, "sess_codec_dec", None)
            if isinstance(codec_dec, _LazyInferenceSession):
                codec_dec.unload()

        gc.collect()
        log.info("VieNeu workers scaled down to listen mode (active_workers=%d)", active_count)
        return active_count

    def acquire_export_lease(
        self,
        lease_id: Optional[str] = None,
        requested_workers: Optional[int] = None,
        ttl_sec: float = _DEFAULT_EXPORT_LEASE_TTL_SEC,
    ) -> dict:
        lid = str(lease_id or f"exp-{uuid.uuid4().hex[:8]}")
        ttl = max(10.0, min(600.0, float(ttl_sec or _DEFAULT_EXPORT_LEASE_TTL_SEC)))
        target = max(1, min(self._export_capacity, int(requested_workers or self._export_capacity)))

        with self._scale_lock:
            now = time.monotonic()
            self._prune_expired_leases_locked(now)
            self._active_leases[lid] = now + ttl

            with self._cond:
                current_active = [s for s in self._slots if not s.retired]
                next_idx = len(current_active)

            while next_idx < target:
                try:
                    new_slot = self._create_extra_slot(next_idx)
                    if new_slot is None:
                        break
                    with self._cond:
                        self._slots.append(new_slot)
                        self._cond.notify_all()
                    next_idx += 1
                except Exception as exc:
                    log.warning("Could not scale up export worker #%d: %s", next_idx + 1, exc)
                    break

            active_count = self.size
            self._sync_engine_limits(active_count)
            log.info(
                "VieNeu workers scaled for export: active_workers=%d/%d lease=%s",
                active_count,
                self._export_capacity,
                lid,
            )
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
            now = time.monotonic()
            self._prune_expired_leases_locked(now)
            if lease_id is None:
                self._active_leases.clear()
            else:
                self._active_leases.pop(str(lease_id), None)

            if not self._active_leases:
                active_count = self._scale_down_to_base_locked()
            else:
                active_count = self.size
                self._sync_engine_limits(active_count)

            return {
                "ok": True,
                "mode": "export" if active_count > 1 else "listen",
                "max_streams": active_count,
                "active_workers": active_count,
                "export_capacity": self._export_capacity,
            }

    def touch_export_leases(self, ttl_sec: float = _DEFAULT_EXPORT_LEASE_TTL_SEC) -> None:
        if not self._active_leases:
            return
        ttl = max(10.0, min(600.0, float(ttl_sec or _DEFAULT_EXPORT_LEASE_TTL_SEC)))
        with self._scale_lock:
            if not self._active_leases:
                return
            deadline = time.monotonic() + ttl
            for lid in list(self._active_leases.keys()):
                if self._active_leases[lid] < deadline:
                    self._active_leases[lid] = deadline

    def _watchdog_loop(self) -> None:
        while not self._watchdog_stop.wait(self._watchdog_interval):
            if not self._active_leases:
                continue
            with self._scale_lock:
                if not self._active_leases:
                    continue
                self._prune_expired_leases_locked(time.monotonic())
                if not self._active_leases and self.size > 1:
                    self._scale_down_to_base_locked()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._watchdog_stop.set()
        try:
            atexit.unregister(self.close)
        except Exception:
            pass
        with self._scale_lock:
            self._active_leases.clear()
            with self._cond:
                slots = list(self._slots)
                self._slots = [s for s in self._slots if not s.is_extra]
            for s in slots:
                if s.is_extra:
                    self._dispose_worker(s.worker)

    def infer(self, *args, **kwargs):
        slot = self._acquire_slot(need_streaming=False)
        try:
            return slot.worker.infer(*args, **kwargs)
        finally:
            self._release_slot(slot)

    def infer_stream(self, *args, **kwargs):
        is_fast = bool(getattr(_tls, "fast_decode", False))
        if is_fast:
            self.touch_export_leases()
        slot = self._acquire_slot(need_streaming=not is_fast)
        w = slot.worker
        try:
            if is_fast or isinstance(w, SubprocessDmlWorker):
                orig_retries = getattr(w, "babble_retries", 0)
                w.babble_retries = 0
                try:
                    yield w.infer(*args, **kwargs)
                finally:
                    w.babble_retries = orig_retries
            else:
                yield from w.infer_stream(*args, **kwargs)
        finally:
            self._release_slot(slot)

    def prepare_reference(self, *args, **kwargs):
        with self._primary._lock:
            return self._primary.prepare_reference(*args, **kwargs)

    def extract_speaker_emb(self, *args, **kwargs):
        with self._primary._lock:
            return self._primary.extract_speaker_emb(*args, **kwargs)


def _wrap_fast_stream(eng) -> None:
    orig_infer_stream = eng.tts.infer_stream

    def fast_aware_infer_stream(*args, **kwargs):
        is_fast = int(kwargs.get("max_chars", 256) or 256) >= 320
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


def _patch_lazy_denoiser(OnnxV3LiteEngine) -> Callable[[], None]:
    orig_load_denoiser = OnnxV3LiteEngine._load_denoiser
    orig_prepare_ref = OnnxV3LiteEngine.prepare_reference

    def _skip_init_denoiser(self):
        return None

    def _lazy_prepare_reference(self, ref_audio, *, sr=None, denoise=True, use_ref_codes=True, max_seconds=8.0):
        if denoise and getattr(self, "denoiser", None) is None:
            self.denoiser = orig_load_denoiser(self)
        return orig_prepare_ref(
            self,
            ref_audio,
            sr=sr,
            denoise=denoise,
            use_ref_codes=use_ref_codes,
            max_seconds=max_seconds,
        )

    OnnxV3LiteEngine._load_denoiser = _skip_init_denoiser
    if not getattr(orig_prepare_ref, "_stv_lazy_denoiser", False):
        _lazy_prepare_reference._stv_lazy_denoiser = True  # type: ignore[attr-defined]
        OnnxV3LiteEngine.prepare_reference = _lazy_prepare_reference

    def _restore() -> None:
        OnnxV3LiteEngine._load_denoiser = orig_load_denoiser

    return _restore


def _load_engine_with_provider(
    oai,
    ort,
    cpu_threads: int,
    dml_info: Optional[Tuple[int, str, int]],
):
    from vieneu._v3_turbo_engine.onnx_runtime_lite import OnnxV3LiteEngine

    so_cpu = _new_session_options(ort, cpu_threads, enable_dml=False)
    cpu_prov = ["CPUExecutionProvider"]
    if dml_info is not None:
        dev_id = int(dml_info[0])
        so_dml = _new_session_options(ort, 1, enable_dml=True)
        dml_prov = [("DmlExecutionProvider", {"device_id": dev_id}), "CPUExecutionProvider"]
    else:
        so_dml = None
        dml_prov = None

    orig_inference_session = ort.InferenceSession
    restore_denoiser = _patch_lazy_denoiser(OnnxV3LiteEngine)

    def _patched_inference_session(path_or_bytes, sess_options=None, providers=None, **kwargs):
        name = Path(str(path_or_bytes)).name.lower() if isinstance(path_or_bytes, (str, os.PathLike)) else ""
        if name == "moss_audio_tokenizer_decode_full.onnx":
            return _LazyInferenceSession(
                orig_inference_session,
                str(path_or_bytes),
                lambda: so_cpu,
                cpu_prov,
            )
        if dml_prov is not None and name in ("vieneu_prefill.onnx", "vieneu_decode_step.onnx"):
            return orig_inference_session(path_or_bytes, so_dml, providers=dml_prov, **kwargs)
        return orig_inference_session(path_or_bytes, so_cpu, providers=cpu_prov, **kwargs)

    ort.InferenceSession = _patched_inference_session
    try:
        eng = oai.engine()
    finally:
        ort.InferenceSession = orig_inference_session
        restore_denoiser()

    if eng.backend == "onnx":
        primary = eng.tts.engine
        primary._so = so_cpu
        primary.ort_intra_op_threads = max(1, int(cpu_threads))
    return eng


def _register_worker_routes(oai, pool: Optional[OnnxEnginePool]) -> None:
    from fastapi import Depends
    from fastapi.responses import JSONResponse
    from pydantic import BaseModel, Field

    # Bind into module globals so FastAPI resolves the annotation under `from __future__ import annotations`.
    global WorkerModeRequest

    class WorkerModeRequest(BaseModel):
        mode: str = "listen"
        lease_id: Optional[str] = None
        workers: Optional[int] = Field(default=None, ge=1, le=4)
        ttl_sec: float = Field(default=_DEFAULT_EXPORT_LEASE_TTL_SEC, ge=10.0, le=600.0)

    oai.app.router.routes = [
        r
        for r in oai.app.router.routes
        if getattr(r, "path", None) not in ("/health", "/v1/workers/mode")
    ]

    @oai.app.get("/health")
    def health():
        eng = oai.engine()
        active_workers = pool.size if pool is not None else eng.max_streams
        export_cap = pool.export_capacity if pool is not None else eng.max_streams
        body = {
            "status": "ok",
            "backend": eng.backend,
            "max_streams": eng.max_streams,
            "workers": active_workers,
            "worker_mode": "export" if eng.max_streams > 1 else "listen",
            "export_max_streams": export_cap,
            "active": eng.active,
            "waiting": eng.waiting,
            "sample_rate": oai.SAMPLE_RATE,
        }
        err = eng.stream_error()
        if err is not None:
            return JSONResponse(
                {**body, "status": "error", "error": f"stream scheduler is down: {err!r}"},
                status_code=503,
            )
        return body

    @oai.app.post("/v1/workers/mode", dependencies=[Depends(oai._auth)])
    def set_worker_mode(req: WorkerModeRequest):
        eng = oai.engine()
        mode = str(req.mode or "listen").strip().lower()
        if pool is None:
            return {
                "ok": True,
                "mode": "listen",
                "max_streams": eng.max_streams,
                "active_workers": eng.max_streams,
                "export_capacity": eng.max_streams,
            }
        if mode == "export":
            return pool.acquire_export_lease(
                lease_id=req.lease_id,
                requested_workers=req.workers,
                ttl_sec=req.ttl_sec,
            )
        return pool.release_export_lease(lease_id=req.lease_id)


def _configure_pool() -> None:
    import apps.openai_speech as oai

    precision = os.environ.get("VIENEU_PRECISION", "fp32").lower()
    backend_env = os.environ.get("VIENEU_BACKEND", "auto").lower()

    if backend_env != "pytorch":
        _enable_offline_hf_if_cached(precision)

    if backend_env == "pytorch":
        eng = oai.engine()
        _register_worker_routes(oai, None)
        return

    import onnxruntime as ort

    cpu_count = os.cpu_count() or 4
    dml_info: Optional[Tuple[int, str, int]] = None
    if precision in ("amd_gpu", "auto") and "DmlExecutionProvider" in ort.get_available_providers():
        dml_info = detect_amd_dml_device_id(require_discrete=(precision == "auto"))

    dml_cpu_threads = 2
    pure_cpu_threads = max(2, min(4, cpu_count // 2))

    eng = None
    if dml_info is not None:
        try:
            eng = _load_engine_with_provider(oai, ort, dml_cpu_threads, dml_info)
        except Exception as exc:
            log.warning("AMD DirectML GPU init failed (%s); falling back to CPU FP32.", exc)
            oai.ENGINE = None
            dml_info = None

    if eng is None:
        eng = _load_engine_with_provider(oai, ort, pure_cpu_threads, None)

    if eng.backend != "onnx":
        _register_worker_routes(oai, None)
        return

    primary = eng.tts.engine
    _patch_fast_sampling(primary)
    _wrap_fast_stream(eng)

    onnx_subfolder = "onnx_int8" if precision == "int8" else "onnx_update"
    if dml_info is not None:
        default_export = 3 if dml_info[2] >= 2_500_000_000 else 2
        try:
            export_cap = max(
                1,
                min(3, int(os.environ.get("VIENEU_EXPORT_MAX_STREAMS", str(default_export)))),
            )
        except ValueError:
            export_cap = default_export
        default_listen = 1
    else:
        default_export = 2 if (precision == "int8" and cpu_count >= 8) else 1
        try:
            export_cap = max(
                1,
                min(4, int(os.environ.get("VIENEU_EXPORT_MAX_STREAMS", str(default_export)))),
            )
        except ValueError:
            export_cap = default_export
        default_listen = 1

    try:
        listen_streams = max(1, min(4, int(os.environ.get("VIENEU_MAX_STREAMS", str(default_listen)))))
    except ValueError:
        listen_streams = default_listen

    pool = OnnxEnginePool(
        primary,
        pool_size=listen_streams,
        eng=eng,
        dml_info=dml_info,
        onnx_subfolder=onnx_subfolder,
        export_capacity=max(listen_streams, export_cap),
    )
    eng.tts.engine = pool
    eng._gate = ResizableGate(pool.size)
    eng.max_streams = pool.size
    eng.max_queue = max(pool.size * 4, int(os.environ.get("VIENEU_QUEUE", "16")))
    _register_worker_routes(oai, pool)

    if dml_info is not None:
        dev_id, dev_name, dev_vram = dml_info
        log.info(
            "AMD DirectML listen mode ready: gpu=%s (device_id=%d, vram=%.2f GB) workers=%d export_capacity=%d queue=%d",
            dev_name,
            dev_id,
            dev_vram / 1e9,
            pool.size,
            pool.export_capacity,
            eng.max_queue,
        )
    else:
        log.info(
            "ONNX CPU listen mode ready: workers=%d intra_op_threads=%d export_capacity=%d queue=%d",
            pool.size,
            getattr(primary, "ort_intra_op_threads", pure_cpu_threads),
            pool.export_capacity,
            eng.max_queue,
        )


def main() -> None:
    if "--dml-worker-subprocess" in sys.argv:
        _run_dml_subprocess_worker()
        return

    import apps.openai_speech as oai

    _configure_pool()
    oai.main()


if __name__ == "__main__":
    main()
