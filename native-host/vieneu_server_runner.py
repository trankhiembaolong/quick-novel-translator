"""
Multi-worker CPU + Dual-Process AMD DirectML ONNX runner for VieNeu-TTS server.

Because ONNX Runtime's DirectML execution provider uses process-local D3D12
synchronization that serializes/crashes if two threads run DML concurrently inside
one process, AMD GPU 2-stream mode runs:
- Worker 0: In-process DML-Hybrid (GPU prefill + decode_step + codec_full; CPU acoustic)
- Worker 1: Isolated child process DML-Hybrid (`--dml-worker-subprocess`) with its
            own D3D12 device/command queue on the AMD Radeon RX 6550M
- Worker 2: In-process primary CPU worker running on DDR5 RAM in parallel

Together all 3 workers share read-only concepts smoothly and push both RX 6550M
compute utilization and Ryzen CPU cores to full throughput at lossless FP32 quality.
"""
from __future__ import annotations

import atexit
import json
import logging
import os
import pickle
import queue
import struct
import subprocess
import sys
import threading
from pathlib import Path
from typing import Optional, Tuple

log = logging.getLogger("vieneu.runner")
_tls = threading.local()

_MIN_DISCRETE_VRAM_BYTES = 1_000_000_000  # 1 GB threshold for auto-enabling DML hybrid
_SUBPROC_READY_MAGIC = b"RDY!"


def detect_amd_dml_device_id(require_discrete: bool = False) -> Optional[Tuple[int, str, int]]:
    """Return ``(dxgi_device_id, adapter_name, dedicated_vram_bytes)`` for the best GPU.

    Uses Windows DXGI ``IDXGIFactory1::EnumAdapters1`` so the discrete GPU (e.g. AMD
    Radeon RX 6550M at index 1) is chosen rather than defaulting to index 0 (iGPU).
    Returns ``None`` if no suitable hardware adapter is found or not on Windows.
    """
    if sys.platform != "win32":
        return None
    try:
        import ctypes
        from ctypes import wintypes
        import uuid

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

        iid = GUID.from_buffer_copy(uuid.UUID("770aae78-f26f-4dba-a829-253c83d1b387").bytes_le)
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
    """Pre-transpose contiguous head weights & step index arrays for faster frame sampling."""
    if getattr(eng, "_fast_sampling_patched", False):
        return
    import numpy as np

    eng._audio_emb_T = [np.ascontiguousarray(eng.audio_emb[ch].T) for ch in range(eng.n_vq)]
    eng._text_emb_T = np.ascontiguousarray(eng.text_emb.T)
    eng._ac_pos_init = np.array([[0, 1]], dtype=np.int64)
    eng._ac_pos_steps = [np.array([[ch + 1]], dtype=np.int64) for ch in range(eng.n_vq)]
    eng._ac_empty_past_tmpl = eng._empty_past()

    def _fast_acoustic_frame(h, temperature, top_k, top_p, rep_pen, hist):
        hidden_dim = eng.hidden
        tok = np.empty((1, 2, hidden_dim), dtype=np.float32)
        tok[0, 0] = h[0]
        tok[0, 1] = eng.text_emb[eng.sgs]
        feed = {"token_emb": tok, "position_ids": eng._ac_pos_init}
        feed.update(eng._ac_empty_past_tmpl)
        out = eng.sess_ac.run(None, feed)
        hidden = out[0]
        pk, pv = eng._split_past(out, eng.L_loc)
        slot0 = hidden[0, 0]

        def _sample_channel(ch: int, vec: np.ndarray) -> int:
            logits = np.asarray(vec, dtype=np.float32) @ eng._audio_emb_T[ch]
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

        text_logits = np.asarray(slot0, dtype=np.float32) @ eng._text_emb_T
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
    if enable_dml:
        # Required by DirectML when tensor dimensions (prompt length T, KV length P) vary per step
        so.enable_mem_pattern = False
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    else:
        so.add_session_config_entry("session.intra_op.allow_spinning", "0")
        so.intra_op_num_threads = intra_threads
    return so


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
) -> None:
    so_cpu = _new_session_options(ort, intra_threads, enable_dml=False)
    w._so = so_cpu
    w.ort_intra_op_threads = intra_threads
    cpu_prov = ["CPUExecutionProvider"]

    if dml_device_id is not None:
        so_dml = _new_session_options(ort, intra_threads, enable_dml=True)
        dml_prov = [("DmlExecutionProvider", {"device_id": int(dml_device_id)}), "CPUExecutionProvider"]
        w.sess_pre = ort.InferenceSession(str(vd / "vieneu_prefill.onnx"), so_dml, providers=dml_prov)
        w.sess_dec = ort.InferenceSession(str(vd / "vieneu_decode_step.onnx"), so_dml, providers=dml_prov)
        w.sess_ac = ort.InferenceSession(str(vd / "vieneu_acoustic_cached.onnx"), so_cpu, providers=cpu_prov)
        # Keep MOSS codec decoder on CPU: DirectML ConvTranspose exhibits 400Hz/2.8kHz stride harmonics
        w.sess_codec_dec = ort.InferenceSession(
            str(cd / "moss_audio_tokenizer_decode_full.onnx"), so_cpu, providers=cpu_prov
        )
    else:
        w.sess_pre = ort.InferenceSession(str(vd / "vieneu_prefill.onnx"), so_cpu, providers=cpu_prov)
        w.sess_dec = ort.InferenceSession(str(vd / "vieneu_decode_step.onnx"), so_cpu, providers=cpu_prov)
        w.sess_ac = ort.InferenceSession(str(vd / "vieneu_acoustic_cached.onnx"), so_cpu, providers=cpu_prov)
        w.sess_codec_dec = ort.InferenceSession(
            str(cd / "moss_audio_tokenizer_decode_full.onnx"), so_cpu, providers=cpu_prov
        )

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
    """Isolated DML GPU worker process (own D3D12 device/command queue on RX 6550M)."""
    # Preserve binary stdout pipe for IPC frames and route library prints to stderr
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
    w.checkpoint_path = os.environ.get("VIENEU_SUBPROC_CKPT", "pnnbao-ump/VieNeu-TTS-v3-Turbo")
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
        self.babble_retries = getattr(primary, "babble_retries", 0)
        self.sample_rate = getattr(primary, "sample_rate", 48_000)

        env = os.environ.copy()
        env["VIENEU_DML_DEVICE_ID"] = str(dev_id)
        env["VIENEU_DML_CPU_THREADS"] = str(cpu_threads)
        env["VIENEU_SUBPROC_VD"] = str(vd)
        env["VIENEU_SUBPROC_CD"] = str(cd)
        env["VIENEU_SUBPROC_CKPT"] = str(primary.checkpoint_path)

        creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
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

        magic = _read_exact(self._proc.stdout, len(_SUBPROC_READY_MAGIC))
        if magic != _SUBPROC_READY_MAGIC:
            rc = self._proc.poll()
            self.close()
            raise RuntimeError(f"DML subprocess handshake failed (rc={rc}, got={magic!r})")

    def infer(self, *args, **kwargs):
        import numpy as np

        data = pickle.dumps((args, kwargs), protocol=pickle.HIGHEST_PROTOCOL)
        with self._lock:
            if self._proc.poll() is not None:
                raise RuntimeError(f"DML subprocess exited unexpectedly (rc={self._proc.returncode})")
            self._proc.stdin.write(struct.pack("<I", len(data)))
            self._proc.stdin.write(data)
            self._proc.stdin.flush()

            hdr = _read_exact(self._proc.stdout, 5)
            if not hdr:
                raise RuntimeError("DML subprocess closed pipe before replying")
            status, payload_len = struct.unpack("<BI", hdr)
            payload = _read_exact(self._proc.stdout, payload_len) if payload_len > 0 else b""
            if payload is None:
                raise RuntimeError("Truncated response from DML subprocess")
            if status != 0:
                raise RuntimeError(payload.decode("utf-8", errors="replace"))
            return np.frombuffer(payload, dtype="<f4").copy()

    def infer_stream(self, *args, **kwargs):
        yield self.infer(*args, **kwargs)

    def close(self) -> None:
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
            if proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=3)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


class OnnxEnginePool:
    """Thread-safe pool of OnnxV3LiteEngine / SubprocessDmlWorker workers."""

    def __init__(self, primary, pool_size: int, workers: Optional[list] = None):
        import onnxruntime as ort
        import tokenizers

        _patch_fast_sampling(primary)
        self._primary = primary

        if workers is not None:
            self._workers = workers
        else:
            precision = os.environ.get("VIENEU_PRECISION", "fp32").lower()
            onnx_subfolder = {"int8": "onnx_int8", "fp32": "onnx_update"}.get(precision, "onnx_update")
            self._workers = [primary]
            for idx in range(1, pool_size):
                try:
                    worker = _clone_onnx_worker(primary, ort, tokenizers, onnx_subfolder)
                    self._workers.append(worker)
                except Exception as exc:
                    log.warning("Could not initialize ONNX worker #%d: %s", idx + 1, exc)
                    break

        self._pool: queue.Queue = queue.Queue()
        for w in self._workers:
            self._pool.put(w)
        self._size = len(self._workers)

    @property
    def size(self) -> int:
        return self._size

    def __getattr__(self, name: str):
        return getattr(self._primary, name)

    def _set_babble_retries(self, value: int) -> None:
        for w in self._workers:
            w.babble_retries = value

    def _acquire_worker(self, need_streaming: bool):
        if not need_streaming or all(isinstance(w, SubprocessDmlWorker) for w in self._workers):
            return self._pool.get()
        skipped = []
        try:
            while True:
                w = self._pool.get()
                if not isinstance(w, SubprocessDmlWorker):
                    return w
                skipped.append(w)
        finally:
            for sw in skipped:
                self._pool.put(sw)

    def infer(self, *args, **kwargs):
        w = self._pool.get()
        try:
            return w.infer(*args, **kwargs)
        finally:
            self._pool.put(w)

    def infer_stream(self, *args, **kwargs):
        is_fast = bool(getattr(_tls, "fast_decode", False))
        w = self._acquire_worker(need_streaming=not is_fast)
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
            self._pool.put(w)

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


def _install_amd_gpu_hybrid_pool(eng, primary, dml_info: Tuple[int, str, int], requested_streams: int) -> bool:
    """Build multi-process GPU+CPU pool: [in-proc GPU, subproc GPU #2, primary CPU]."""
    import onnxruntime as ort
    import tokenizers

    dev_id, dev_name, dev_vram = dml_info
    vd, cd = _resolve_onnx_dirs(primary, "onnx_update")
    dml_cpu_threads = 3

    try:
        dml_worker = _clone_onnx_worker(
            primary,
            ort,
            tokenizers,
            "onnx_update",
            dml_device_id=dev_id,
            cpu_threads_override=dml_cpu_threads,
            include_codec_step=True,
        )
        voice_data = eng.tts.get_preset_voice(None)
        if voice_data:
            _ = dml_worker.infer(
                text="Xin chào.",
                ref_codes=voice_data.get("codes"),
                speaker_emb=voice_data.get("speaker_emb"),
            )
    except Exception as exc:
        log.warning("AMD DirectML GPU init failed (%s); falling back to CPU FP32.", exc)
        return False

    workers = [dml_worker]

    # Spawn a second isolated DirectML GPU process when requested_streams >= 2 and VRAM allows (>= 2.5 GB)
    subproc_gpu = None
    if requested_streams >= 2 and dev_vram >= 2_500_000_000:
        try:
            subproc_gpu = SubprocessDmlWorker(primary, dev_id, vd, cd, cpu_threads=dml_cpu_threads)
            if voice_data:
                _ = subproc_gpu.infer(
                    text="Xin chào.",
                    ref_codes=voice_data.get("codes"),
                    speaker_emb=voice_data.get("speaker_emb"),
                )
            workers.append(subproc_gpu)
        except Exception as exc:
            log.warning("Secondary GPU subprocess init failed (%s); continuing with 1 GPU + CPU.", exc)
            if subproc_gpu is not None:
                subproc_gpu.close()

    # Add CPU primary worker in parallel on independent DDR5 bus when requested_streams >= 3 (or fallback if no GPU #2)
    if len(workers) < requested_streams:
        workers.append(primary)

    pool = OnnxEnginePool(primary, len(workers), workers=workers)
    eng.tts.engine = pool
    eng.max_streams = pool.size
    eng._gate = threading.BoundedSemaphore(pool.size)
    eng.max_queue = max(pool.size * 4, int(os.environ.get("VIENEU_QUEUE", "16")))
    gpu_workers = 1 + (1 if subproc_gpu is not None and subproc_gpu in workers else 0)
    cpu_workers = pool.size - gpu_workers
    log.info(
        "AMD DirectML hybrid ready: gpu=%s (device_id=%d, vram=%.2f GB) workers=%d (%d GPU + %d CPU) queue=%d",
        dev_name,
        dev_id,
        dev_vram / 1e9,
        pool.size,
        gpu_workers,
        cpu_workers,
        eng.max_queue,
    )
    return True


def _configure_pool() -> None:
    import apps.openai_speech as oai

    eng = oai.engine()
    if eng.backend != "onnx":
        return

    import onnxruntime as ort

    primary = eng.tts.engine
    _patch_fast_sampling(primary)
    _wrap_fast_stream(eng)

    precision = os.environ.get("VIENEU_PRECISION", "fp32").lower()
    cpu_threads = os.cpu_count() or 4

    if precision in ("amd_gpu", "auto") and "DmlExecutionProvider" in ort.get_available_providers():
        dml_info = detect_amd_dml_device_id(require_discrete=(precision == "auto"))
        if dml_info is not None:
            try:
                req_streams = max(1, min(3, int(os.environ.get("VIENEU_MAX_STREAMS", "3"))))
            except ValueError:
                req_streams = 3
            if _install_amd_gpu_hybrid_pool(eng, primary, dml_info, req_streams):
                return

    default_pool = 2 if (precision == "int8" and cpu_threads >= 8) else 1
    try:
        if precision == "auto":
            target_pool = 1
        else:
            target_pool = max(1, min(4, int(os.environ.get("VIENEU_MAX_STREAMS", default_pool))))
    except ValueError:
        target_pool = default_pool

    if target_pool > 1:
        pool = OnnxEnginePool(primary, target_pool)
        eng.tts.engine = pool
        eng.max_streams = pool.size
        eng._gate = threading.BoundedSemaphore(pool.size)
        eng.max_queue = max(pool.size * 4, int(os.environ.get("VIENEU_QUEUE", "16")))
        log.info(
            "ONNX multi-worker pool ready: workers=%d intra_op_threads=%d queue=%d",
            pool.size,
            getattr(pool, "ort_intra_op_threads", 0),
            eng.max_queue,
        )
    else:
        eng.max_streams = 1
        eng._gate = threading.BoundedSemaphore(1)
        orig_single_stream = primary.infer_stream

        def single_fast_stream(*args, **kwargs):
            if getattr(_tls, "fast_decode", False):
                orig_retries = getattr(primary, "babble_retries", 0)
                primary.babble_retries = 0
                try:
                    yield primary.infer(*args, **kwargs)
                finally:
                    primary.babble_retries = orig_retries
            else:
                yield from orig_single_stream(*args, **kwargs)

        primary.infer_stream = single_fast_stream


def main() -> None:
    if "--dml-worker-subprocess" in sys.argv:
        _run_dml_subprocess_worker()
        return

    import apps.openai_speech as oai

    _configure_pool()
    oai.main()


if __name__ == "__main__":
    main()
