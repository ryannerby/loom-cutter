"""Waveform-based silence detection via ffmpeg's silencedetect filter.

Whisper's word-end timestamps are unreliable for measuring true silence —
the model stretches/truncates them to phoneme boundaries. This pass runs
actual amplitude analysis on audio.wav and writes silences.json.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

# Default tuning. -30dB catches all genuine inter-phrase pauses (including
# breath/room-tone valleys around -28dB to -33dB). Trailing consonants
# ('s'/'t'/'f') that decay through this range are still preserved because
# snap_silence keeps a 150ms inset on each cut boundary — so silencedetect's
# silence_start can mark mid-decay, and we still keep enough of the tail.
# Min duration of 0.35s catches shorter inter-phrase gaps that 0.5s missed.
DEFAULT_NOISE_DB = -30.0
DEFAULT_MIN_DURATION = 0.35  # seconds


def detect(audio_path: Path, noise_db: float = DEFAULT_NOISE_DB,
           min_duration: float = DEFAULT_MIN_DURATION) -> list[dict]:
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-nostats",
        "-i", str(audio_path),
        "-af", f"silencedetect=noise={noise_db}dB:duration={min_duration}",
        "-f", "null",
        "-",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr[-2000:])
        raise RuntimeError(f"ffmpeg silencedetect failed (exit {result.returncode})")

    starts = [float(m.group(1)) for m in re.finditer(r"silence_start:\s*([\d.]+)", result.stderr)]
    ends = [
        (float(m.group(1)), float(m.group(2)))
        for m in re.finditer(r"silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)", result.stderr)
    ]

    silences: list[dict] = []
    for i, s in enumerate(starts):
        if i < len(ends):
            e, dur = ends[i]
            silences.append({"start": round(s, 3), "end": round(e, 3), "duration": round(dur, 3)})
    return silences


def run(audio_path: Path, noise_db: float = DEFAULT_NOISE_DB,
        min_duration: float = DEFAULT_MIN_DURATION) -> Path:
    project_dir = audio_path.parent
    out_path = project_dir / "silences.json"

    print(f"[silence] scanning {audio_path.name} (noise<{noise_db}dB, min={min_duration}s)")
    t0 = time.time()
    silences = detect(audio_path, noise_db, min_duration)
    total = sum(s["duration"] for s in silences)
    print(
        f"          {time.time() - t0:.1f}s — {len(silences)} silence region(s), "
        f"total {total:.1f}s of silence"
    )

    out_path.write_text(json.dumps({
        "noise_db": noise_db,
        "min_duration": min_duration,
        "silences": silences,
    }, indent=2))
    print(f"          → {out_path}")
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path, help="path to audio.wav")
    parser.add_argument("--noise-db", type=float, default=DEFAULT_NOISE_DB)
    parser.add_argument("--min-duration", type=float, default=DEFAULT_MIN_DURATION)
    args = parser.parse_args()
    if not args.audio.exists():
        sys.exit(f"error: {args.audio} does not exist")
    run(args.audio, args.noise_db, args.min_duration)


if __name__ == "__main__":
    main()
