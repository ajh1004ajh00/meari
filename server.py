"""Meari (메아리, formerly SoriNote): local lecture/meeting notes on Nemotron 3.5 Transcribe.

Runs inside WSL (Ubuntu-24.04) with the nemo-speech venv. Talks to the vLLM
server at ENGINE_URL for transcription, speaker tags, summary, translation,
Q&A and study material.
"""
import base64
import io
import json
import math
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
import wave
from collections import Counter
from pathlib import Path

import numpy as np
import requests
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

APP_DIR = Path(__file__).resolve().parent


def _load_local_env():
    """This machine's private settings (git-ignored local.env, see local.env.example). Real env vars win."""
    p = APP_DIR / "local.env"
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


def _host_path(p: str) -> str:
    """local.env is shared with the WSL runtime: /mnt/d/x means D:\\x when running on Windows."""
    m = re.match(r"^/mnt/([a-zA-Z])/(.*)$", str(p))
    return f"{m.group(1).upper()}:\\" + m.group(2).replace("/", "\\") if (m and os.name == "nt") else str(p)


_load_local_env()
# native: Windows, no WSL - NeMo-Speech.cpp for speech + llama.cpp for text (native_engines.py)
# vllm:   the original WSL setup - one vLLM server (scripts/engine.sh) for both
NATIVE = os.environ.get("MEARI_RUNTIME", "native" if os.name == "nt" else "vllm") == "native"
if NATIVE:
    import cloud_llm
    from native_engines import ENG, kill_orphans, list_presets
    kill_orphans()   # engines a crashed/forced-closed earlier app process left on the GPU
FFMPEG = os.environ.get("MEARI_FFMPEG", "ffmpeg")
DATA = Path(_host_path(os.environ.get("SORINOTE_DATA", APP_DIR / "data"))) / "sessions"
DATA.mkdir(parents=True, exist_ok=True)
SETTINGS = DATA.parent / "settings.json"   # app settings kept with the notes (e.g. the summary engine)
ENGINE_URL = os.environ.get("ENGINE_URL", "http://127.0.0.1:8010/v1")
MODEL = "nemotron-transcribe"
SR = 16000
FINAL_PIECE_S = 1800  # final speaker pass works on <=30 min pieces
MATERIAL_EXT = {".pdf", ".pptx", ".txt", ".md"}

app = FastAPI(title="SoriNote")
_locks: dict[str, threading.Lock] = {}
# Host names the app answers to. Add your Tailscale name to open it from your phone, e.g.
# SORINOTE_HOSTS=127.0.0.1,localhost,my-laptop.my-tailnet.ts.net
ALLOWED_HOSTS = {h.strip().lower() for h in os.environ.get(
    "SORINOTE_HOSTS", "127.0.0.1,localhost").split(",") if h.strip()}


@app.middleware("http")
async def guard(request: Request, call_next):
    """Host allowlist (DNS rebinding) + custom header on writes (cross-site requests need a CORS preflight we never grant)."""
    host = (request.headers.get("host") or "").rsplit(":", 1)[0].lower()
    if host not in ALLOWED_HOSTS:
        return PlainTextResponse("Host not allowed.", status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-sorinote") != "1":
        return PlainTextResponse("Missing X-SoriNote header.", status_code=403)
    if request.url.path.startswith("/api/") and request.url.path != "/api/status":
        touch()  # any real use keeps the engine awake; the 5-second status poll of an idle page does not
    resp = await call_next(request)
    if request.url.path in ("/", "/index.html"):
        # the page names its scripts with ?v=N; always revalidate the page itself so an update shows on next open
        resp.headers["Cache-Control"] = "no-cache"
    return resp


_last_activity = time.time()


def touch():
    global _last_activity
    _last_activity = time.time()


def lock_for(sid: str) -> threading.Lock:
    return _locks.setdefault(sid, threading.Lock())


# ---------------------------------------------------------------- storage
def sdir(sid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", sid):
        raise HTTPException(404, "no such session")
    d = DATA / sid
    if not d.is_dir():
        raise HTTPException(404, "no such session")
    return d


def rj(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def wj(p: Path, obj):
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(p)


def rtext(p: Path):
    return p.read_text(encoding="utf-8") if p.exists() else None


def meta(sid: str) -> dict:
    return rj(sdir(sid) / "meta.json", {})


def set_meta(sid: str, **kw):
    return update_meta(sid, lambda m: m.update(kw))


def update_meta(sid: str, fn):
    """Read-modify-write meta.json atomically w.r.t. other threads (chunk endpoint, backlog worker, jobs)."""
    d = sdir(sid)
    with _meta_lock:
        m = rj(d / "meta.json", {})
        fn(m)
        m["updated"] = time.time()
        wj(d / "meta.json", m)
        return m


def add_segment(sid: str, seg: dict):
    d = sdir(sid)
    with _seg_lock:
        segs = rj(d / "segments.json", [])
        segs = [s for s in segs if abs(s["start"] - seg["start"]) > 0.01] + [seg]
        segs.sort(key=lambda s: s["start"])
        wj(d / "segments.json", segs)


def pcm_path(sid: str) -> Path:
    return sdir(sid) / "audio.pcm"


def duration(sid: str) -> float:
    p = pcm_path(sid)
    return p.stat().st_size / 2 / SR if p.exists() else 0.0


SILENCE_PEAK = 300  # int16; below this a chunk is treated as silence and never sent to the model


def has_signal(sid: str) -> bool:
    p = pcm_path(sid)
    if not p.exists() or p.stat().st_size < 2:
        return False
    a = np.memmap(p, dtype="<i2", mode="r")
    step = SR * 60
    return any(int(np.abs(a[i:i + step]).max()) > SILENCE_PEAK for i in range(0, len(a), step))


def wav_bytes(samples: np.ndarray) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(samples.astype("<i2").tobytes())
    return buf.getvalue()


def read_pcm(sid: str, start_s: float = 0, end_s: float | None = None) -> np.ndarray:
    a = np.fromfile(pcm_path(sid), dtype="<i2")
    s = int(start_s * SR)
    e = len(a) if end_s is None else int(end_s * SR)
    return a[s:e]


# ---------------------------------------------------------------- engine
def engine_ready() -> bool:
    if NATIVE:
        return ENG.asr.ready()
    try:
        return requests.get(f"{ENGINE_URL}/models", timeout=2).ok
    except requests.RequestException:
        return False


# The app owns the engine's lifecycle: it starts it on demand (recording, upload, jobs), lets a recording
# begin before it is ready (chunks are queued and transcribed once it is up), and turns it off after
# IDLE_OFF_MIN minutes without use to hand the ~42 GB of GPU memory back.
ENGINE_SH = APP_DIR / "scripts" / "engine.sh"
IDLE_OFF_MIN = float(os.environ.get("MEARI_IDLE_OFF_MIN", "30"))
_engine_lock = threading.Lock()
_meta_lock = threading.RLock()
_seg_lock = threading.Lock()


def engine_proc_running() -> bool:
    if NATIVE:
        return ENG.any_running()
    return subprocess.run(["pgrep", "-f", "vllm serve"], capture_output=True).returncode == 0


def engine_state() -> str:
    if NATIVE:
        return ENG.state()
    if engine_ready():
        return "ready"
    return "starting" if engine_proc_running() else "off"


def start_engine():
    if NATIVE:
        ENG.ensure("asr")
        return
    with _engine_lock:
        if engine_proc_running():
            return
        (APP_DIR / "data").mkdir(exist_ok=True)
        log = open(APP_DIR / "data" / "engine.log", "ab")
        subprocess.Popen(["bash", str(ENGINE_SH)], stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         start_new_session=True, env={**os.environ, "GPU_UTIL": os.environ.get("GPU_UTIL", "0.38")})


def stop_engine():
    if NATIVE:
        ENG.stop_all()
        return
    subprocess.run(["pkill", "-f", "vllm serve"])


def wait_engine(sid: str | None = None, timeout: float = 900, role: str = "asr"):
    """Block a background job until the engine answers, starting it if needed.
    role (native only): "asr" for speech work, "llm" for text work; the vLLM runtime does both in one engine."""
    if NATIVE:
        if role == "llm" and llm_is_cloud():
            return   # text goes to a subscription CLI; no local engine to start
        prev = meta(sid).get("status") if sid else None
        ENG.wait(role, timeout, on_wait=(lambda: set_meta(sid, status="waiting")) if sid else None)
        if sid and meta(sid).get("status") == "waiting":
            set_meta(sid, status=prev)
        return
    if engine_ready():
        return
    start_engine()
    prev = meta(sid).get("status") if sid else None
    if sid:
        set_meta(sid, status="waiting")
    t0 = time.time()
    while time.time() - t0 < timeout:
        if engine_ready():
            if sid:
                set_meta(sid, status=prev)
            return
        time.sleep(3)
    raise RuntimeError("엔진이 15분 안에 켜지지 않았어요. data/engine.log를 확인해 주세요.")


def backlog_total() -> int:
    n = 0
    for d in DATA.iterdir():
        m = rj(d / "meta.json", None)
        if m:
            n += len(m.get("pending") or [])
    return n


def jobs_running() -> bool:
    return any(lk.locked() for lk in list(_locks.values()))


def recording_now() -> bool:
    """A chunk arrived in the last 40 s (chunks come every 8-16 s while recording)."""
    for d in DATA.iterdir():
        m = rj(d / "meta.json", None)
        if m and m.get("status") == "recording" and time.time() - m.get("updated", 0) < 40:
            return True
    return False


def llm_choice() -> str:
    """Summary engine: "local:<Hermes preset>", "claude:sonnet|opus" or "codex:" (subscription CLIs). vLLM: "engine"."""
    if not NATIVE:
        return "engine"
    return (rj(SETTINGS, {}) or {}).get("llm") or f"local:{ENG.preset}"


def llm_is_cloud() -> bool:
    return llm_choice().split(":", 1)[0] in ("claude", "codex")


def chat(messages, max_tokens=2048, temperature=0.0, timeout=1800) -> str:
    """Text-only request (summary, quiz, Q&A, translation). Native: the chosen summary engine."""
    if NATIVE:
        kind, _, name = llm_choice().partition(":")
        if kind == "claude":
            return cloud_llm.claude_chat(messages, name or "sonnet", timeout=min(timeout, 900))
        if kind == "codex":
            return cloud_llm.codex_chat(messages, name, timeout=min(timeout, 900))
        return ENG.llm_chat(messages, max_tokens=max_tokens, temperature=temperature, timeout=timeout)
    r = requests.post(
        f"{ENGINE_URL}/chat/completions",
        json={
            "model": MODEL,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "chat_template_kwargs": {"enable_thinking": False},
            "skip_special_tokens": False,
        },
        timeout=timeout,
    )
    if not r.ok:
        raise RuntimeError(f"engine error {r.status_code}: {r.text[:300]}")
    return r.json()["choices"][0]["message"]["content"] or ""


def speech_ratio(a: np.ndarray) -> float:
    """Share of 100 ms frames that are clearly louder than the chunk's own noise floor (rough VAD)."""
    hop = SR // 10
    n = len(a) // hop
    if n == 0:
        return 0.0
    fr = np.sqrt(np.mean(a[: n * hop].astype(np.float32).reshape(n, hop) ** 2, axis=1))
    thr = max(300.0, 4.0 * float(np.percentile(fr, 10)))
    return float(np.mean(fr > thr))


MIN_SPEECH_RATIO = 0.10  # near-silent chunks made the model invent text ("1, 2, 3…", "음, 음, …", refusals)


def collapse_repeats(t: str) -> str:
    """'음, 음, 음, 음, …' or a phrase looped many times -> keep it twice."""
    return re.sub(r"(\S+?(?:\s+\S+?){0,5}?)(?:[,.\s]+\1){3,}", r"\1, \1", t)


def strip_special(t: str) -> str:
    return re.sub(r"<\|[^|]*\|>", "", t).strip()


# Spoken language of the recordings (independent of the UI language): ko | en | auto (no hint)
SPEECH_LANG = os.environ.get("MEARI_SPEECH_LANG", "ko").lower()


def asr_prompt(speakers: bool) -> str:
    # Context terms are deliberately NOT sent to ASR: in Korean tests the model inserted them
    # into unrelated chunks. Terms are used only when summarizing (spelling correction).
    # Language hint: without it, short (8-16 s) Korean chunks came back in English/German/Chinese or as refusals.
    if SPEECH_LANG == "en":
        p = "The audio is in English. Transcribe it verbatim in English with punctuation. "
    elif SPEECH_LANG == "auto":
        p = "Transcribe the audio verbatim in the language it is spoken in, with punctuation. "
    else:
        p = "The audio is in Korean (it may contain English words). Transcribe it verbatim in Korean with punctuation. "
    p += "Write numbers, years, dates and units with Arabic numerals."
    if speakers:
        p += " Put speaker tags <spk:0> <spk:1> <spk:2> <spk:3> on the transcription."
    return p


def transcribe(samples: np.ndarray, prompt: str) -> str:
    if NATIVE:
        return ENG.asr_chat(prompt, wav_bytes(samples))
    b64 = base64.b64encode(wav_bytes(samples)).decode()
    dur = len(samples) / SR
    return chat(
        [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "audio_url", "audio_url": {"url": f"data:audio/wav;base64,{b64}"}},
        ]}],
        max_tokens=int(dur * 10) + 256,
    )


TRANSLATE_SYS = ("You are a professional translator. Translate everything the user sends from Korean into English. "
                 "Keep the [화자 N] labels as [Speaker N] and keep the line structure. Output only the English translation.")


def to_english(text: str, max_tokens=4000) -> str:
    # the model translates reliably only to/from English (Korean→Japanese etc. came back untranslated)
    return strip_special(chat([{"role": "system", "content": TRANSLATE_SYS}, {"role": "user", "content": text}],
                              max_tokens=max_tokens, temperature=0.2))


def split_by_silence(a: np.ndarray, min_s=8.0, max_s=20.0) -> list[tuple[int, int]]:
    """Cut audio into pieces of min_s..max_s seconds at the quietest 100 ms frame."""
    hop = SR // 10
    n = len(a) // hop
    if n == 0:
        return [(0, len(a))] if len(a) else []
    e = np.sqrt(np.mean(a[: n * hop].astype(np.float32).reshape(n, hop) ** 2, axis=1))
    cuts, start = [], 0
    while start < n:
        if n - start <= max_s * 10:
            cuts.append((start * hop, len(a)))
            break
        lo, hi = start + int(min_s * 10), start + int(max_s * 10)
        cut = lo + int(np.argmin(e[lo:hi]))
        cuts.append((start * hop, cut * hop))
        start = cut
    return cuts


def parse_json_obj(text: str):
    text = strip_special(text)
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M)
    s = text.find("{")
    if s < 0:
        raise ValueError("no JSON object")
    # first complete object only: the model sometimes appends a note or a second object after it
    return json.JSONDecoder().raw_decode(text[s:])[0]


def hangul_ratio(s: str) -> float:
    letters = [c for c in s if c.isalpha()]
    return sum("가" <= c <= "힣" for c in letters) / len(letters) if letters else 0.0


TRANSLATE_MD_SYS = ("You are a professional translator. Translate the Korean in the user's Markdown into English. "
                    "Keep the Markdown structure exactly (headings, bullets, bold, backticks, line breaks). "
                    "Text that is already English stays as it is. Output only the translated Markdown.")
TRANSLATE_JSON_SYS = ("You are a professional translator. Translate every Korean string value in the user's JSON into English. "
                      "Keep the keys, the structure and all numbers exactly. Output only the JSON.")


def ensure_english_md(md: str) -> str:
    """The model tends to answer in the transcript's language (Korean) even when asked for English; translate if so."""
    if hangul_ratio(md) < 0.15:
        return md
    return strip_special(chat([{"role": "system", "content": TRANSLATE_MD_SYS}, {"role": "user", "content": md}],
                              max_tokens=4000, temperature=0.1))


# ---------------------------------------------------------------- materials (lecture slides / PDFs)
def extract_pages(path: Path) -> list[str]:
    ext = path.suffix.lower()
    if ext == ".pdf":
        from pypdf import PdfReader
        return [(p.extract_text() or "").strip() for p in PdfReader(str(path)).pages]
    if ext == ".pptx":
        from pptx import Presentation
        pages = []
        for slide in Presentation(str(path)).slides:
            parts = [sh.text_frame.text for sh in slide.shapes if sh.has_text_frame]
            if slide.has_notes_slide:
                parts.append(slide.notes_slide.notes_text_frame.text)
            pages.append("\n".join(p for p in parts if p.strip()))
        return pages
    text = path.read_text(encoding="utf-8", errors="replace")
    return [p.strip() for p in re.split(r"\n\s*\n\s*\n", text) if p.strip()] or [text]


def materials(sid: str) -> list[dict]:
    return rj(sdir(sid) / "materials.json", [])


def materials_text(sid: str, limit=8000) -> str:
    out = []
    for m in materials(sid):
        for i, p in enumerate(m["pages"], 1):
            if p:
                out.append(f"[{m['name']} p.{i}] {p}")
    return "\n".join(out)[:limit]


def tokens(text: str) -> list[str]:
    """Korean words -> character bigrams (robust to particles: 합금은/합금), plus Latin words and numbers."""
    out = []
    for w in re.findall(r"[가-힣]{2,}|[A-Za-z][A-Za-z0-9\-]{2,}|\d{2,}", text.lower()):
        if re.match(r"[가-힣]", w):
            out += [w[i:i + 2] for i in range(len(w) - 1)]
        else:
            out.append(w)
    return out


def link_materials(sid: str):
    """Attach the best-matching slide/page to each live segment (IDF-weighted word overlap)."""
    d = sdir(sid)
    mats = materials(sid)
    segs = rj(d / "segments.json", [])
    pages = [(m["id"], i + 1, Counter(tokens(p))) for m in mats for i, p in enumerate(m["pages"])]
    if not segs:
        return
    df = Counter(t for _, _, c in pages for t in c)
    n = max(len(pages), 1)
    for s in segs:
        s.pop("mat", None)
        s.pop("page", None)
        st = set(tokens(s["text"]))
        best, score = None, 0.0
        for mid, pno, c in pages:
            sc = sum(math.log(1 + n / df[t]) for t in st if t in c)
            if sc > score:
                best, score = (mid, pno), sc
        if best and score >= 6.0:  # tuned on a test deck: true matches scored 7-29, unrelated lines <4
            s["mat"], s["page"] = best
    wj(d / "segments.json", segs)


# ---------------------------------------------------------------- note jobs
def parse_speakers(text: str, part: int | None = None) -> list[dict]:
    text = strip_special(text)
    out = []
    for m in re.finditer(r"(?:<spk:(\d+)>)?\s*([^<]+)", text):
        t = m.group(2).strip()
        if not t:
            continue
        spk = int(m.group(1)) if m.group(1) is not None else (out[-1]["speaker"] if out else 0)
        if out and out[-1]["speaker"] == spk and m.group(1) is None:
            out[-1]["text"] += " " + t
        else:
            out.append({"speaker": spk, "text": t, "part": part})
    return out


def transcript_text(sid: str) -> str:
    d = sdir(sid)
    final = rj(d / "final.json", None)
    if final:
        return "\n".join(f"[화자 {p['speaker'] + 1}] {p['text']}" for p in final["paragraphs"])
    return "\n".join(s["text"] for s in rj(d / "segments.json", []))


SUMMARY_SYS = "너는 강의와 회의 내용을 정리하는 꼼꼼한 조수다. 반드시 한국어로, 녹취록에 있는 내용만 근거로 쓴다. 지어내지 않는다."
SUMMARY_FMT = (
    "아래 녹취록을 복습용 마크다운 노트로 정리해줘. 형식:\n"
    "## 한 줄 요약\n(1~2문장)\n"
    "## 핵심 내용\n(주제별 소제목 ### 와 불릿, 중요한 숫자·고유명사 보존)\n"
    "## 주요 용어\n(최대 10개, `용어`: 짧은 설명)\n"
    "## 할 일 · 질문거리\n(녹취록에 언급된 과제, 결정사항, 다음 일정. 없으면 '없음')\n"
    "녹취록의 음성 인식 오타는 문맥에 맞게 바로잡아도 된다."
)


# ---- output language of summaries, quizzes and answers: the UI language the note was processed in
# (the page sends X-Meari-Lang; it is stored as meta "lang" so resumed jobs keep it)
SUMMARY_SYS_EN = ("You are a careful assistant who organizes lectures and meetings. Always write in English, "
                  "using only what is in the transcript (the transcript itself may be in Korean). Do not make things up.")
SUMMARY_FMT_EN = (
    "Turn the transcript below into a Markdown study note. Format:\n"
    "## One-line summary\n(1-2 sentences)\n"
    "## Key points\n(### subheadings per topic with bullets; keep important numbers and proper nouns)\n"
    "## Key terms\n(up to 10, `term`: short explanation)\n"
    "## To-dos · open questions\n(assignments, decisions and next dates mentioned in the transcript; 'None' if there are none)\n"
    "You may fix obvious speech-recognition errors from context."
)
P = {  # prompt pieces by language
    "ko": {"sys": SUMMARY_SYS, "fmt": SUMMARY_FMT, "tx": "녹취록:\n",
           "part": "녹취록 {i}/{n}번째 부분의 핵심 내용을 불릿으로 빠짐없이 정리해줘. 숫자·고유명사·과제는 보존.\n\n{p}",
           "merge": "아래는 긴 녹취록을 부분별로 정리한 메모다. 이것을 하나의 노트로 합쳐줘.\n\n", "partlbl": "(부분 {i})",
           "terms": "(참고: 이 녹음에 나오는 정확한 용어·이름 표기 — {t}. 녹취록에서 비슷하게 잘못 인식된 말은 이 표기로 바로잡아라.)\n",
           "mats": "(참고: 강의 자료 내용 — 표기 교정과 맥락 파악에만 쓰고, 녹취록에 없는 내용을 요약에 추가하지 마라.)\n"},
    "en": {"sys": SUMMARY_SYS_EN, "fmt": SUMMARY_FMT_EN, "tx": "Transcript:\n",
           "part": "Summarize the key points of part {i}/{n} of the transcript as bullets, in English, leaving nothing out. "
                   "Keep numbers, proper nouns and assignments.\n\n{p}",
           "merge": "Below are notes taken part by part from a long transcript. Merge them into one note in English.\n\n",
           "partlbl": "(part {i})",
           "terms": "(Note: correct spelling of terms and names in this recording — {t}. Fix words in the transcript that were misrecognized as something similar.)\n",
           "mats": "(Note: lecture material — use it only to fix spelling and understand context; do not add anything to the summary that is not in the transcript.)\n"},
}


def lang_of(v) -> str:
    return "en" if str(v or "").lower().startswith("en") else "ko"


def req_lang(request: Request) -> str:
    return lang_of(request.headers.get("x-meari-lang"))


def reference_block(terms: str, mats: str, lang: str = "ko") -> str:
    L, out = P[lang], ""
    if terms.strip():
        out += L["terms"].format(t=terms.strip())
    if mats.strip():
        out += L["mats"] + mats + "\n"
    return out + "\n" if out else ""


def summarize(text: str, ref: str = "", lang: str = "ko") -> str:
    L = P[lang]
    if len(text) <= 24000:
        return strip_special(chat([{"role": "system", "content": L["sys"]},
                                   {"role": "user", "content": L["fmt"] + "\n\n" + ref + L["tx"] + text}],
                                  max_tokens=3000, temperature=0.2))
    parts = [text[i:i + 16000] for i in range(0, len(text), 16000)]
    notes = []
    for i, p in enumerate(parts, 1):
        notes.append(strip_special(chat(
            [{"role": "system", "content": L["sys"]},
             {"role": "user", "content": L["part"].format(i=i, n=len(parts), p=p)}],
            max_tokens=1500, temperature=0.2)))
    merged = "\n\n".join(L["partlbl"].format(i=i) + "\n" + n for i, n in enumerate(notes, 1))
    return strip_special(chat([{"role": "system", "content": L["sys"]},
                               {"role": "user", "content": L["fmt"] + "\n\n" + ref + L["merge"] + merged}],
                              max_tokens=3000, temperature=0.2))


def run_finalize(sid: str, do_segments: bool):
    d = sdir(sid)
    with lock_for(sid):
        try:
            wait_engine(sid)
            m = meta(sid)
            total = duration(sid)
            if do_segments:  # uploaded file: build timestamped segments first
                set_meta(sid, status="transcribing", progress=0)
                a = read_pcm(sid)
                segs = []
                pieces = split_by_silence(a)
                for i, (s, e) in enumerate(pieces):
                    txt = collapse_repeats(strip_special(transcribe(a[s:e], asr_prompt(False)))) if speech_ratio(a[s:e]) >= MIN_SPEECH_RATIO else ""
                    if txt:
                        segs.append({"start": round(s / SR, 2), "end": round(e / SR, 2), "text": txt})
                    set_meta(sid, progress=round((i + 1) / len(pieces) * 100))
                wj(d / "segments.json", segs)
            set_meta(sid, status="speakers", progress=0)
            paragraphs, starts = [], list(np.arange(0, max(total, 0.1), FINAL_PIECE_S))
            for i, st in enumerate(starts):
                piece = read_pcm(sid, st, min(st + FINAL_PIECE_S, total))
                if len(piece) < SR // 2 or np.abs(piece).max(initial=0) <= SILENCE_PEAK:
                    continue
                txt = transcribe(piece, asr_prompt(True))
                paragraphs += parse_speakers(txt, part=i + 1 if len(starts) > 1 else None)
                set_meta(sid, progress=round((i + 1) / len(starts) * 100))
            wj(d / "final.json", {"paragraphs": paragraphs, "parts": len(starts)})
            link_materials(sid)
            # The summary is made when the user asks for it (Make summary), with the engine chosen then.
            set_meta(sid, status="done", progress=None, error=None)
        except Exception as ex:  # surface to UI
            set_meta(sid, status="error", error=str(ex)[:500], progress=None)


def make_summary(sid: str):
    d = sdir(sid)
    m = meta(sid)
    set_meta(sid, status="summarizing", progress=None, llm=llm_choice())
    lang = lang_of(m.get("lang"))
    ref = reference_block(m.get("terms", ""), materials_text(sid), lang)
    summary = summarize(transcript_text(sid), ref, lang)
    if lang == "en":
        summary = ensure_english_md(summary)
    (d / "summary.md").write_text(summary, encoding="utf-8")


def run_summarize(sid: str):
    with lock_for(sid):
        try:
            wait_engine(sid, role="llm")
            make_summary(sid)
            set_meta(sid, status="done", progress=None, error=None)
        except Exception as ex:
            set_meta(sid, status="error", error=str(ex)[:500], progress=None)


def run_translate(sid: str):
    d = sdir(sid)
    with lock_for(sid):
        try:
            wait_engine(sid, role="llm")
            text = transcript_text(sid)
            out, buf = [], ""
            for line in text.split("\n"):
                if len(buf) + len(line) > 3000 and buf:
                    out.append(buf)
                    buf = ""
                buf += line + "\n"
            if buf:
                out.append(buf)
            (d / "translation.md").write_text("\n".join(to_english(c) for c in out), encoding="utf-8")
            set_meta(sid, status="done", error=None)
        except Exception as ex:
            set_meta(sid, status="error", error=str(ex)[:500])


STUDY_PROMPT = """아래 녹취록(강의/회의)으로 복습 자료를 만들어줘. 녹취록에 있는 내용만 쓴다.
반드시 아래 JSON 하나만 출력한다. 설명 문장, 코드블록 표시는 쓰지 않는다.
{"quiz": [{"q": "질문", "choices": ["보기1", "보기2", "보기3", "보기4"], "answer": 0, "explain": "정답 해설 한 문장"}],
 "cards": [{"front": "용어 또는 질문", "back": "뜻 또는 답"}]}
- quiz: 객관식 %d문제. answer는 정답 보기의 0부터 시작하는 번호. 정답 위치를 골고루 섞는다.
- cards: 암기카드 %d장. 핵심 개념·숫자·이름 위주.

녹취록:
%s"""
STUDY_PROMPT_EN = """Make study material from the transcript (lecture/meeting) below. Use only what is in the transcript.
Write every question, choice, explanation and card in English (the transcript itself may be in Korean).
Output exactly one JSON object like this, with no explanation and no code fences:
{"quiz": [{"q": "question", "choices": ["choice 1", "choice 2", "choice 3", "choice 4"], "answer": 0, "explain": "one-sentence explanation"}],
 "cards": [{"front": "term or question", "back": "meaning or answer"}]}
- quiz: %d multiple-choice questions. answer is the 0-based index of the correct choice. Spread the correct positions evenly.
- cards: %d flashcards, focused on key concepts, numbers and names.

Transcript:
%s"""


def json_items(text: str, first_key: str) -> list[dict]:
    """Every complete JSON object that starts with {"<first_key>" anywhere in the text. The model sometimes writes
    more items than asked (output cut off mid-object) or closes the wrapper wrongly; intact items still count."""
    dec, out = json.JSONDecoder(), []
    for m in re.finditer(r'\{\s*"' + first_key + '"', text):
        try:
            out.append(dec.raw_decode(text, m.start())[0])
        except ValueError:
            pass
    return out


def clean_quiz(q: dict) -> dict | None:
    ch, a = q.get("choices"), q.get("answer")
    if not (q.get("q") and isinstance(ch, list) and len(ch) >= 2):
        return None
    if isinstance(a, str):  # "1", "B" or the choice text
        a = int(a) if a.strip().isdigit() else ("ABCDEFG".index(a.strip().upper()) if len(a.strip()) == 1 and a.strip().upper() in "ABCDEFG"
                                                 else (ch.index(a) if a in ch else None))
    if not isinstance(a, int) or not 0 <= a < len(ch):
        return None
    return {"q": q["q"], "choices": ch, "answer": a, "explain": q.get("explain") or q.get("explanation") or ""}


def english_study(quiz: list[dict], cards: list[dict]) -> tuple[list[dict], list[dict]]:
    """Asked for English, the model often still writes part of the set (usually the cards) in Korean.
    Translate whichever part came back Korean; keep the structure so answer indexes stay valid."""
    ko = lambda x: hangul_ratio(json.dumps(x, ensure_ascii=False)) >= 0.15

    def tr(items):
        try:
            out = json_items(strip_special(chat([{"role": "system", "content": TRANSLATE_JSON_SYS},
                                                 {"role": "user", "content": json.dumps(items, ensure_ascii=False)}],
                                                max_tokens=5000, temperature=0.1)), next(iter(items[0])))
            return out if len(out) == len(items) else None
        except Exception:
            return None  # keep the Korean part rather than fail the whole set

    if quiz and ko(quiz):
        tq = tr([{"q": q["q"], "choices": q["choices"], "explain": q["explain"]} for q in quiz])
        if tq and all(len(a.get("choices", [])) == len(b["choices"]) for a, b in zip(tq, quiz)):
            quiz = [{**b, "q": a.get("q") or b["q"], "choices": a["choices"], "explain": a.get("explain") or b["explain"]}
                    for a, b in zip(tq, quiz)]
    if cards and ko(cards):
        tc = tr([{"front": c["front"], "back": c["back"]} for c in cards])
        if tc and all(c.get("front") and c.get("back") for c in tc):
            cards = tc
    return quiz, cards


def run_study(sid: str):
    d = sdir(sid)
    with lock_for(sid):
        try:
            wait_engine(sid, role="llm")
            text = transcript_text(sid)[:24000]
            nq = max(3, min(10, len(text) // 600))
            prompt = STUDY_PROMPT_EN if lang_of(meta(sid).get("lang")) == "en" else STUDY_PROMPT
            last = None
            for attempt in range(2):
                try:
                    raw = strip_special(chat([{"role": "user", "content": prompt % (nq, nq, text)}],
                                             max_tokens=6000, temperature=0.3 + 0.2 * attempt))
                    quiz = [q for q in map(clean_quiz, json_items(raw, "q")) if q][:nq]
                    cards = [c for c in json_items(raw, "front") if c.get("front") and c.get("back")][:nq]
                    if not quiz:  # a set without questions is not worth keeping; try once more
                        last = "no quiz in the output"
                        continue
                    if prompt is STUDY_PROMPT_EN:
                        quiz, cards = english_study(quiz, cards)
                    if quiz or cards:
                        wj(d / "study.json", {"quiz": quiz, "cards": cards, "created": time.time()})
                        break
                    last = "empty result"
                except (ValueError, json.JSONDecodeError) as ex:
                    last = str(ex)
            else:
                raise RuntimeError(f"복습 자료를 만들지 못했어요 ({last})")
            set_meta(sid, status="done", error=None)
        except Exception as ex:
            set_meta(sid, status="error", error=str(ex)[:500])


def start_job(sid: str, status: str, target, *args):
    if lock_for(sid).locked():
        raise HTTPException(409, "이미 처리 중이에요")
    set_meta(sid, status=status, progress=None)  # before the thread starts, so the UI's next poll sees it
    threading.Thread(target=target, args=(sid, *args), daemon=True).start()
    return {"ok": True}


# ---------------------------------------------------------------- API
@app.get("/api/status")
def status():
    st = engine_state()
    return {"engine": st == "ready", "state": st, "backlog": backlog_total(), "idle_off_min": IDLE_OFF_MIN,
            "boot_s": 20 if NATIVE else 180,   # how long the speech engine takes to start (UI wording)
            "idle_left_s": max(0, int(IDLE_OFF_MIN * 60 - (time.time() - _last_activity))) if IDLE_OFF_MIN > 0 else None}


@app.post("/api/engine/start")
def api_engine_start():
    start_engine()
    return {"state": engine_state()}


@app.post("/api/engine/stop")
def api_engine_stop():
    """Free the GPU but keep the app (and all notes) running."""
    if recording_now():
        raise HTTPException(409, "녹음 중에는 엔진을 끌 수 없어요")
    if jobs_running() or backlog_total():
        raise HTTPException(409, "아직 정리 중인 노트가 있어요. 끝난 뒤에 꺼 주세요")
    stop_engine()
    return {"state": "off"}


def _llm_label(i: str) -> str:
    kind, _, name = i.partition(":")
    if kind == "claude":
        return cloud_llm.CLAUDE_MODELS.get(name, name)
    if kind == "codex":
        return cloud_llm.codex_label(name)
    return re.sub(r"-(UD-)?(I?Q\d\w*|NVFP4|Q\d_K_\w+)$", "", name).replace("NVIDIA-", "")


@app.get("/api/llm")
def llm_get():
    """Summary engines to choose from: Hermes' local models and the subscription CLIs that are installed."""
    opts = []
    if NATIVE:
        opts += [{"id": f"local:{p['id']}", "label": _llm_label(f"local:{p['id']}"), "kind": "local", "gb": p["gb"]} for p in list_presets()]
        av = cloud_llm.available()
        if av["claude"]:
            opts += [{"id": f"claude:{k}", "label": v, "kind": "cloud"} for k, v in cloud_llm.CLAUDE_MODELS.items()]
        if av["codex"]:
            opts.append({"id": "codex:", "label": cloud_llm.codex_label(), "kind": "cloud"})
    return {"current": llm_choice(), "options": opts, "native": NATIVE}


@app.post("/api/llm")
async def llm_set(req: Request):
    v = (await req.json()).get("id", "")
    if v not in {o["id"] for o in llm_get()["options"]}:
        raise HTTPException(400, "no such engine")
    if jobs_running():
        raise HTTPException(409, "정리 중인 노트가 끝난 뒤에 바꿀 수 있어요")
    if v.startswith("local:"):
        try:
            ENG.set_preset(v[6:])
        except RuntimeError:
            raise HTTPException(409, "정리 중인 노트가 끝난 뒤에 바꿀 수 있어요")
    elif ENG.llm.running():
        ENG.llm.stop()   # a cloud engine needs no local model: free the GPU
    s = rj(SETTINGS, {}) or {}
    s["llm"] = v
    wj(SETTINGS, s)
    return {"current": v}


@app.get("/api/sessions")
def list_sessions():
    out = []
    for d in DATA.iterdir():
        m = rj(d / "meta.json", None)
        if m:
            out.append(m)
    return sorted(out, key=lambda m: m.get("created", 0), reverse=True)


@app.get("/api/search")
def search(q: str):
    q = q.strip().lower()
    if len(q) < 1:
        return []
    hits = []

    def snip(t, i):
        return ("…" if i > 30 else "") + t[max(0, i - 30): i + len(q) + 60] + "…"

    for d in DATA.iterdir():
        m = rj(d / "meta.json", None)
        if not m:
            continue
        base = {"id": m["id"], "title": m["title"], "created": m.get("created", 0)}
        if q in m["title"].lower():
            hits.append({**base, "where": "제목", "text": m["title"]})
        for s in rj(d / "segments.json", []):
            for field in ("text", "en"):
                t = s.get(field) or ""
                i = t.lower().find(q)
                if i >= 0:
                    hits.append({**base, "where": "원고", "text": snip(t, i), "start": s["start"]})
                    break
        final = rj(d / "final.json", None)
        if final and not any(h["id"] == m["id"] and h["where"] == "원고" for h in hits):
            for p in final["paragraphs"]:
                i = p["text"].lower().find(q)
                if i >= 0:
                    hits.append({**base, "where": "화자별 원고", "text": snip(p["text"], i)})
        for name, label in (("summary.md", "요약"), ("translation.md", "번역")):
            t = rtext(d / name) or ""
            i = t.lower().find(q)
            if i >= 0:
                hits.append({**base, "where": label, "text": snip(t, i)})
        for mat in rj(d / "materials.json", []):
            for pno, t in enumerate(mat["pages"], 1):
                i = t.lower().find(q)
                if i >= 0:
                    hits.append({**base, "where": f"자료 {mat['name']} p.{pno}", "text": snip(t, i)})
                    break
    hits.sort(key=lambda h: h["created"], reverse=True)
    return hits[:80]


@app.post("/api/sessions")
async def create_session(req: Request):
    try:
        body = await req.json() if (await req.body()) else {}
    except ValueError:
        raise HTTPException(400, "요청 본문이 UTF-8 JSON이 아니에요")
    sid = uuid.uuid4().hex[:12]
    (DATA / sid).mkdir()
    now = time.time()
    m = {"id": sid, "title": body.get("title") or time.strftime("%Y-%m-%d %H:%M 노트", time.localtime(now)),
         "terms": body.get("terms", ""), "created": now, "updated": now, "status": "new", "duration": 0}
    wj(DATA / sid / "meta.json", m)
    return m


@app.get("/api/sessions/{sid}")
def get_session(sid: str):
    d = sdir(sid)
    m = meta(sid)
    m["duration"] = duration(sid)
    mats = [{"id": x["id"], "name": x["name"], "kind": x["kind"], "pages": x["pages"]} for x in materials(sid)]
    return {"meta": m, "segments": rj(d / "segments.json", []), "final": rj(d / "final.json", None),
            "summary": rtext(d / "summary.md"), "translation": rtext(d / "translation.md"),
            "qa": rj(d / "qa.json", []), "materials": mats, "study": rj(d / "study.json", None)}


@app.patch("/api/sessions/{sid}")
async def patch_session(sid: str, req: Request):
    body = await req.json()
    return set_meta(sid, **{k: v for k, v in body.items() if k in ("title", "terms")})


@app.delete("/api/sessions/{sid}")
def delete_session(sid: str):
    d = sdir(sid)
    if lock_for(sid).locked():
        raise HTTPException(409, "작업 중인 노트는 지울 수 없어요")
    shutil.rmtree(d)
    return {"ok": True}


# ---- editing
@app.patch("/api/sessions/{sid}/segments/{i}")
async def edit_segment(sid: str, i: int, req: Request):
    d = sdir(sid)
    segs = rj(d / "segments.json", [])
    if not 0 <= i < len(segs):
        raise HTTPException(404, "no such segment")
    segs[i]["text"] = (await req.json())["text"].strip()
    segs[i]["edited"] = True
    wj(d / "segments.json", segs)
    return segs[i]


@app.patch("/api/sessions/{sid}/final/{i}")
async def edit_paragraph(sid: str, i: int, req: Request):
    d = sdir(sid)
    final = rj(d / "final.json", None)
    if not final or not 0 <= i < len(final["paragraphs"]):
        raise HTTPException(404, "no such paragraph")
    body = await req.json()
    if "text" in body:
        final["paragraphs"][i]["text"] = body["text"].strip()
    if "speaker" in body:
        final["paragraphs"][i]["speaker"] = max(0, int(body["speaker"]))
    wj(d / "final.json", final)
    return final["paragraphs"][i]


@app.put("/api/sessions/{sid}/summary")
async def edit_summary(sid: str, req: Request):
    d = sdir(sid)
    (d / "summary.md").write_text((await req.json())["text"], encoding="utf-8")
    return {"ok": True}


# ---- recording
@app.post("/api/sessions/{sid}/chunk")
async def add_chunk(sid: str, req: Request, start: float, translate: int = 0):
    """Body: little-endian int16 mono 16 kHz PCM. Appends audio and returns the live segment."""
    d = sdir(sid)
    raw = await req.body()
    if len(raw) % 2:
        raise HTTPException(400, "odd byte count")
    a = np.frombuffer(raw, dtype="<i2")
    with open(pcm_path(sid), "ab") as f:
        f.write(raw)
    seg = {"start": round(start, 2), "end": round(start + len(a) / SR, 2), "text": ""}
    speech = np.abs(a).max(initial=0) > SILENCE_PEAK and speech_ratio(a) >= MIN_SPEECH_RATIO  # skip (near-)silence
    queued = False
    if speech and not engine_ready():
        queued = True  # engine off or warming up: keep recording, transcribe this chunk once it is ready
    elif speech:
        try:
            seg["text"] = await run_in_threadpool(chunk_text, a, bool(translate), seg)
        except (requests.RequestException, RuntimeError):
            queued = True
    if queued:
        start_engine()
        item = {"start": seg["start"], "end": seg["end"], "translate": bool(translate)}
        update_meta(sid, lambda m: m.setdefault("pending", []).append(item))
        seg["pending"] = True
    elif seg["text"]:
        add_segment(sid, seg)
    set_meta(sid, status="recording", duration=duration(sid))
    return seg


AUDIO_EN_PROMPT = "Translate the speech into English. Output only the English translation."


def chunk_text(a: np.ndarray, translate: bool, seg: dict) -> str:
    text = collapse_repeats(strip_special(transcribe(a, asr_prompt(False))))
    if text and translate:
        # native: translate the speech itself, so live translation needs no text engine while recording
        seg["en"] = strip_special(transcribe(a, AUDIO_EN_PROMPT)) if NATIVE else to_english(text, 400)
    return text


def backlog_worker():
    """Transcribe chunks that were recorded while the engine was off/warming, oldest first."""
    while True:
        time.sleep(3)
        try:
            if not engine_ready():
                continue
            for d in sorted(DATA.iterdir()):
                m = rj(d / "meta.json", None)
                if not m or not m.get("pending"):
                    continue
                sid = m["id"]
                while True:
                    pend = meta(sid).get("pending") or []
                    if not pend:
                        break
                    item = pend[0]
                    seg = {"start": item["start"], "end": item["end"], "text": ""}
                    try:
                        seg["text"] = chunk_text(read_pcm(sid, item["start"], item["end"]), item.get("translate"), seg)
                    except (requests.RequestException, RuntimeError):
                        break  # engine went away again; retry later
                    if seg["text"]:
                        add_segment(sid, seg)
                    update_meta(sid, lambda mm: mm.__setitem__("pending", [p for p in (mm.get("pending") or [])
                                                                          if abs(p["start"] - item["start"]) > 0.01]))
        except Exception:
            time.sleep(10)


def idle_watcher():
    """Free the GPU after IDLE_OFF_MIN minutes without real use (the app itself keeps running)."""
    while True:
        time.sleep(30)
        try:
            if IDLE_OFF_MIN <= 0 or time.time() - _last_activity < IDLE_OFF_MIN * 60:
                continue
            if jobs_running() or recording_now() or backlog_total():
                continue
            if engine_proc_running():
                stop_engine()
        except Exception:
            pass


def cache_trimmer():
    """Loading the 20 GB model fills WSL's page cache (~10 GB), which WSL keeps from Windows.
    On a 30 GB laptop that starved Windows and the whole WSL VM went down. Drop it once it piles up."""
    # While the engine loads, the cache grows ~0.5 GB/s (3.7 -> 15 GB in 20 s killed WSL), so trim every 2 s then.
    # engine.sh also puts the engine under a cgroup memory.high for the load (mapped model pages drop_caches can't
    # free); once it is ready, lift that so transcription is never throttled (its own memory grows to ~5.3 GB).
    if NATIVE:
        return  # WSL-only problem
    lifted = False
    while True:
        loading = engine_proc_running() and not engine_ready()
        if loading:
            lifted = False
        elif not lifted and engine_ready():
            try:
                Path("/sys/fs/cgroup/meari-engine/memory.high").write_text("max")
            except OSError:
                pass
            lifted = True
        time.sleep(2 if loading else 20)
        try:
            info = dict(l.split(":", 1) for l in open("/proc/meminfo"))
            cached_mb = int(info["Cached"].split()[0]) // 1024
            if cached_mb > (1024 if loading else 2048):
                os.sync()
                with open("/proc/sys/vm/drop_caches", "w") as f:
                    f.write("1")
        except Exception:
            pass


def resume_interrupted():
    """If the app/WSL went down mid-job, the note is left 'busy' with no worker. Pick those jobs up again."""
    time.sleep(2)
    jobs = {"speakers": (run_finalize, False), "summarizing": (run_summarize,), "waiting": (run_finalize, False),
            "transcribing": (run_finalize, True), "translating": (run_translate,), "studying": (run_study,)}
    for d in DATA.iterdir():
        m = rj(d / "meta.json", None)
        if not m or m.get("status") not in jobs or lock_for(m["id"]).locked():
            continue
        if m["status"] == "transcribing" and not (d / "audio.pcm").exists():
            continue
        target, *args = jobs[m["status"]]
        threading.Thread(target=target, args=(m["id"], *args), daemon=True).start()


if NATIVE:
    ENG.recording_now = recording_now   # recording has priority when the two engines must take turns
    if llm_choice().startswith("local:"):
        ENG.preset = llm_choice()[6:]    # the summary engine chosen last time
threading.Thread(target=backlog_worker, daemon=True).start()
threading.Thread(target=idle_watcher, daemon=True).start()
threading.Thread(target=cache_trimmer, daemon=True).start()
threading.Thread(target=resume_interrupted, daemon=True).start()


@app.post("/api/sessions/{sid}/finalize")
def finalize(sid: str, request: Request):
    sdir(sid)
    set_meta(sid, lang=req_lang(request))
    if duration(sid) < 1:
        raise HTTPException(400, "녹음된 소리가 없어요")
    set_meta(sid, duration=duration(sid))
    if not has_signal(sid):
        # a muted mic records digital silence; the model would invent text ("The.") from it
        msg = "녹음에 소리가 전혀 없어요. 마이크가 음소거되어 있었던 것 같아요 (Windows 설정 > 시스템 > 소리 > 입력, 또는 키보드 마이크 키)."
        set_meta(sid, status="error", error=msg, progress=None)
        raise HTTPException(400, msg)
    return start_job(sid, "speakers", run_finalize, False)


@app.post("/api/sessions/{sid}/upload")
async def upload(sid: str, file: UploadFile, request: Request):
    d = sdir(sid)
    set_meta(sid, lang=req_lang(request))
    src = d / ("upload" + Path(file.filename or "a").suffix[:8])

    def convert():
        with open(src, "wb") as f:
            shutil.copyfileobj(file.file, f)
        return subprocess.run([FFMPEG, "-loglevel", "error", "-y", "-i", str(src), "-ac", "1", "-ar", str(SR),
                               "-f", "s16le", str(pcm_path(sid))], capture_output=True, text=True,
                              creationflags=0x08000000 if os.name == "nt" else 0)  # no console window on Windows
    r = await run_in_threadpool(convert)
    src.unlink(missing_ok=True)
    if r.returncode:
        raise HTTPException(400, "오디오를 읽을 수 없어요: " + r.stderr[-300:])
    set_meta(sid, duration=duration(sid), source=file.filename)
    return start_job(sid, "transcribing", run_finalize, True)


# ---- derived content
@app.post("/api/sessions/{sid}/summarize")
def summarize_note(sid: str, request: Request):
    """Make (or remake) the summary note from the transcript, with the summary engine chosen now."""
    sdir(sid)
    if not transcript_text(sid).strip():
        raise HTTPException(400, "원고가 아직 없어요")
    set_meta(sid, lang=req_lang(request))
    return start_job(sid, "summarizing", run_summarize)


@app.post("/api/sessions/{sid}/translate")
def translate(sid: str):
    sdir(sid)
    return start_job(sid, "translating", run_translate)


@app.post("/api/sessions/{sid}/study")
def study(sid: str, request: Request):
    sdir(sid)
    if not transcript_text(sid).strip():
        raise HTTPException(400, "원고가 아직 없어요")
    set_meta(sid, lang=req_lang(request))
    return start_job(sid, "studying", run_study)


@app.post("/api/sessions/{sid}/ask")
async def ask(sid: str, req: Request):
    d = sdir(sid)
    q = (await req.json()).get("question", "").strip()
    if not q:
        raise HTTPException(400, "질문이 비어 있어요")
    if NATIVE and not llm_is_cloud() and not ENG.llm.ready():
        if not ENG.ensure("llm"):
            raise HTTPException(409, "녹음이 끝나면 답할 수 있어요")
        raise HTTPException(503, "질문에 답할 엔진을 켜는 중이에요(약 20초). 준비되면 다시 질문해 주세요.")
    if not NATIVE and not engine_ready():
        start_engine()
        raise HTTPException(503, "엔진을 켜는 중이에요(약 3분). 준비되면 다시 질문해 주세요.")
    text = transcript_text(sid)[-36000:]
    mats = materials_text(sid, 6000)
    qa = rj(d / "qa.json", [])
    history = []
    for x in qa[-4:]:
        history += [{"role": "user", "content": x["q"]}, {"role": "assistant", "content": x["a"]}]
    if req_lang(req) == "en":
        sys = ("You answer questions about the transcript below (it may be in Korean). Answer concisely in English. "
               "If something is not in the transcript, say so first, then add general knowledge clearly marked as such."
               + (f"\n\nLecture material:\n{mats}" if mats else "") + "\n\nTranscript:\n" + text)
    else:
        sys = ("너는 아래 녹취록 내용에 대해 답하는 조수다. 한국어로 간결하게 답하고, 녹취록에 없는 내용이면 없다고 말한 뒤 일반 지식은 구분해서 덧붙인다."
               + (f"\n\n강의 자료:\n{mats}" if mats else "") + "\n\n녹취록:\n" + text)
    ans = strip_special(await run_in_threadpool(chat, [{"role": "system", "content": sys}] + history + [{"role": "user", "content": q}], 1500, 0.3))
    if req_lang(req) == "en":
        ans = await run_in_threadpool(ensure_english_md, ans)
    qa.append({"q": q, "a": ans, "t": time.time()})
    wj(d / "qa.json", qa)
    return {"q": q, "a": ans}


# ---- lecture materials
@app.post("/api/sessions/{sid}/materials")
async def add_material(sid: str, file: UploadFile):
    d = sdir(sid)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in MATERIAL_EXT:
        raise HTTPException(400, "PDF, PPTX, TXT, MD 파일만 올릴 수 있어요")
    mid = uuid.uuid4().hex[:8]
    (d / "materials").mkdir(exist_ok=True)
    path = d / "materials" / f"{mid}{ext}"

    def save_and_extract():
        with open(path, "wb") as f:
            shutil.copyfileobj(file.file, f)
        return extract_pages(path)
    try:
        pages = await run_in_threadpool(save_and_extract)
    except Exception as ex:
        path.unlink(missing_ok=True)
        raise HTTPException(400, f"자료를 읽을 수 없어요: {ex}")
    mats = materials(sid)
    mats.append({"id": mid, "name": file.filename, "kind": ext[1:], "file": path.name, "pages": pages})
    wj(d / "materials.json", mats)
    await run_in_threadpool(link_materials, sid)
    return {"id": mid, "pages": len(pages), "textless": sum(1 for p in pages if not p)}


@app.get("/api/sessions/{sid}/materials/{mid}/file")
def material_file(sid: str, mid: str):
    d = sdir(sid)
    for m in materials(sid):
        if m["id"] == mid:
            return FileResponse(d / "materials" / m["file"], filename=m["name"],
                                content_disposition_type="inline")
    raise HTTPException(404, "no such material")


@app.delete("/api/sessions/{sid}/materials/{mid}")
def delete_material(sid: str, mid: str):
    d = sdir(sid)
    mats = materials(sid)
    keep = [m for m in mats if m["id"] != mid]
    for m in mats:
        if m["id"] == mid:
            (d / "materials" / m["file"]).unlink(missing_ok=True)
    wj(d / "materials.json", keep)
    link_materials(sid)
    return {"ok": True}


# ---- files
@app.get("/api/sessions/{sid}/audio")
def audio(sid: str):
    p = pcm_path(sid)
    if not p.exists():
        raise HTTPException(404, "no audio")
    return Response(wav_bytes(np.fromfile(p, dtype="<i2")), media_type="audio/wav")


@app.get("/api/sessions/{sid}/export.md")
def export(sid: str, lang: str = "ko"):
    s = get_session(sid)
    m = s["meta"]
    en = lang_of(lang) == "en"
    W = (lambda ko, e: e) if en else (lambda ko, e: ko)
    mins, secs = int(m["duration"] // 60), int(m["duration"] % 60)
    lines = [f"# {m['title']}", "", time.strftime("%Y-%m-%d %H:%M", time.localtime(m["created"])) +
             (f" · {mins} min {secs} s" if en else f" · {mins}분 {secs}초"), ""]
    if s["summary"]:
        lines += [s["summary"], ""]
    lines += [W("## 녹취록", "## Transcript"), ""]
    if s["final"]:
        lines += [f"**{W('화자', 'Speaker')} {p['speaker'] + 1}**: {p['text']}\n" for p in s["final"]["paragraphs"]]
    else:
        lines += [f"`{int(x['start'] // 60):02d}:{int(x['start'] % 60):02d}` {x['text']}" for x in s["segments"]]
    if s["translation"]:
        lines += ["", "## English translation", "", s["translation"]]
    if s["study"] and s["study"]["cards"]:
        lines += ["", W("## 암기카드", "## Flashcards"), ""] + [f"- **{c['front']}** — {c['back']}" for c in s["study"]["cards"]]
    if s["study"] and s["study"]["quiz"]:
        lines += ["", W("## 퀴즈", "## Quiz"), ""]
        for n, q in enumerate(s["study"]["quiz"], 1):
            lines += [f"{n}. {q['q']}"] + [f"   {'ABCDEFG'[k]}) {c}" for k, c in enumerate(q["choices"])] + \
                     [f"   {W('정답', 'Answer')}: {'ABCDEFG'[q['answer']]} — {q.get('explain', '')}", ""]
    if s["qa"]:
        lines += ["", W("## 질문과 답", "## Q&A"), ""] + [f"**Q.** {x['q']}\n\n{x['a']}\n" for x in s["qa"]]
    return PlainTextResponse("\n".join(lines), media_type="text/markdown; charset=utf-8",
                             headers={"Content-Disposition": f"attachment; filename=sorinote-{sid}.md"})


@app.post("/api/shutdown")
def shutdown():
    """Stops the engine and this app (frees ~42 GB of GPU memory)."""
    stop_engine()
    threading.Timer(0.5, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
    return {"ok": True}


app.mount("/", StaticFiles(directory=APP_DIR / "static", html=True), name="static")
