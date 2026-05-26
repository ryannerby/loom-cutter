"""Thread-runnable wrapper around the pipeline for drag-drop imports.

Writes status.json at each stage so the UI can poll progress without
needing to scrape stdout or wait on the upload response.
"""
from __future__ import annotations

import json
import os
import re
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path

# Order matters — used both for running and for UI progress labels.
STAGES = [
    "transcribing",
    "extracting_peaks",
    "detecting_silences",
    "llm_edit",
    "snapping",
    "ready",
]


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_status(project_dir: Path, stage: str, error: str | None = None) -> None:
    status = {
        "stage": stage,
        "error": error,
        "stage_at": _utcnow(),
    }
    existing = project_dir / "status.json"
    if existing.exists():
        try:
            prior = json.loads(existing.read_text())
            status.setdefault("started_at", prior.get("started_at", status["stage_at"]))
        except Exception:
            status["started_at"] = status["stage_at"]
    else:
        status["started_at"] = status["stage_at"]
    existing.write_text(json.dumps(status, indent=2))


def read_status(project_dir: Path) -> dict | None:
    p = project_dir / "status.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-")
    return s[:50] or "loom"


def unique_project_id(base: str, projects_dir: Path) -> str:
    candidate = base
    i = 2
    while (projects_dir / candidate).exists():
        candidate = f"{base}-{i}"
        i += 1
    return candidate


def run_pipeline_threaded(source_path: Path) -> threading.Thread:
    """Spawn a daemon thread that runs the pipeline. Returns immediately."""
    thread = threading.Thread(
        target=_run_pipeline,
        args=(source_path,),
        daemon=True,
        name=f"pipeline-{source_path.parent.name}",
    )
    thread.start()
    return thread


def _run_pipeline(source_path: Path) -> None:
    project_dir = source_path.parent
    # Lazy imports — keep server startup fast (Whisper model loads on first transcribe).
    from pipeline import (
        edit_llm,
        silences,
        snap_silence,
        transcribe,
        waveform,
    )

    try:
        write_status(project_dir, "transcribing")
        transcribe.run(source_path, "medium")

        write_status(project_dir, "extracting_peaks")
        waveform.run(project_dir / "audio.wav")

        write_status(project_dir, "detecting_silences")
        silences.run(project_dir / "audio.wav")

        write_status(project_dir, "llm_edit")
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise RuntimeError("ANTHROPIC_API_KEY not set in server environment")
        edit_llm.run(project_dir / "words.json")

        write_status(project_dir, "snapping")
        snap_silence.run(project_dir)

        write_status(project_dir, "ready")
    except Exception as e:
        traceback.print_exc()
        write_status(project_dir, "error", error=str(e))
