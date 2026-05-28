"""Render the final cut MP4.

Reads cuts.json + source.mp4, builds a keep-list by inverting the cuts, and
emits a single concat-filter ffmpeg invocation. Source MP4 is never written to.

v0: straight concat. v2 will add 80ms audio crossfades + zero-crossing snap.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path


def ffprobe_duration(video_path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(video_path),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(result.stdout.strip())


def invert_cuts(cuts: list[dict], duration: float) -> list[tuple[float, float]]:
    """Return the keep-segments (gaps between cuts). Clamps everything to [0, duration]."""
    # Clamp + drop fully-out-of-range cuts before inverting.
    clamped: list[tuple[float, float]] = []
    out_of_range = 0
    for c in cuts:
        s = max(0.0, min(duration, float(c["start"])))
        e = max(0.0, min(duration, float(c["end"])))
        if e - s < 0.01:
            out_of_range += 1
            continue
        clamped.append((s, e))
    if out_of_range:
        print(
            f"         WARNING: {out_of_range} cut(s) were out of range (start/end past "
            f"source duration {duration:.1f}s) — clamped/dropped. LLM accuracy red flag."
        )

    keeps: list[tuple[float, float]] = []
    cursor = 0.0
    for s, e in sorted(clamped):
        if s > cursor:
            keeps.append((cursor, s))
        cursor = max(cursor, e)
    if cursor < duration:
        keeps.append((cursor, duration))
    return [(s, e) for s, e in keeps if e - s > 0.01]


AUDIO_FADE = 0.05  # seconds — fade-in/out applied to each kept segment to kill splice pops

# Radio-voice preset. Designed for "broadcast crisp" — tight, punchy, present.
# Stages, in order:
#   1. highpass 80Hz       — kill rumble, mic-handling, AC hum
#   2. mud cut @ 180Hz     — pull -1.5dB out of the "boxy" zone
#   3. compressor 3:1      — tame loud peaks, lift quiet syllables, +2.5dB makeup
#   4. de-esser @ 6.5kHz   — tame harsh S/T/F sibilance the compressor accentuates
#   5. warmth @ 120Hz      — +1.5dB chest body without muddying
#   6. presence @ 3.5kHz   — +3dB clarity / "forward" feel
#   7. air @ 10kHz         — +2dB sparkle / top-end shimmer
#   8. exciter             — subtle harmonic saturation, the "thick voice" trick
#   9. limiter             — brick wall at -0.45dBFS, kills inter-sample peaks
#  10. loudnorm -14 LUFS   — YouTube / Spotify / podcast LOUD target (was -16 broadcast)
# Module-level registry of in-flight ffmpeg processes by project id.
# Lets the server's /cancel-render endpoint kill an active render
# without complex IPC. Keys are project directory names.
_RUNNING: dict[str, subprocess.Popen] = {}


def cancel(project_id: str) -> bool:
    """Terminate an in-flight render for the given project. Returns True if
    a process was actually killed."""
    proc = _RUNNING.get(project_id)
    if proc is None or proc.poll() is not None:
        return False
    proc.terminate()  # SIGTERM first (lets ffmpeg flush)
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()  # SIGKILL if it doesn't go quietly
    return True


VOICE_ENHANCE_CHAIN = (
    "highpass=f=80,"
    "equalizer=f=180:t=q:w=1.0:g=-1.5,"
    "acompressor=threshold=0.1:ratio=3:attack=5:release=100:makeup=2.5,"
    "deesser=i=0.3:m=0.5:f=0.3,"  # f is normalized 0-1 (0.3 ≈ 6.6kHz @ 44.1kHz)
    "equalizer=f=120:t=q:w=1.2:g=1.5,"
    "equalizer=f=3500:t=q:w=1.4:g=3,"
    "equalizer=f=10000:t=q:w=1.0:g=2,"
    "aexciter=level_in=1:level_out=1:amount=1:drive=2.5,"
    "alimiter=limit=0.95:attack=5:release=50,"
    "loudnorm=I=-14:TP=-1:LRA=7"
)

# Color presets applied AFTER video concat. Subtle adjustments — designed to
# improve out-of-the-box Loom recordings, not to drastically transform.
#   natural — no filter, raw colors
#   warm    — slight red/yellow shift, +5% saturation (cozy / pitch-friendly)
#   vivid   — +25% saturation, +10% contrast, slight gamma punch
COLOR_CHAINS = {
    "natural": None,
    "warm": "eq=saturation=1.05:gamma_r=1.06:gamma_b=0.94",
    "vivid": "eq=saturation=1.25:contrast=1.1:gamma=0.95",
}


def build_filter_complex(
    keeps: list[tuple[float, float]],
    fade: float = AUDIO_FADE,
    enhance: bool = True,
    color_preset: str = "natural",
    audio_delay_ms: int = 0,
) -> str:
    """Filter graph: trim+concat video (+color), trim+fade+concat (+enhance) audio.

    audio_delay_ms: positive delays audio (pads with silence at the start),
    negative advances audio (trims front). Used to compensate for capture-card
    A/V drift before any per-segment cuts happen.
    """
    parts = []
    n = len(keeps)

    # Pre-shift the source audio if a delay is set, then split into N copies
    # so each per-segment atrim has its own stream to consume.
    if audio_delay_ms != 0 and n > 0:
        if audio_delay_ms > 0:
            shift = f"adelay={audio_delay_ms}|{audio_delay_ms}"
        else:
            shift = f"atrim=start={(-audio_delay_ms) / 1000:.3f},asetpts=PTS-STARTPTS"
        split_labels = "".join(f"[sa{i}]" for i in range(n))
        parts.append(f"[0:a]{shift},asplit={n}{split_labels}")
        audio_in = [f"[sa{i}]" for i in range(n)]
    else:
        audio_in = ["[0:a]"] * n

    for i, (s, e) in enumerate(keeps):
        seg_dur = e - s
        f = min(fade, seg_dur / 4)
        parts.append(f"[0:v]trim=start={s:.3f}:end={e:.3f},setpts=PTS-STARTPTS[v{i}]")
        parts.append(
            f"{audio_in[i]}atrim=start={s:.3f}:end={e:.3f},asetpts=PTS-STARTPTS,"
            f"afade=t=in:st=0:d={f:.3f},"
            f"afade=t=out:st={seg_dur - f:.3f}:d={f:.3f}[a{i}]"
        )

    streams = "".join(f"[v{i}][a{i}]" for i in range(len(keeps)))
    # Decide labels per branch based on what postprocessing the user picked.
    color_chain = COLOR_CHAINS.get(color_preset)
    needs_color = color_chain is not None
    video_concat_label = "[concatv]" if needs_color else "[outv]"
    audio_concat_label = "[concata]" if enhance else "[outa]"
    parts.append(
        f"{streams}concat=n={len(keeps)}:v=1:a=1{video_concat_label}{audio_concat_label}"
    )
    if needs_color:
        parts.append(f"[concatv]{color_chain}[outv]")
    if enhance:
        parts.append(f"[concata]{VOICE_ENHANCE_CHAIN}[outa]")
    return ";".join(parts)


def run(source_path: Path, cuts_path: Path, out_path: Path | None = None,
        enhance_voice: bool = True, color_preset: str = "natural",
        audio_delay_ms: int = 0) -> Path:
    project_dir = source_path.parent
    if out_path is None:
        out_path = project_dir / "output.mp4"

    all_cuts = json.loads(cuts_path.read_text())
    # Honor the UI's per-cut active flag — toggled-off proposals are kept,
    # not cut. Default true so older cuts.json files still render correctly.
    cuts = [c for c in all_cuts if c.get("active", True)]
    inactive = len(all_cuts) - len(cuts)
    if inactive:
        print(f"[render] skipping {inactive} cut(s) toggled-off by the UI")
    duration = ffprobe_duration(source_path)
    keeps = invert_cuts(cuts, duration)

    total_kept = sum(e - s for s, e in keeps)
    print(
        f"[render] {len(cuts)} cuts → {len(keeps)} keep-segments | "
        f"source={duration:.1f}s output≈{total_kept:.1f}s "
        f"(trimmed {duration - total_kept:.1f}s, {(duration - total_kept) / duration * 100:.0f}%)"
    )

    if not keeps:
        sys.exit("error: no keep-segments — everything was cut")

    filter_complex = build_filter_complex(
        keeps,
        enhance=enhance_voice,
        color_preset=color_preset,
        audio_delay_ms=audio_delay_ms,
    )
    if audio_delay_ms != 0:
        print(f"         audio-delay: {audio_delay_ms:+d}ms")
    if enhance_voice:
        print("         voice-enhance: highpass + compressor + de-esser + EQ + exciter + limiter + loudnorm")
    if color_preset != "natural":
        print(f"         color-preset: {color_preset}")
    cmd = [
        "ffmpeg",
        "-y",
        "-i", str(source_path),
        "-filter_complex", filter_complex,
        "-map", "[outv]",
        "-map", "[outa]",
        "-c:v", "libx264",
        "-preset", "medium",
        # CRF 17 sits a hair above "visually lossless" — quality matters here
        # because Loom will re-encode again on upload. Better source = better re-encode.
        "-crf", "17",
        "-c:a", "aac",
        "-b:a", "256k",  # extra headroom before Loom re-encodes our audio again
        "-movflags", "+faststart",
        str(out_path),
    ]

    project_id = source_path.parent.name
    t0 = time.time()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    _RUNNING[project_id] = proc
    try:
        _, stderr = proc.communicate()
    finally:
        _RUNNING.pop(project_id, None)
    if proc.returncode != 0:
        # Negative returncode on POSIX means killed by signal — that's a cancel.
        if proc.returncode < 0:
            raise RuntimeError(f"render cancelled (signal {-proc.returncode})")
        sys.stderr.write((stderr or "")[-3000:])
        raise RuntimeError(f"ffmpeg failed (exit {proc.returncode})")
    print(f"         {time.time() - t0:.1f}s → {out_path}")

    # Mirror the render into ~/Downloads/looms-cut/<project-id>.mp4 so the
    # user can drag-drop straight into Loom's upload dialog from the standard
    # download location. The canonical copy stays in projects/<id>/ for
    # easy re-rendering.
    try:
        downloads_dir = Path.home() / "Downloads" / "looms-cut"
        downloads_dir.mkdir(parents=True, exist_ok=True)
        project_id = source_path.parent.name
        mirror = downloads_dir / f"{project_id}.mp4"
        shutil.copy2(out_path, mirror)
        print(f"         → {mirror}")
    except Exception as e:
        # Mirror is best-effort — don't fail the render if Downloads isn't writable.
        print(f"         WARNING: mirror to ~/Downloads/looms-cut/ failed: {e}")

    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("cuts", type=Path)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--no-enhance", action="store_true",
                        help="skip the voice-enhancement filter chain")
    parser.add_argument("--color", choices=("natural", "warm", "vivid"), default="natural",
                        help="video color preset")
    args = parser.parse_args()
    run(args.source, args.cuts, args.out,
        enhance_voice=not args.no_enhance, color_preset=args.color)


if __name__ == "__main__":
    main()
