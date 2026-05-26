# Next Steps — Execution Guide

Step-by-step path from "empty folder" to "working Loom cutter."

---

## Step 0 — Review the plan & mockup (you, ~10 min)

1. Open [PLAN.md](PLAN.md) and skim it. Anything wrong or missing?
2. Open [design/mockup.html](design/mockup.html) in a browser. Verify:
   - Waveform style (smooth lozenge blobs, mirrored, zero-crossings obvious)
   - `⌘`-scroll zoom and `⇧`-scroll pan feel right
   - Transcript readability
   - Overall minimalism — nothing on screen you'd want gone
3. **Tell Claude what to change** before any code gets written.

---

## Step 0.5 — Prerequisites check (you, ~5 min)

Run these in your terminal. All four must succeed before Step 1.

```bash
# 1. ffmpeg installed
ffmpeg -version | head -n 1
# If not: brew install ffmpeg

# 2. Python 3.11 or newer
python3 --version
# If older: brew install python@3.12

# 3. Anthropic API key in environment
echo $ANTHROPIC_API_KEY | head -c 10
# Should print the first 10 chars of your key, not empty
# If empty: add `export ANTHROPIC_API_KEY="sk-ant-..."` to ~/.zshrc

# 4. At least one real Loom MP4 ready to test
ls /Volumes/SSD-500/Business/loom-cutter/projects/test-01/source.mp4
# If missing: record a 2-min Loom, download the MP4, drop it there
```

---

## Step 1 — Sanity-check Whisper on your voice (you + Claude, ~30 min)

Prove Whisper transcribes you accurately before building anything else. If it doesn't, the whole pipeline is dead.

1. Record a 2-minute Loom doing your normal pitch style. **Include 3–5 intentional false starts and one repeated phrase** so we can validate the cut-detection pass later.
2. Confirm the MP4 is at `projects/test-01/source.mp4`.
3. Ask Claude: *"Install faster-whisper. Transcribe `projects/test-01/source.mp4` with word-level timestamps. Save to `projects/test-01/words.json`. Show me the output side-by-side with the audio."*
4. **Look at the transcript.** Is every word right? Are timestamps accurate to within ~100ms?
   - **Yes** → continue to Step 2.
   - **Shaky** → tell Claude to switch to `large-v3` model or the Whisper API, re-run.

---

## Step 2 — Build v0 CLI (Claude does, you watch, ~1 evening)

Goal: drop MP4 in, get cut MP4 out. No UI yet.

Ask Claude: *"Build v0 of the loom-cutter CLI per PLAN.md. Steps 1, 2, 3, 6 — extract audio, transcribe, LLM cut decisions, ffmpeg render. Use `projects/test-01` as the test case. Source MP4 must stay read-only. `cuts.json` must be the editable source of truth, with snapshots written to `cuts.history/`."*

What Claude will build:
- `pyproject.toml` with deps (`faster-whisper`, `anthropic`, `ffmpeg-python`)
- `pipeline/transcribe.py`, `pipeline/edit_llm.py`, `pipeline/render.py`
- `cli.py` that runs them in order

**Run it on test-01.** Open the output MP4. How does it sound? This is the moment of truth — if v0 cuts are 80%+ good, the rest is worth building.

---

## Step 3 — Tune the LLM prompt (you + Claude, iterative)

The cuts on v0 will be imperfect. Run it on 2–3 more real Looms. Each time, note what it got wrong:
- "It cut the take I wanted to keep."
- "It missed a repeated take."
- "It cut a pause that was intentional emphasis."

Ask Claude: *"Based on these failures, refine the prompt in `pipeline/edit_llm.py`. Add the timing-gap-before-each-word signal. Add the second-opinion pass."*

Iterate until you trust v0 enough that you'd ship a video without watching it. (Goal — not a requirement. You'll always review in v1.)

---

## Step 4 — Build v1 review UI (Claude does, ~1 weekend)

Ask Claude: *"Build the v1 review UI per PLAN.md UI Specification. FastAPI backend + React/Vite/TypeScript frontend. Extract the design tokens from `design/mockup.html` into `ui/src/styles/tokens.css`. Match the mockup exactly. Transcript view with click-to-toggle cuts, video player, render button. Skip the waveform for now."*

What Claude will build:
- `server/main.py` (FastAPI endpoints)
- `ui/` (Vite + React + TS project matching the mockup)
- `scripts/start.sh` that boots both and opens Chrome in `--app=` mode

You should be able to:
1. Drop an MP4 in `projects/`
2. Run `./scripts/start.sh`
3. See it in browser, click words to toggle, hit Render

---

## Step 5 — Use it daily for real work

Live with v1 for a week. Track:
- How long does review actually take?
- Which cuts does the LLM consistently miss?
- What manual edits do you make every time?

This tells you what v2 needs.

---

## Step 6 — v2 waveform + silence snapping + zoom (Claude does, few hours)

Once v1 is in your daily workflow:

Ask Claude: *"Add the waveform to the review UI per the Waveform Specification in PLAN.md. Smooth mirrored SVG path (not bars). Cut regions colored as part of the same path. Snap markers at zero-crossings. Add `⌘`-scroll zoom anchored on cursor, `⇧`-scroll pan, `⌘+`/`⌘-`/`⌘0` keyboard zoom. Add shift-click-on-waveform to drop arbitrary cut points. Add the snap-to-silence pass to the backend pipeline with 80ms audio crossfades at every cut boundary."*

---

## Step 7 — v3 polish + .app wrapper (Claude does, ongoing)

When you're tired of running `./scripts/start.sh`:

Ask Claude: *"Wrap the local server in a macOS .app bundle. Set up `launchd` to auto-start the FastAPI server at login (Tier 2 startup model in PLAN.md). Lazy-load the Whisper model on first transcription, not at boot. Add the `?` keyboard-shortcut overlay. Add watched-folder mode for `~/Downloads/looms/`."*

---

## How to ask Claude for each step

Open a new session in `/Volumes/SSD-500/Business/loom-cutter/` and start with:

> Read PLAN.md and NEXT_STEPS.md. I'm on Step N — [describe what you want].

That gives the next Claude full context without you having to re-explain.

---

## Decisions already made (so you don't second-guess mid-build)

These are settled. If you want to change one, change PLAN.md first, then proceed:

- Local-only, never cloud-hosted
- Not a Chrome extension, not Electron — local web app served by FastAPI
- Source MP4 is read-only; `cuts.json` is the editable source of truth
- Waveform is custom inline SVG (not wavesurfer.js)
- Minimalist-ui aesthetic per `design/mockup.html`
- Default cuts: repeated takes, false starts, long pauses >1.5s (no filler-word removal by default)
- Whisper runs locally via `faster-whisper`, switch to API only if accuracy fails Step 1
