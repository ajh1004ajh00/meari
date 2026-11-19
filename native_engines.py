"""Windows-native engines for Meari.

Two local servers, started on demand and stopped when idle:
- speech: NVIDIA NeMo-Speech.cpp (`nemo-speech serve`) running Nemotron 3.5 Transcribe GGUF.
  It only accepts "audio + instruction" requests, so it does transcription, speaker tags and
  speech-to-English translation.
- text:   llama.cpp `llama-server` for everything that reads the transcript as text (summary, quiz,
  Q&A, translation tab). The model and its launch options are read from Hermes Agent's
  `presets.ini` (the same files and tuned settings Hermes uses), or given directly.

GPU memory: both stay loaded while they fit in MEARI_GPU_BUDGET_GB. Otherwise they take turns and
recording always wins: speech chunks are queued (and caught up later) while a text job finishes,
and a text job that needs the GPU waits while someone is recording.
"""
from __future__ import annotations

import base64
import configparser
import json
import os
import socket
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import requests

CREATE_NO_WINDOW = 0x08000000
HERE = Path(__file__).resolve().parent
LOG_DIR = HERE / "data"
PID_FILE = LOG_DIR / "engines.json"

HERMES_PRESETS = Path(os.environ.get("MEARI_HERMES_PRESETS",
                                     Path(os.environ.get("LOCALAPPDATA", "")) / "hermes" / "runtimes" / "llamacpp" / "presets.ini"))
ASR_EXE = os.environ.get("MEARI_ASR_EXE", r"D:\AI-Models\Speech\nemo-speech\bin\nemo-speech-0.3.0-windows-aarch64-cuda\bin\nemo-speech.exe")
ASR_MODEL = os.environ.get("MEARI_ASR_MODEL", r"D:\AI-Models\Speech\nemo-speech\models\NVIDIA-Nemotron-3.5-Transcribe-30B-A4B-AD-NVFP4.gguf")
ASR_PORT = int(os.environ.get("MEARI_ASR_PORT", "8091"))
LLM_EXE = os.environ.get("MEARI_LLAMA_SERVER", r"D:\Tools\local-vlm\llamacpp\llama-server.exe")
LLM_PRESET = os.environ.get("MEARI_LLM", "Qwen3.8-27B-UD-Q4_K_M")      # a section name in Hermes presets.ini
LLM_MODEL = os.environ.get("MEARI_LLM_MODEL", "")                      # or a GGUF path (overrides the preset's model)
LLM_CTX = int(os.environ.get("MEARI_LLM_CTX", "65536"))               # Meari sends at most ~36k characters
LLM_PORT = int(os.environ.get("MEARI_LLM_PORT", "8092"))
GPU_BUDGET_GB = float(os.environ.get("MEARI_GPU_BUDGET_GB", "80"))
ASR_GB = float(os.environ.get("MEARI_ASR_GB", "24"))

# preset keys passed to llama-server (others in Hermes' presets are router/UI settings or not needed here)
_VALUE_KEYS = {"model-draft", "spec-type", "spec-draft-n-max", "cache-type-k", "cache-type-v", "flash-attn",
               "batch-size", "ubatch-size", "lazy-mode", "top-k", "top-p", "min-p", "temp", "chat-template-kwargs"}
_FLAG_KEYS = {"backend-sampling", "spec-draft-backend-sampling"}   # "on" -> bare flag


def _gguf_gb(path: str) -> float:
    try:
        return Path(path).stat().st_size / 1e9
    except OSError:
        return 0.0


def _presets() -> configparser.ConfigParser:
    cp = configparser.ConfigParser(interpolation=None, strict=False)
    if HERMES_PRESETS.exists():
        cp.read(HERMES_PRESETS, encoding="utf-8")
    return cp


def list_presets() -> list[dict]:
    """Local text models Hermes has set up (name, size on disk), for the summary-engine choice."""
    out = []
    for name in _presets().sections():
        model = _presets().get(name, "model", fallback="")
        if model and Path(model).exists():
            files = [Path(model)] if "-00001-of-" not in model else sorted(Path(model).parent.glob(Path(model).name.split("-00001-of-")[0] + "-0*-of-*.gguf"))
            out.append({"id": name, "gb": round(sum(f.stat().st_size for f in files) / 1e9, 1)})
    return out


def llm_args(preset: str | None = None) -> tuple[list[str], float]:
    """llama-server arguments for the chosen text model, and an estimate of its GPU memory (GB)."""
    preset = preset or ENG.preset
    cp = _presets()
    sec: dict[str, str] = dict(cp.items(preset)) if cp.has_section(preset) else {}
    model = LLM_MODEL or sec.get("model", "")
    if not model:
        raise RuntimeError(f"text model not found: set MEARI_LLM (Hermes preset) or MEARI_LLM_MODEL (GGUF path)")
    args = ["-m", model, "-ngl", "999", "-c", str(LLM_CTX), "-np", "1", "--no-mmproj",
            "--host", "127.0.0.1", "--port", str(LLM_PORT), "--jinja"]
    for k, v in sec.items():
        if k in _VALUE_KEYS and v:
            args += [f"--{k}", v]
        elif k in _FLAG_KEYS and v.lower() in ("on", "true", "1"):
            args.append(f"--{k}")
    shards = [model] if "-00001-of-" not in model else [str(p) for p in Path(model).parent.glob(Path(model).name.split("-00001-of-")[0] + "-0*-of-*.gguf")]
    gb = sum(_gguf_gb(s) for s in shards) + _gguf_gb(sec.get("model-draft", "")) + 3.0   # + KV cache/compute buffers
    return args, gb


class Engine:
    def __init__(self, name: str, exe: str, port: int, health: str):
        self.name, self.exe, self.port, self.health = name, exe, port, health
        self.proc: subprocess.Popen | None = None
        self.started = 0.0

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def _port_open(self) -> bool:
        # Windows waits ~2 s before refusing a connection to a closed localhost port; probe the port quickly first
        with socket.socket() as s:
            s.settimeout(0.3)
            return s.connect_ex(("127.0.0.1", self.port)) == 0

    def ready(self) -> bool:
        if not self._port_open():
            return False
        try:
            r = requests.get(self.base + self.health, timeout=2)
            return r.ok
        except requests.RequestException:
            return False

    def running(self) -> bool:
        return (self.proc is not None and self.proc.poll() is None) or self.ready()

    def start(self, args: list[str]):
        if self.running():
            return
        LOG_DIR.mkdir(exist_ok=True)
        log = open(LOG_DIR / f"engine-{self.name}.log", "ab")
        self.proc = subprocess.Popen([self.exe, *args], stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                     cwd=str(Path(self.exe).parent), creationflags=CREATE_NO_WINDOW)
        self.started = time.time()
        _save_pids()

    def stop(self):
        p, self.proc = self.proc, None
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(15)
            except subprocess.TimeoutExpired:
                p.kill()
        _save_pids()


def _save_pids():
    try:
        PID_FILE.write_text(json.dumps({e.name: e.proc.pid for e in (ENG.asr, ENG.llm) if e.proc and e.proc.poll() is None}))
    except Exception:
        pass


def _kill_orphans():
    """Engines left running by a previous app process (crash/forced close) still hold GPU memory: end them."""
    try:
        pids = json.loads(PID_FILE.read_text())
    except Exception:
        return
    for name, pid in pids.items():
        exe = {"asr": Path(ASR_EXE).name, "llm": Path(LLM_EXE).name}.get(name, "")
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"], capture_output=True, text=True,
                             creationflags=CREATE_NO_WINDOW).stdout
        if exe and exe.lower() in out.lower():
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True, creationflags=CREATE_NO_WINDOW)
    PID_FILE.unlink(missing_ok=True)


class Engines:
    def __init__(self):
        self.asr = Engine("asr", ASR_EXE, ASR_PORT, "/health")
        self.llm = Engine("llm", LLM_EXE, LLM_PORT, "/health")
        self._lock = threading.RLock()
        self._llm_users = 0
        self.recording_now = lambda: False     # set by server.py
        self.preset = LLM_PRESET                # chosen local text model (Hermes preset name)

    def set_preset(self, name: str):
        """Switch the local text model; the running one (if different) is unloaded and the next job loads the new one."""
        with self._lock:
            if name != self.preset:
                if self._llm_users > 0:
                    raise RuntimeError("busy")      # a summary/quiz is being written right now
                self.preset = name
                self.llm.stop()

    def coexist(self) -> bool:
        try:
            gb = llm_args()[1]
        except Exception:
            gb = 0.0
        return ASR_GB + gb <= GPU_BUDGET_GB

    # ---- lifecycle
    def ensure(self, role: str) -> bool:
        """Start `role` if needed (non-blocking). False when it must wait for its turn."""
        with self._lock:
            e = self.asr if role == "asr" else self.llm
            if e.ready():
                return True
            if not self.coexist():
                if role == "asr" and self._llm_users > 0:
                    return False              # a text job is finishing; its chunks are queued meanwhile
                if role == "llm" and self.recording_now():
                    return False              # recording has priority over summaries
                (self.llm if role == "asr" else self.asr).stop()
            if role == "asr":
                e.start(["serve", "--asr-model", ASR_MODEL, "--host", "127.0.0.1", "--port", str(ASR_PORT)])
            else:
                e.start(llm_args()[0])
            return e.ready()

    def wait(self, role: str, timeout: float = 900, on_wait=None):
        t0, waited = time.time(), False
        while not self.ensure(role):
            if not waited and on_wait:
                on_wait()
                waited = True
            if time.time() - t0 > timeout:
                raise RuntimeError(f"{role} engine did not start in {int(timeout)} s (see data/engine-{role}.log)")
            e = self.asr if role == "asr" else self.llm
            if e.proc is not None and e.proc.poll() is not None:
                raise RuntimeError(f"{role} engine exited (see data/engine-{role}.log)")
            time.sleep(2)

    @contextmanager
    def using_llm(self):
        with self._lock:
            self._llm_users += 1
        try:
            self.wait("llm")
            yield
        finally:
            with self._lock:
                self._llm_users -= 1

    def state(self) -> str:
        """Recording readiness for the UI: speech engine ready / starting / off."""
        if self.asr.ready():
            return "ready"
        return "starting" if self.asr.running() else "off"

    def any_running(self) -> bool:
        return self.asr.running() or self.llm.running()

    def stop_all(self):
        with self._lock:
            self.asr.stop()
            self.llm.stop()

    # ---- requests
    def asr_chat(self, prompt: str, wav: bytes, timeout: float = 1800) -> str:
        """Speech request: exactly one user message with the instruction and the audio (NeMo-Speech's chat API)."""
        if not self.asr.ready():
            raise RuntimeError("speech engine not ready")
        body = {"model": "salm", "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "input_audio", "input_audio": {"data": base64.b64encode(wav).decode(), "format": "wav"}}]}]}
        r = requests.post(self.asr.base + "/v1/chat/completions", json=body, timeout=timeout)
        if not r.ok:
            raise RuntimeError(f"speech engine error {r.status_code}: {r.text[:300]}")
        return r.json()["choices"][0]["message"]["content"] or ""

    def llm_chat(self, messages, max_tokens=2048, temperature=0.0, timeout=1800) -> str:
        with self.using_llm():
            r = requests.post(self.llm.base + "/v1/chat/completions", json={
                "model": "meari", "messages": messages, "max_tokens": max_tokens, "temperature": temperature,
                "chat_template_kwargs": {"enable_thinking": False}}, timeout=timeout)
        if not r.ok:
            raise RuntimeError(f"text engine error {r.status_code}: {r.text[:300]}")
        return r.json()["choices"][0]["message"]["content"] or ""


ENG = Engines()


def kill_orphans():
    """Call once when the app server starts (not on import: tools may import this module while Meari runs)."""
    _kill_orphans()
