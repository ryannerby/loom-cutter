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

SYSTEM_PROMPT = """You're editing a sales-pitch video transcript. Identify SEMANTIC cuts — repeated takes and abandoned sentences. Silence/pause cuts are handled by a separate audio-analysis pass; ignore them.

Cut reasons:
1. REPEATED_TAKE — the speaker says substantially the same phrase or sentence 2+ times trying to nail delivery. Keep the LAST clean attempt; cut every earlier attempt. A "repeated take" requires the same SEMANTIC CONTENT (same words or near-paraphrase), not just a similar topic.
2. FALSE_START — an abandoned sentence the speaker bailed on mid-phrase ("I think we should— actually let me—"). Cut the abandoned fragment, not the recovery.

Aggressiveness:
- Be AGGRESSIVE on repeated takes. If you see clear repetition of the opening line ("Hey my name's Ryan, I'm an automation specialist"), cut every attempt except the final clean one. Do not preserve earlier attempts out of caution.
- Be CONSERVATIVE on what counts as semantically equivalent. Two sentences are "repeated" only if a listener would clearly hear "they said that twice." Different examples, expansions, or recoveries are NOT repeats.
- Do NOT cut filler words (um, uh, like) in isolation. They only get cut as part of a repeated-take or false-start range.

Input format: tab-separated words with [idx start end gap text]. "gap" is the silence before that word (helpful as a take-boundary signal — repeats usually follow a long gap).

Output: STRICT JSON ONLY — an array, no prose, no markdown fences. Each element:
{"from": <int word index>, "to": <int word index>, "reason": "REPEATED_TAKE" | "FALSE_START", "note": "<one-line human explanation>"}

Rules:
- "from" and "to" are word indexes from the input table (inclusive on both ends).
- The cut range MUST be within the indexes present in the input. Do not invent indexes.
- Sort ascending by "from".
- If you see nothing to cut, return []."""


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
