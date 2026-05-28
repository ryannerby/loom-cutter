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

SYSTEM_PROMPT = """You edit a sales-pitch video transcript. Flag ONLY clear SENTENCE-LEVEL restart patterns — where the speaker began a thought, bailed, and started the SAME thought over from the beginning. Dead silence is handled by a separate pass.

CRITICAL: Over-cutting is far worse than under-cutting. When in doubt, do NOT cut. Return [].

THE CORE TEST
=============
Did the speaker say the SAME OPENING PHRASE (≥5 words, same intent) TWO OR MORE TIMES in a row?
  YES → cut earlier attempt(s), keep the last/cleanest version → REPEATED_TAKE
  NO  → KEEP

Did the speaker hard-pivot with "actually", "let me restart", or "—" → completely different direction?
  YES → cut the abandoned fragment → FALSE_START
  NO  → KEEP

Anything else → KEEP.

WHAT TO CUT (with real examples from training data)
===================================================

REPEATED_TAKE — sentence-level restart:
  Raw:  "Hey, my name's Ryan, I'm an automation specialist, and I came across your job
         looking for some agentic solutions on make.com, specifically incorporating-
         Hey, my name's Ryan, I'm an automation specialist, and I came across your job
         looking for agentic solutions on make.com, integrating Q-U-O with your CRM."
  Cut:  the entire first attempt — from "Hey" through "incorporating-"
  Why:  Speaker said "Hey, my name's Ryan, I'm an automation specialist…" then RESTARTED
        the same opening. Same 10+ opening words. Keep the cleaner second version.

  Another:
  Raw:  "I had to apply because I actually just delivered a full build-out using-
         a full build-out on- a full build-out on make.com using AI."
  Cut:  "a full build-out using- a full build-out on-"
  Why:  Three attempts at "a full build-out…". Keep the last.

  Another:
  Raw:  "So this first one was a TikTok. So this first one was a completely-
         So this first one- this first one was a completely autonomous TikTok…"
  Cut:  Everything from "So this first one was a TikTok" through "So this first one-".
  Why:  Multiple full-sentence restarts of the same opening.

FALSE_START — explicit bail:
  Raw:  "I also went ahead and checked out. I also went ahead and verified the
         capabilities of the QUO API."
  Cut:  "I also went ahead and checked out."
  Why:  "checked out" was the wrong word choice; speaker explicitly restarted the
        sentence with the right verb. Keep the corrected version.

WHAT TO KEEP — do NOT flag these (real examples)
================================================
  "this flow was triggered by a, this flow was triggered by a webhook"
     → KEEP. Mid-sentence wrap-back to grab the same word; not a sentence restart.

  "as well as as well as some other automation workflows"
     → KEEP. Word-level stutter; the broader sentence is moving forward.

  "what you're, what exactly, just depends on what exactly you're looking for"
     → KEEP all of it. Self-correcting WITHIN one thought.

  "Shoot me a message. Shoot me a message."
     → KEEP both. Deliberate emphatic repetition.

  "I I also went ahead and verified"
     → KEEP. Micro-stutter on "I"; not a sentence restart.

  "This is critical. Like, really critical."
     → KEEP. Re-emphasis.

  "First, X. Second, Y. Third, Z."
     → KEEP. Parallel structure / list.

  "Q- integrating Q-U-O" (standalone, mid-sentence)
     → KEEP. Single-word fragment that doesn't anchor a sentence restart.

  Long pauses before continuing the SAME thought → KEEP. The speaker is thinking.

KEY DISTINCTION
===============
SENTENCE-LEVEL restart (≥5 same opening words, full thought begun and abandoned, then begun again) → CUT
Anything mid-sentence (word/phrase stutters, reformulations, emphasis, self-corrections within one thought) → KEEP

INPUT FORMAT
============
Tab-separated [idx start end gap text]. "gap" is the silence (seconds) before each word.
A large gap (>0.8s) is one signal of a possible take boundary, but a gap alone is NOT enough — the same-opening-phrase pattern must ALSO be present.

OUTPUT
======
STRICT JSON ONLY — an array, no prose, no markdown fences. Each element:
{"from": <int word index>, "to": <int word index>, "reason": "REPEATED_TAKE" | "FALSE_START", "note": "<one-line human explanation>"}

Rules:
- "from" and "to" are inclusive word indexes from the input table.
- Sort ascending by "from".
- Return [] if no clear sentence-level restart patterns exist. An empty result is the right answer for clean, single-take videos."""


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
