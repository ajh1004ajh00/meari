"""Text model through a subscription CLI instead of a local engine (no API keys).

- claude: Claude Code CLI (`claude -p`), signed in with a Claude subscription. Called lean: own system prompt,
  no tools, no settings/MCP, no saved session - so each request only carries the note text.
- codex:  Codex CLI (`codex exec`), signed in with a ChatGPT subscription, read-only sandbox, ephemeral.

The transcript leaves this PC when one of these is chosen; the app says so where it is chosen.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

NW = 0x08000000 if os.name == "nt" else 0
CLAUDE = os.environ.get("MEARI_CLAUDE_CMD") or shutil.which("claude.cmd") or shutil.which("claude") or "claude"
CODEX = os.environ.get("MEARI_CODEX_CMD") or shutil.which("codex.cmd") or shutil.which("codex") or "codex"
# an empty working folder, so the CLIs pick up no project files or instructions
WORK = Path(tempfile.gettempdir()) / "meari-cli"

CLAUDE_MODELS = {"sonnet": "Claude Sonnet 5.5", "opus": "Claude Opus 5.5"}


def _split(messages) -> tuple[str, str]:
    """System text, and the rest of the conversation as one prompt (Q&A history becomes plain text)."""
    system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
    turns = [m for m in messages if m["role"] != "system"]
    if len(turns) == 1:
        return system, turns[0]["content"]
    hist = "\n\n".join(("Q: " if m["role"] == "user" else "A: ") + m["content"] for m in turns[:-1])
    return system, f"Earlier questions and answers:\n{hist}\n\nNew question:\n{turns[-1]['content']}"


def _run(cmd: list[str], stdin: str, timeout: float) -> subprocess.CompletedProcess:
    WORK.mkdir(exist_ok=True)
    return subprocess.run(cmd, input=stdin, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, cwd=WORK, creationflags=NW)


def claude_chat(messages, model: str = "sonnet", timeout: float = 900) -> str:
    system, prompt = _split(messages)
    r = _run([CLAUDE, "-p", "--output-format", "json", "--model", model,
              "--system-prompt", system or "You are a careful assistant.", "--tools", "", "--setting-sources", "",
              "--strict-mcp-config", "--no-session-persistence"], prompt, timeout)
    try:
        j = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"Claude Code CLI failed: {(r.stderr or r.stdout)[-300:]}")
    if j.get("is_error") or j.get("subtype") != "success":
        raise RuntimeError(f"Claude Code CLI: {str(j.get('result') or j.get('subtype'))[:300]}")
    return j.get("result") or ""


def codex_chat(messages, model: str = "", timeout: float = 900) -> str:
    system, prompt = _split(messages)
    full = (f"Instructions:\n{system}\n\n" if system else "") + prompt
    out = WORK / f"codex-{os.getpid()}-{id(messages)}.txt"
    cmd = [CODEX, "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--color", "never",
           "--output-last-message", str(out)]
    if model:
        cmd += ["--model", model]
    r = _run(cmd + ["-"], full, timeout)   # "-": read the prompt from stdin (transcripts exceed the command-line limit)
    try:
        text = out.read_text(encoding="utf-8")
    except OSError:
        raise RuntimeError(f"Codex CLI failed: {(r.stderr or r.stdout)[-300:]}")
    finally:
        out.unlink(missing_ok=True)
    return text


def available() -> dict[str, bool]:
    return {"claude": bool(shutil.which(CLAUDE) or Path(CLAUDE).exists()), "codex": bool(shutil.which(CODEX) or Path(CODEX).exists())}
