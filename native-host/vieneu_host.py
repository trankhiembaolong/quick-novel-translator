"""
Native Messaging Host cho Quick Novel Translator (STV) - Quan ly VieNeu-TTS Server chay ngam.
"""
import ctypes
import json
import os
import socket
import struct
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

def _resolve_vieneu_dir():
    env_dir = os.environ.get("VIENEU_TTS_DIR") or os.environ.get("VIENEU_PATH")
    if env_dir:
        return Path(env_dir)
    cfg_file = Path(__file__).with_name("vieneu_config.json")
    if cfg_file.exists():
        try:
            data = json.loads(cfg_file.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("vieneu_dir"):
                configured = Path(data["vieneu_dir"])
                if (configured / ".venv" / "Scripts" / "python.exe").exists():
                    return configured
        except Exception:
            pass

    # Tìm các vị trí cài đặt phổ biến trước khi rơi về đường dẫn mặc định.
    home = Path(os.path.expanduser("~"))
    candidates = [
        home / "vieneu-tts",
        home / "VieNeu-TTS",
        home / "Documents" / "vieneu-tts",
        home / "Documents" / "VieNeu-TTS",
        home / "Downloads" / "vieneu-tts",
        home / "Downloads" / "VieNeu-TTS",
        home / "Desktop" / "vieneu-tts",
        home / "Desktop" / "VieNeu-TTS",
    ]
    for candidate in candidates:
        if (candidate / ".venv" / "Scripts" / "python.exe").exists():
            return candidate
    return home / "vieneu-tts"


VIENEU_DIR = _resolve_vieneu_dir()
VIENEU_PYTHONW = VIENEU_DIR / ".venv" / "Scripts" / "pythonw.exe"
VIENEU_PYTHON = VIENEU_DIR / ".venv" / "Scripts" / "python.exe"
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))) / "STV-VieNeu"
PID_FILE = STATE_DIR / "vieneu_server.pid"
LOG_FILE = STATE_DIR / "vieneu_server.log"

STILL_ACTIVE = 259
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def read_native_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length or len(raw_length) < 4:
        return None
    msg_length = struct.unpack("<I", raw_length)[0]
    raw_msg = sys.stdin.buffer.read(msg_length)
    if not raw_msg:
        return None
    return json.loads(raw_msg.decode("utf-8"))


def send_native_message(payload):
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def is_pid_running(pid: int) -> bool:
    if not pid or pid <= 0:
        return False
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return False
    try:
        exit_code = ctypes.c_ulong()
        if kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return exit_code.value == STILL_ACTIVE
        return False
    finally:
        kernel32.CloseHandle(handle)


def is_port_open(port: int, host: str = "127.0.0.1") -> bool:
    try:
        with socket.create_connection((host, int(port)), timeout=0.35):
            return True
    except OSError:
        return False


def get_health(port: int, host: str = "127.0.0.1") -> dict | None:
    try:
        with urllib.request.urlopen(f"http://{host}:{int(port)}/health", timeout=0.6) as resp:
            if resp.status == 200:
                return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
    return None


def read_saved_pid() -> int | None:
    if not PID_FILE.exists():
        return None
    try:
        return int(PID_FILE.read_text(encoding="utf-8").strip())
    except (ValueError, OSError):
        return None


def clear_pid():
    try:
        if PID_FILE.exists():
            PID_FILE.unlink()
    except OSError:
        pass


def get_status(port: int) -> dict:
    pid = read_saved_pid()
    pid_alive = is_pid_running(pid) if pid else False
    if pid and not pid_alive:
        clear_pid()
        pid = None
    port_open = is_port_open(port)
    python_found = bool(VIENEU_PYTHONW.exists() or VIENEU_PYTHON.exists())
    return {
        "ok": True,
        "running": bool(pid_alive or port_open),
        "managed": bool(pid_alive),
        "pid": pid,
        "portOpen": port_open,
        "port": port,
        "vieneuDir": str(VIENEU_DIR),
        "pythonFound": python_found,
        "logFile": str(LOG_FILE),
    }


def start_server(port: int, backend: str = "auto") -> dict:
    python_exe = VIENEU_PYTHONW if VIENEU_PYTHONW.exists() else VIENEU_PYTHON
    if not python_exe.exists():
        return {
            "ok": False,
            "error": f"Khong tim thay Python cua VieNeu tai: {python_exe}. Hay dat VIENEU_TTS_DIR hoac chay install_host.bat / setup_vieneu.bat de cau hinh dung thu muc vieneu-tts.",
        }

    status = get_status(port)
    if status["running"]:
        return {**status, "alreadyRunning": True}

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["HOST"] = "127.0.0.1"
    env["PORT"] = str(port)
    if backend == "onnx_int8":
        env["VIENEU_BACKEND"] = "onnx"
        env["VIENEU_PRECISION"] = "int8"
        env["VIENEU_MAX_STREAMS"] = "2"
    elif backend == "amd_gpu":
        env["VIENEU_BACKEND"] = "onnx"
        env["VIENEU_PRECISION"] = "amd_gpu"
        env["VIENEU_MAX_STREAMS"] = "3"
    elif backend in ("cpu_fp32", "onnx"):
        env["VIENEU_BACKEND"] = "onnx"
        env["VIENEU_PRECISION"] = "fp32"
        env["VIENEU_MAX_STREAMS"] = "1"
    elif backend == "pytorch":
        env["VIENEU_BACKEND"] = "pytorch"
        env["VIENEU_PRECISION"] = "fp32"
        env["VIENEU_MAX_STREAMS"] = "1"
    else:
        env["VIENEU_BACKEND"] = "auto"
        env["VIENEU_PRECISION"] = "auto"
        env["VIENEU_MAX_STREAMS"] = "3"
    env["VIENEU_WATERMARK"] = "0"
    env["VIENEU_QUEUE"] = "16"
    env["VIENEU_QUEUE_TIMEOUT"] = "60"
    env["HF_HUB_DISABLE_TELEMETRY"] = "1"

    runner_path = Path(__file__).with_name("vieneu_server_runner.py")
    cmd = [str(python_exe), str(runner_path)] if runner_path.exists() else [str(python_exe), "-m", "apps.openai_speech"]

    # Dung CREATE_NO_WINDOW (khong gop chung voi DETACHED_PROCESS) + pythonw.exe + SW_HIDE
    # de tranh Windows 11 tu dong mo cua so Windows Terminal cho uv trampoline.
    creation_flags = (
        subprocess.CREATE_NO_WINDOW
        | subprocess.CREATE_NEW_PROCESS_GROUP
        | getattr(subprocess, "ABOVE_NORMAL_PRIORITY_CLASS", 0x00008000)
    )
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 0  # SW_HIDE

    with open(LOG_FILE, "w", encoding="utf-8") as log_fp:
        proc = subprocess.Popen(
            cmd,
            cwd=str(VIENEU_DIR),
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
            startupinfo=startupinfo,
            close_fds=True,
        )

    PID_FILE.write_text(str(proc.pid), encoding="utf-8")
    return {
        "ok": True,
        "running": True,
        "managed": True,
        "pid": proc.pid,
        "portOpen": False,
        "port": port,
        "starting": True,
        "logFile": str(LOG_FILE),
    }


def stop_server(port: int) -> dict:
    pid = read_saved_pid()
    if pid and is_pid_running(pid):
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
            startupinfo=startupinfo,
            check=False,
        )
    clear_pid()
    port_open = is_port_open(port)
    return {
        "ok": True,
        "running": port_open,
        "managed": False,
        "pid": None,
        "portOpen": port_open,
        "port": port,
    }


def restart_server(port: int, backend: str = "auto") -> dict:
    stop_server(port)
    for _ in range(15):
        if not is_port_open(port):
            break
        time.sleep(0.2)
    return start_server(port, backend)


def main():
    try:
        req = read_native_message()
        if not req:
            return
        action = req.get("action", "status")
        port = int(req.get("port") or 8000)
        if not (1 <= port <= 65535):
            raise ValueError("Invalid port: must be between 1 and 65535")
        backend = str(req.get("backend") or "auto")

        if action == "start":
            res = start_server(port, backend)
        elif action == "stop":
            res = stop_server(port)
        elif action == "restart":
            res = restart_server(port, backend)
        else:
            res = get_status(port)

        send_native_message(res)
    except Exception as exc:
        send_native_message({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
