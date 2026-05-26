"""Waveform peak extraction.

Reads audio.wav, computes peak amplitudes for ~2000 buckets across the file,
writes peaks.json. The UI uses this to draw the speech-envelope SVG path.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

DEFAULT_BUCKETS = 5000  # bumped from 2000 so the waveform has useful detail at high zoom (50×)


def extract_peaks(audio_path: Path, n_buckets: int = DEFAULT_BUCKETS) -> dict:
    # Pipe raw 16-bit signed mono PCM out of ffmpeg.
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel", "error",
        "-i", str(audio_path),
        "-ac", "1",
        "-ar", "16000",
        "-f", "s16le",
        "-c:a", "pcm_s16le",
        "-",
    ]
    result = subprocess.run(cmd, capture_output=True, check=True)
    samples = np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    duration = len(samples) / 16000.0

    if len(samples) == 0:
        return {"duration": 0.0, "n": 0, "peaks": []}

    # Bucket: per-bucket peak (RMS would smear; peak shows syllable pinch-zeros).
    bucket_size = max(1, len(samples) // n_buckets)
    usable = (len(samples) // bucket_size) * bucket_size
    reshaped = np.abs(samples[:usable]).reshape(-1, bucket_size)
    peaks = reshaped.max(axis=1)
    # Normalize peaks against the loudest, with a floor so quiet syllables show.
    pmax = float(peaks.max()) if peaks.size else 1.0
    if pmax > 0:
        peaks = peaks / pmax
    # Round to 3 decimals for tighter JSON.
    return {
        "duration": round(duration, 3),
        "n": int(peaks.size),
        "peaks": [round(float(p), 3) for p in peaks],
    }


def run(audio_path: Path, n_buckets: int = DEFAULT_BUCKETS) -> Path:
    project_dir = audio_path.parent
    out_path = project_dir / "peaks.json"

    print(f"[peaks] {audio_path.name} → {n_buckets} buckets")
    t0 = time.time()
    data = extract_peaks(audio_path, n_buckets)
    print(f"        {time.time() - t0:.1f}s — {data['n']} buckets across {data['duration']:.1f}s")
    out_path.write_text(json.dumps(data))  # no indent — keep this small
    print(f"        → {out_path}")
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("audio", type=Path)
    parser.add_argument("--buckets", type=int, default=DEFAULT_BUCKETS)
    args = parser.parse_args()
    if not args.audio.exists():
        sys.exit(f"error: {args.audio} does not exist")
    run(args.audio, args.buckets)


if __name__ == "__main__":
    main()
