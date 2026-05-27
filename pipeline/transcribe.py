"""Faster-whisper transcription with word-level timestamps.

Extracts mono 16kHz WAV from a source video with ffmpeg, runs faster-whisper,
writes words.json next to the source. Source MP4 is never written to.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from faster_whisper import WhisperModel


def extract_audio(video_path: Path, audio_path: Path) -> None:
    result = subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i", str(video_path),
            "-ac", "1",
            "-ar", "16000",
            "-vn",
            str(audio_path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise RuntimeError(f"ffmpeg failed (exit {result.returncode})")


def transcribe(audio_path: Path, model_size: str = "medium") -> dict:
    # int8 on CPU is the fast path on Apple Silicon; ctranslate2 has no MPS backend.
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    # VAD filter (Silero) skips silent regions before sending to Whisper.
    # For a Loom that's typically ~50% pauses, this roughly halves transcribe
    # time with zero accuracy loss on the speech portions. min_silence_duration
    # of 300ms ensures we don't skip natural inter-word gaps.
    segments_iter, info = model.transcribe(
        str(audio_path),
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
    )

    words: list[dict] = []
    text_parts: list[str] = []
    for segment in segments_iter:
        text_parts.append(segment.text)
        if segment.words:
            for w in segment.words:
                words.append({
                    "word": w.word,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "probability": round(w.probability, 3),
                })

    return {
        "model": model_size,
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 3),
        "text": "".join(text_parts).strip(),
        "words": words,
    }


def run(video_path: Path, model_size: str = "medium") -> Path:
    project_dir = video_path.parent
    audio_path = project_dir / "audio.wav"
    out_path = project_dir / "words.json"

    print(f"[1/2] Extracting audio → {audio_path.name}")
    t0 = time.time()
    extract_audio(video_path, audio_path)
    print(f"      {time.time() - t0:.1f}s")

    print(f"[2/2] Transcribing with faster-whisper ({model_size})")
    t0 = time.time()
    result = transcribe(audio_path, model_size)
    elapsed = time.time() - t0
    rtf = elapsed / result["duration"] if result["duration"] else 0
    print(
        f"      {elapsed:.1f}s for {result['duration']:.1f}s of audio "
        f"(realtime factor {rtf:.2f}× — language={result['language']} "
        f"p={result['language_probability']:.2f}, {len(result['words'])} words)"
    )

    out_path.write_text(json.dumps(result, indent=2))
    print(f"      → {out_path}")
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("video", type=Path, help="path to source MP4")
    parser.add_argument(
        "--model",
        default="medium",
        choices=["tiny", "base", "small", "medium", "large-v3"],
    )
    args = parser.parse_args()
    if not args.video.exists():
        sys.exit(f"error: {args.video} does not exist")
    run(args.video, args.model)


if __name__ == "__main__":
    main()
