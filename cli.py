"""Loom Cutter — v0 CLI.

Usage:
    python cli.py projects/test-01/source.mp4

Pipeline:
    1. transcribe   → words.json
    2. silences     → silences.json   (ffmpeg amplitude analysis)
    3. edit_llm     → llm_cuts.json   (semantic cuts: repeats + false starts)
    4. snap_silence → cuts.json       (merge + boundary-snap)
    5. render       → output.mp4

Each stage is skipped if its output exists. Use --force to redo everything.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from pipeline import edit_llm, render, silences, snap_silence, transcribe


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--model", default="medium")
    parser.add_argument("--llm-model", default=edit_llm.MODEL)
    parser.add_argument("--noise-db", type=float, default=silences.DEFAULT_NOISE_DB)
    parser.add_argument("--min-silence", type=float, default=silences.DEFAULT_MIN_DURATION)
    parser.add_argument("--snap-tolerance", type=float, default=snap_silence.SNAP_TOLERANCE)
    parser.add_argument("--inset", type=float, default=snap_silence.INSET_MARGIN,
                        help="seconds of audio to keep inside each cut boundary")
    parser.add_argument("--force", action="store_true", help="redo every stage")
    parser.add_argument("--from", dest="from_stage", default=None,
                        choices=["transcribe", "silences", "edit_llm", "snap", "render"],
                        help="force-redo from this stage onward")
    parser.add_argument("--skip-render", action="store_true")
    args = parser.parse_args()

    if not args.source.exists():
        sys.exit(f"error: {args.source} does not exist")

    project_dir = args.source.parent
    words_path = project_dir / "words.json"
    audio_path = project_dir / "audio.wav"
    silences_path = project_dir / "silences.json"
    llm_cuts_path = project_dir / "llm_cuts.json"
    cuts_path = project_dir / "cuts.json"
    output_path = project_dir / "output.mp4"

    stages = ["transcribe", "silences", "edit_llm", "snap", "render"]
    force_from = stages.index(args.from_stage) if args.from_stage else (0 if args.force else len(stages))

    def should_run(stage: str, output: Path) -> bool:
        return stages.index(stage) >= force_from or not output.exists()

    if should_run("transcribe", words_path):
        transcribe.run(args.source, args.model)
    else:
        print(f"[skip transcribe] {words_path.name} exists")

    if should_run("silences", silences_path):
        silences.run(audio_path, args.noise_db, args.min_silence)
    else:
        print(f"[skip silences] {silences_path.name} exists")

    if should_run("edit_llm", llm_cuts_path):
        edit_llm.run(words_path, args.llm_model)
    else:
        print(f"[skip edit_llm] {llm_cuts_path.name} exists")

    if should_run("snap", cuts_path):
        snap_silence.run(project_dir, args.snap_tolerance, args.inset)
    else:
        print(f"[skip snap] {cuts_path.name} exists")

    if args.skip_render:
        return

    if should_run("render", output_path):
        render.run(args.source, cuts_path)
    else:
        print(f"[skip render] {output_path.name} exists")


if __name__ == "__main__":
    main()
