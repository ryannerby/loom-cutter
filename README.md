# Loom Cutter

A local desktop tool that takes a raw Loom recording and produces a cleanly cut version — dead space gone, repeated takes removed, broadcast-grade audio. Designed for the "I record a pitch Loom, then spend 20 minutes editing it" problem.

Local-only. Your video never leaves your machine.

## What it does

```
your-loom.mp4
  → extract audio (ffmpeg)
  → transcribe with word-level timestamps (faster-whisper)
  → detect silences from raw amplitude (ffmpeg silencedetect)
  → ask Claude Sonnet 4.6 to identify repeated takes / false starts
  → snap cut boundaries to nearest silence; apply safety inset
  → review surface: waveform + transcript editor (FastAPI + React)
  → render: cuts applied + voice-enhancement preset (highpass, compressor,
    de-esser, presence EQ, exciter, limiter, loudnorm to -14 LUFS)
  → final MP4 mirrored to ~/Downloads/looms-cut/
```

Typical Loom (4 min raw → ~2 min cut) takes **~4 min of compute** (Whisper transcribe is the bottleneck) and **~30s of human review**.

## Install

Requires macOS, Python 3.11+, ffmpeg, Node 20+, and an Anthropic API key.

```bash
# System deps
brew install python@3.12 ffmpeg node

# Clone
git clone https://github.com/<you>/loom-cutter.git
cd loom-cutter

# Python deps
python3.12 -m venv .venv
.venv/bin/pip install -e '.[server]'

# UI deps + build
cd ui && npm install && npm run build && cd ..

# API key
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.zshrc
source ~/.zshrc
```

## Use

### Day to day (after install)

Double-click **LoomCutter.app**. A browser tab opens to `http://localhost:8000`. Drag a Loom MP4 onto the window. ~4 min later you're reviewing cuts. Hit Render. The final MP4 lands in `~/Downloads/looms-cut/<your-loom-name>.mp4` — drag it straight into Loom's uploader.

### Dev mode (hot reload)

```bash
./scripts/start.sh
```

Boots FastAPI on `:8000` and Vite on `:5173`, opens `http://localhost:5173`. Changes to either backend or frontend hot-reload.

### CLI (no UI)

```bash
.venv/bin/python cli.py projects/test-01/source.mp4
```

Runs the full pipeline end-to-end. Output at `projects/test-01/output.mp4` and `~/Downloads/looms-cut/test-01.mp4`.

## Architecture

| Layer | Purpose |
|---|---|
| `pipeline/transcribe.py` | faster-whisper → words.json with word-level timestamps |
| `pipeline/silences.py` | ffmpeg silencedetect → silences.json |
| `pipeline/edit_llm.py` | Claude Sonnet 4.6 finds repeats / false starts → llm_cuts.json |
| `pipeline/snap_silence.py` | merges silence + LLM cuts, snaps to boundaries, applies inset → cuts.json |
| `pipeline/waveform.py` | amplitude peaks for SVG rendering → peaks.json |
| `pipeline/render.py` | ffmpeg concat + voice enhancement → output.mp4 |
| `server/main.py` | FastAPI: serves UI in production, exposes /api/* |
| `ui/` | React + Vite review UI |

`cuts.json` is the source of truth — hand-editable, snapshots saved to `cuts.history/` on every change, render reads from it.

## Voice enhancement chain

10-stage preset applied to every render (disable with `--no-enhance` from CLI):

1. **highpass 80Hz** — rumble cut
2. **-1.5dB @ 180Hz** — mud cut
3. **acompressor** 3:1, +2.5dB makeup — peak control
4. **deesser** @ 6.6kHz — tame sibilance
5. **+1.5dB @ 120Hz** — chest body
6. **+3dB @ 3.5kHz** — presence / clarity
7. **+2dB @ 10kHz** — air / sparkle
8. **aexciter** drive 2.5 — harmonic warmth
9. **alimiter** -0.45dBFS — brick wall
10. **loudnorm I=-14 LUFS** — broadcast / podcast loud target

Knobs at the top of `pipeline/render.py` if anything sounds overdone.

## Status

v1 — works for the recording-to-render flow on macOS. Single-user. See [PLAN.md](PLAN.md) for design decisions and roadmap.

## License

MIT — [LICENSE](LICENSE).
