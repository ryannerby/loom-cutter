"""Merge LLM semantic cuts with waveform silence regions → cuts.json.

Three jobs:
1. Convert every silence region > min_duration into a DEAD_SPACE cut.
2. Snap each LLM cut's start/end to the nearest silence boundary within ±tolerance —
   this prevents mid-word splices.
3. Union-merge overlapping cuts so the final cuts.json has no overlaps.

The result is the canonical cuts.json the renderer consumes. The LLM cut
range is preserved in its `note` for transparency.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

# How far we'll move an LLM cut boundary to land on a silent gap.
SNAP_TOLERANCE = 0.5  # seconds

# Buffer kept inside every cut boundary so we don't clip word edges or breaths.
# Even with the silencedetect threshold raised to -25dB, trailing consonants
# (s/t/f) decay slowly — 150ms of buffer is what reliably avoids the "end of
# phrase clipped" splice artifact.
INSET_MARGIN = 0.15  # seconds — keep 150ms of room on each side of every cut


def load_json(path: Path):
    return json.loads(path.read_text())


def snap_to_silence(t: float, silences: list[dict], tolerance: float, prefer: str) -> float:
    """Move `t` to the nearest silence-region boundary within `tolerance`.

    prefer="start_edge" → snap to silence_start (cut begins as voice trails off)
    prefer="end_edge"   → snap to silence_end   (cut ends as next voice picks up)
    Returns t unchanged if no silence boundary is within tolerance.
    """
    best = t
    best_dist = tolerance + 1
    for s in silences:
        candidate = s["start"] if prefer == "start_edge" else s["end"]
        d = abs(candidate - t)
        if d < best_dist:
            best_dist = d
            best = candidate
    return best if best_dist <= tolerance else t


def union_merge(cuts: list[dict]) -> list[dict]:
    """Merge any cuts that touch or overlap. Earlier cut absorbs later ones."""
    if not cuts:
        return []
    cuts = sorted(cuts, key=lambda c: c["start"])
    merged = [dict(cuts[0])]
    for c in cuts[1:]:
        last = merged[-1]
        if c["start"] <= last["end"] + 0.001:
            # Overlap or touch → extend.
            last["end"] = max(last["end"], c["end"])
            # Bias the merged reason: keep the most informative one.
            reasons = {last["reason"], c["reason"]}
            if reasons == {"DEAD_SPACE"}:
                last["reason"] = "DEAD_SPACE"
            elif "REPEATED_TAKE" in reasons:
                last["reason"] = "REPEATED_TAKE"
            elif "FALSE_START" in reasons:
                last["reason"] = "FALSE_START"
            # Concatenate notes for traceability.
            ln, cn = last.get("note", ""), c.get("note", "")
            if ln and cn and ln != cn:
                last["note"] = f"{ln} + {cn}"
            elif cn and not ln:
                last["note"] = cn
            last["source"] = "merged"
        else:
            merged.append(dict(c))
    return merged


def snapshot_existing(path: Path) -> None:
    if not path.exists():
        return
    history_dir = path.parent / "cuts.history"
    history_dir.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = history_dir / f"{path.stem}-{stamp}.json"
    dest.write_bytes(path.read_bytes())
    snaps = sorted(history_dir.glob(f"{path.stem}-*.json"))
    for old in snaps[:-50]:
        old.unlink()


def apply_inset(cuts: list[dict], margin: float) -> list[dict]:
    """Shrink each cut by `margin` seconds on each side, so we keep some audio
    around words. Drops cuts that become too short to be worth removing."""
    out: list[dict] = []
    dropped = 0
    for c in cuts:
        new_start = c["start"] + margin
        new_end = c["end"] - margin
        if new_end - new_start < 0.15:
            dropped += 1
            continue
        out.append({**c, "start": round(new_start, 3), "end": round(new_end, 3)})
    return out, dropped


def run(project_dir: Path, snap_tolerance: float = SNAP_TOLERANCE,
        inset: float = INSET_MARGIN) -> Path:
    silences = load_json(project_dir / "silences.json")["silences"]
    llm_cuts = load_json(project_dir / "llm_cuts.json")
    out_path = project_dir / "cuts.json"

    # 1) DEAD_SPACE cuts from silence regions.
    dead_cuts = [
        {
            "start": s["start"],
            "end": s["end"],
            "reason": "DEAD_SPACE",
            "note": f"silence {s['duration']:.1f}s",
            "source": "silence",
        }
        for s in silences
    ]

    # 2) Snap LLM cut boundaries to nearest silence edge.
    snapped: list[dict] = []
    snapped_count = 0
    for c in llm_cuts:
        original = (c["start"], c["end"])
        new_start = snap_to_silence(c["start"], silences, snap_tolerance, "end_edge")
        new_end = snap_to_silence(c["end"], silences, snap_tolerance, "start_edge")
        if (new_start, new_end) != original:
            snapped_count += 1
        snapped.append({**c, "start": new_start, "end": new_end})

    # 3) Union-merge.
    merged = union_merge(dead_cuts + snapped)

    # 4) Inset — keep `inset` seconds of audio around every cut boundary so
    #    word edges and breaths aren't clipped. Done after merge so the inset
    #    applies to the final cut bounds, not internal seams.
    merged, dropped = apply_inset(merged, inset)

    # 5) Every cut starts as ACTIVE. The UI can toggle this off without losing
    #    the AI's proposal (render filters by active=true).
    for c in merged:
        c.setdefault("active", True)

    total = sum(c["end"] - c["start"] for c in merged if c.get("active", True))
    by_reason: dict[str, float] = {}
    for c in merged:
        by_reason[c["reason"]] = by_reason.get(c["reason"], 0) + (c["end"] - c["start"])
    reason_summary = ", ".join(f"{r}={s:.1f}s" for r, s in sorted(by_reason.items()))
    print(
        f"[snap]  {len(dead_cuts)} dead-space + {len(llm_cuts)} llm "
        f"({snapped_count} snapped) → {len(merged)} merged cuts, {total:.1f}s total "
        f"({reason_summary}); inset={inset * 1000:.0f}ms"
        + (f", {dropped} cut(s) too small after inset" if dropped else "")
    )

    snapshot_existing(out_path)
    out_path.write_text(json.dumps(merged, indent=2))
    print(f"        → {out_path}")
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project_dir", type=Path)
    parser.add_argument("--snap-tolerance", type=float, default=SNAP_TOLERANCE)
    args = parser.parse_args()
    if not args.project_dir.is_dir():
        sys.exit(f"error: {args.project_dir} is not a directory")
    run(args.project_dir, args.snap_tolerance)


if __name__ == "__main__":
    main()
