"""FastAPI backend for the Loom Cutter review UI.

Endpoints:
    GET  /api/projects                  → list projects under projects/
    GET  /api/projects/{id}             → all state for one project
    POST /api/projects/{id}/cuts        → save cuts.json (+ snapshot to cuts.history/)
    POST /api/projects/{id}/render      → re-render output.mp4
    GET  /api/projects/{id}/source.mp4  → stream the source video (range supported)
    GET  /api/projects/{id}/output.mp4  → stream the rendered output

The UI lives at /ui/* (Vite dev proxies, or static-served once built).
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from pipeline import render as render_pipeline
from server import import_pipeline

ROOT = Path(__file__).resolve().parent.parent
PROJECTS_DIR = ROOT / "projects"
UI_DIST = ROOT / "ui" / "dist"

app = FastAPI(title="Loom Cutter")

# CORS so Vite dev server (5173) can hit us at 8000.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _project_dir(project_id: str) -> Path:
    # Defense-in-depth — keep the id path-safe.
    if "/" in project_id or ".." in project_id or project_id.startswith("."):
        raise HTTPException(400, "invalid project id")
    d = PROJECTS_DIR / project_id
    if not d.is_dir():
        raise HTTPException(404, f"project not found: {project_id}")
    return d


def _read_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception as e:
        raise HTTPException(500, f"failed to parse {path.name}: {e}")


@app.get("/api/projects")
def list_projects():
    if not PROJECTS_DIR.exists():
        return {"projects": []}
    items = []
    for d in sorted(PROJECTS_DIR.iterdir()):
        if not d.is_dir() or d.name.startswith("."):
            continue
        source = d / "source.mp4"
        if not source.exists():
            continue
        items.append({
            "id": d.name,
            "has_words": (d / "words.json").exists(),
            "has_cuts": (d / "cuts.json").exists(),
            "has_output": (d / "output.mp4").exists(),
        })
    return {"projects": items}


@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    d = _project_dir(project_id)
    words_data = _read_json(d / "words.json", {})
    status = import_pipeline.read_status(d)
    # "ready" means the pipeline completed *or* this is a project that
    # predates the status.json era and already has all artifacts.
    has_all = (d / "words.json").exists() and (d / "cuts.json").exists() and (d / "peaks.json").exists()
    if status is None and has_all:
        status = {"stage": "ready", "error": None}
    return {
        "id": project_id,
        "duration": words_data.get("duration", 0),
        "language": words_data.get("language"),
        "words": words_data.get("words", []),
        "text": words_data.get("text", ""),
        "cuts": _read_json(d / "cuts.json", []),
        "silences": _read_json(d / "silences.json", {"silences": []}).get("silences", []),
        "peaks": _read_json(d / "peaks.json", {"peaks": [], "n": 0}),
        "has_output": (d / "output.mp4").exists(),
        "status": status,
    }


@app.post("/api/projects/import")
async def import_project(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "missing filename")
    if not file.filename.lower().endswith((".mp4", ".mov", ".m4v", ".webm")):
        raise HTTPException(400, "expected an MP4/MOV/M4V/WebM file")

    base = import_pipeline.slugify(Path(file.filename).stem)
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    project_id = import_pipeline.unique_project_id(base, PROJECTS_DIR)
    project_dir = PROJECTS_DIR / project_id
    project_dir.mkdir(parents=True)

    source_path = project_dir / "source.mp4"
    written = 0
    with source_path.open("wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            out.write(chunk)
            written += len(chunk)

    # Mark "uploaded, pipeline starting" so the UI sees a status immediately.
    import_pipeline.write_status(project_dir, "transcribing")
    import_pipeline.run_pipeline_threaded(source_path)
    return {"id": project_id, "size": written, "status": "processing"}


@app.post("/api/projects/{project_id}/cuts")
async def save_cuts(project_id: str, request: Request):
    d = _project_dir(project_id)
    body = await request.json()
    if not isinstance(body, list):
        raise HTTPException(400, "expected a JSON array of cuts")

    cuts_path = d / "cuts.json"
    # Snapshot prior state for undo.
    if cuts_path.exists():
        history = d / "cuts.history"
        history.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        (history / f"cuts-{stamp}.json").write_bytes(cuts_path.read_bytes())
        snaps = sorted(history.glob("cuts-*.json"))
        for old in snaps[:-50]:
            old.unlink()

    cuts_path.write_text(json.dumps(body, indent=2))
    return {"ok": True, "count": len(body)}


@app.post("/api/projects/{project_id}/render")
async def render_project(project_id: str, request: Request):
    d = _project_dir(project_id)
    source = d / "source.mp4"
    cuts = d / "cuts.json"
    if not cuts.exists():
        raise HTTPException(400, "no cuts.json — nothing to render")
    # Optional render settings posted from the UI's settings overlay.
    voice_enhance = True
    color_preset = "natural"
    body = await request.body()
    if body:
        try:
            data = json.loads(body)
            voice_enhance = bool(data.get("voiceEnhance", True))
            requested = data.get("colorPreset", "natural")
            if requested in ("natural", "warm", "vivid"):
                color_preset = requested
        except Exception:
            pass  # malformed body → defaults
    output = render_pipeline.run(
        source, cuts, enhance_voice=voice_enhance, color_preset=color_preset
    )
    return {"ok": True, "output": output.name, "size": os.path.getsize(output)}


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: str):
    """Hard-delete a project directory. The user explicitly confirmed via the
    UI before this endpoint fires. Safety: ID is validated by _project_dir()
    (no traversal), and we refuse to delete anything outside projects/."""
    d = _project_dir(project_id)
    # Defense in depth — the dir we're about to remove must be a direct child
    # of PROJECTS_DIR.
    if d.parent.resolve() != PROJECTS_DIR.resolve():
        raise HTTPException(400, "refusing to delete: project outside projects/")
    import shutil
    shutil.rmtree(d)
    return {"ok": True, "deleted": project_id}


@app.post("/api/projects/{project_id}/cancel-render")
def cancel_render(project_id: str):
    """Kill an in-flight render. Returns ok:false if nothing was running."""
    _ = _project_dir(project_id)
    ok = render_pipeline.cancel(project_id)
    return {"ok": ok}


@app.post("/api/projects/{project_id}/reveal")
def reveal_output(project_id: str):
    """Open Finder with the rendered output selected, ready to drag into Loom."""
    d = _project_dir(project_id)
    # Prefer the Downloads mirror — that's where Loom's upload dialog opens
    # by default. Fall back to the canonical project output.
    mirror = Path.home() / "Downloads" / "looms-cut" / f"{project_id}.mp4"
    project_copy = d / "output.mp4"
    target = mirror if mirror.exists() else project_copy
    if not target.exists():
        raise HTTPException(404, "no render found — hit Render first")
    # `open -R <file>` reveals the file selected in Finder (macOS).
    import subprocess
    subprocess.run(["open", "-R", str(target)], check=False)
    return {"ok": True, "path": str(target)}


@app.get("/api/projects/{project_id}/source.mp4")
def serve_source(project_id: str):
    d = _project_dir(project_id)
    return FileResponse(d / "source.mp4", media_type="video/mp4")


@app.get("/api/projects/{project_id}/output.mp4")
def serve_output(project_id: str):
    d = _project_dir(project_id)
    p = d / "output.mp4"
    if not p.exists():
        raise HTTPException(404, "no rendered output yet")
    return FileResponse(p, media_type="video/mp4")


@app.get("/api/health")
def health():
    return {"ok": True}


# Production: serve the built UI from ui/dist/ at the root. In dev (no
# dist/ yet), the user runs Vite separately on :5173 and the / route falls
# back to the JSON status response below.
if UI_DIST.exists():
    @app.get("/")
    def serve_index():
        return FileResponse(UI_DIST / "index.html")

    app.mount("/", StaticFiles(directory=str(UI_DIST), html=True), name="ui")
else:
    @app.get("/")
    def root():
        return JSONResponse({
            "name": "loom-cutter",
            "mode": "dev — Vite expected on :5173",
            "ui": "http://localhost:5173",
            "endpoints": ["/api/projects", "/api/projects/{id}", "/api/health"],
        })
