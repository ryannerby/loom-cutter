"""LLM edit-decision pass.

Reads words.json, asks Claude Sonnet 4.6 to identify REPEATED_TAKE and
FALSE_START segments by word-index range, writes llm_cuts.json.

Word-index ranges (not raw timestamps) are used so the model literally cannot
hallucinate cuts outside the source. Timestamps are resolved server-side.

LONG_PAUSE / DEAD_SPACE detection is NOT this pass's job — that comes from
silences.py (waveform amplitude). The LLM only handles semantic cuts.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import anthropic

MODEL = "claude-sonnet-4-6"

SYSTEM_PROMPT = """You're editing a sales-pitch video transcript. Your job is to flag ONLY the OBVIOUS, UNAMBIGUOUS botched takes — places where the speaker clearly restarted the same sentence trying to nail delivery. Dead silence is handled by a separate pass; you only identify SEMANTIC restart patterns.

CRITICAL: Over-cutting is far worse than under-cutting. A wrongly-cut sentence destroys coherence and the user has to manually restore. Under-cutting is fine — the user can always cut more themselves. **When in doubt, do NOT cut. Return [].**

WHAT TO CUT:

1. **REPEATED_TAKE** — the speaker says the SAME sentence verbatim (or near-verbatim) 2+ times in a row, separated by a clear restart. Keep the LAST attempt; cut earlier attempts.

   Example to cut:
     "Hi I'm Ryan an automation specialist. Hi I'm Ryan, automation specialist.
      Hi my name's Ryan, I'm an automation specialist based in Toronto."
     → Cut the first two; keep the third.

   The pattern: same opening words, same intent, clearly multiple takes.

2. **FALSE_START** — speaker EXPLICITLY bails mid-sentence with a discourse marker like "actually," "let me restart," "wait," "no, " or trails off into "—" with a hard pivot. Cut only the abandoned fragment.

   Example to cut:
     "I think we should— actually let me start over. The way it works is…"
     → Cut "I think we should— actually let me start over."

WHAT IS NOT A REPEATED TAKE — DO NOT CUT THESE:

- **Re-emphasis** ("This is critical. Like, really critical.") — KEEP
- **Paraphrasing for clarity** ("Our goal is X. In other words, X again.") — KEEP
- **Lists / parallel examples** ("First, X. Second, Y. Third, Z.") — KEEP
- **Clarifications** ("We do A. Specifically, A means B.") — KEEP
- **Reformulations** ("It's fast. It's REALLY fast.") — KEEP
- **Related but distinct sentences** — KEEP
- **Filler words in isolation** ("um", "uh", "like") — KEEP (a separate filler-removal pass handles these later if needed)
- **Long pauses before continuing the SAME thought** — KEEP (the speaker is just thinking)

If you cannot point at a SPECIFIC pattern of "the speaker is starting the same sentence over again," do not flag it.

INPUT FORMAT: tab-separated words with [idx start end gap text]. "gap" is the silence (seconds) before each word — a large gap (>0.8s) is one weak signal of a take boundary, but a gap alone is NOT enough to justify a cut. The semantic restart pattern must also be present.

OUTPUT: STRICT JSON ONLY — an array, no prose, no markdown fences. Each element:
{"from": <int word index>, "to": <int word index>, "reason": "REPEATED_TAKE" | "FALSE_START", "note": "<one-line human explanation>"}

Rules:
- "from" and "to" are inclusive word indexes from the input table. Both must exist.
- Sort ascending by "from".
- If you see no clear, unambiguous patterns, return []. An empty result is the correct answer for a clean, single-take video."""


def build_user_message(words: list[dict]) -> str:
    lines = ["idx\tstart\tend\tgap\tword"]
    prev_end = 0.0
    for i, w in enumerate(words):
        gap = max(0.0, w["start"] - prev_end)
        lines.append(f"{i}\t{w['start']:.3f}\t{w['end']:.3f}\t{gap:.3f}\t{w['word'].strip()}")
        prev_end = w["end"]
    return (
        "Words from the transcript follow. Return ONLY the JSON array of "
        f"semantic cuts (REPEATED_TAKE / FALSE_START). There are {len(words)} "
        f"words, indexes 0–{len(words) - 1}.\n\n" + "\n".join(lines)
    )


def extract_json_array(text: str) -> list:
    text = text.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start = text.find("[")
    end = text.rfind("]")
    if start == -1 or end == -1 or end < start:
        raise ValueError(f"no JSON array found in response:\n{text[:500]}")
    return json.loads(text[start : end + 1])


def resolve_indices(llm_cuts: list[dict], words: list[dict]) -> list[dict]:
    """Translate word-index ranges to timestamp ranges. Drops out-of-range entries."""
    n = len(words)
    out: list[dict] = []
    dropped = 0
    for c in llm_cuts:
        f = int(c["from"])
        t = int(c["to"])
        if f < 0 or t >= n or t < f:
            dropped += 1
            continue
        start = float(words[f]["start"])
        end = float(words[t]["end"])
        out.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "reason": c["reason"],
            "note": c.get("note", ""),
            "from": f,
            "to": t,
            "source": "llm",
        })
    if dropped:
        print(f"        (dropped {dropped} out-of-range cut(s) from LLM response)")
    return sorted(out, key=lambda x: x["start"])


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


def run(words_path: Path, model: str = MODEL) -> Path:
    project_dir = words_path.parent
    out_path = project_dir / "llm_cuts.json"

    data = json.loads(words_path.read_text())
    words = data["words"]
    duration = data.get("duration", 0)

    print(f"[edit] {len(words)} words across {duration:.1f}s → asking {model}")
    client = anthropic.Anthropic()
    t0 = time.time()
    resp = client.messages.create(
        model=model,
        max_tokens=4096,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": build_user_message(words)}],
    )
    elapsed = time.time() - t0

    text = "".join(b.text for b in resp.content if b.type == "text")
    llm_cuts = extract_json_array(text)
    cuts = resolve_indices(llm_cuts, words)

    total = sum(c["end"] - c["start"] for c in cuts)
    print(
        f"       {elapsed:.1f}s — {len(cuts)} semantic cut(s), {total:.1f}s ({total / duration * 100:.0f}%) | "
        f"tokens in={resp.usage.input_tokens} out={resp.usage.output_tokens}"
    )

    snapshot_existing(out_path)
    out_path.write_text(json.dumps(cuts, indent=2))
    print(f"       → {out_path}")
    return out_path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("words", type=Path)
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("error: ANTHROPIC_API_KEY not set")
    if not args.words.exists():
        sys.exit(f"error: {args.words} does not exist")
    run(args.words, args.model)


if __name__ == "__main__":
    main()
