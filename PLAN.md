# Loom Cutter — Plan

A local tool that takes a raw Loom recording and produces a cleanly cut version: removes repeated takes, false starts, and long pauses. Pre-cut by an LLM, manually reviewable in a waveform/transcript UI styled per the minimalist-ui design protocol.

---

## Problem

Recording an Upwork proposal Loom usually means several attempts at the same phrase, false starts, and dead air. Currently this is cleaned up by hand in Loom's editor — slow, repetitive, the bottleneck on getting proposals out the door.

## Goal

Cut average post-record edit time from ~15–30 min per video down to ~2 min of review + click render.

## Non-goals (v1)

- Cloud hosting or multi-user
- Recording inside the app (Loom keeps doing that)
- Style transfer, background music, captions burn-in
- Mobile
- A Chrome extension version (the existing Upwork filter extension stays separate — wrong runtime for video work; ffmpeg/Whisper can't live in a browser extension)
- Cloud upload of source video (rejected on upload-time + cost + privacy grounds — these are client-facing pitch videos)
- Electron / Tauri desktop bundle (rejected for v1 — packaging overhead for a one-user tool; revisit if ever shared)

---

## Decisions (locked)

| Decision | Choice | Why |
|---|---|---|
| Automation level | Pre-cut + review UI with manual editing tools | LLM gets ~90% right; manual nudge catches the rest. Confirmed by Ryan. |
| Input source | Local MP4 file (drag-drop or watched folder) | Zero auth, ship fast. Loom has no clean download API anyway. |
| Default cuts | Repeated takes, false starts, long pauses (>1.5s) | Filler words (um/uh) left in by default — too aggressive when always-on. |
| Runtime | Local web app (FastAPI + React, served on localhost) | Feels like a desktop app, no packaging overhead, all processing local. |
| Distribution | `.app` wrapper that opens Chrome in `--app=` mode pointing at localhost | Indistinguishable from native; background service starts at login. |
| Startup model | `launchd` service runs FastAPI at login (Tier 2). Click app icon → opens browser tab → instant. | Server idle cost ~50MB RAM. The lazy-loaded Whisper model only loads on first transcription, not at boot. |
| Lives where | `/Volumes/SSD-500/Business/loom-cutter/` (sibling to upwork/) | Own codebase, supports Upwork but not coupled to it. |
| Source safety | Never overwrite source MP4 — stays read-only in `projects/{id}/source.mp4`; renders write elsewhere | Cheap to bake in, expensive to retrofit after losing a take. |
| State model | `cuts.json` is the single source of truth, hand-editable. Render reads it. | Re-renders are cheap (no re-transcribe). UI breaking ≠ data loss. Undo = restore from `cuts.history/`. |
| UI aesthetic | Minimalist-ui skill protocol: faux-OS chrome, warm monochrome canvas, Newsreader serif headlines, Geist Mono meta, muted pastels for accents. Radical minimalism — only video + waveform + transcript + render button visible by default. | Matches Ryan's design memory (Notion/Things/Bear, not Linear-dark dev-tool look). |

---

## Architecture

```
input/my-loom.mp4
  → [1] extract audio (ffmpeg → wav)
  → [2] transcribe (faster-whisper → words.json: [{word, start, end}, ...])
  → [3] LLM edit pass (Claude → cuts.json: [{start, end, reason}, ...])
  → [4] snap-to-silence (nudge cut boundaries to nearest silent gap in waveform)
  → [5] review UI loads words.json + cuts.json + video → user tweaks → saves cuts.json
  → [6] render (ffmpeg concat of kept segments + tiny audio crossfades) → output/my-loom-cut.mp4
```

Steps 1–4 are one CLI command. Step 5 is the web UI. Step 6 is a button in the UI.

---

## Tech stack

- **Python 3.11** — pipeline backend
- **`faster-whisper`** — transcription, word-level timestamps, runs locally on M-series silicon
- **Anthropic SDK + Claude Sonnet 4.6** — edit-decision pass
- **`ffmpeg`** (subprocess) — cutting + rendering
- **FastAPI** — local HTTP API
- **React + Vite + TypeScript** — UI
- **Inline SVG waveform** (custom — see Waveform Specification below). Not wavesurfer.js; the look we want isn't its default.
- **Newsreader** (serif), **SF Pro Display** (sans), **Geist Mono** (monospace) — per minimalist-ui

No database. State is files on disk under `projects/{video-hash}/`.

---

## File structure

```
loom-cutter/
  PLAN.md                       # this file
  NEXT_STEPS.md                 # execution guide
  README.md                     # how to run it
  pyproject.toml                # python deps
  cli.py                        # `python cli.py path/to/video.mp4` runs steps 1-4
  pipeline/
    __init__.py
    transcribe.py               # faster-whisper wrapper → words.json
    edit_llm.py                 # Claude prompt + JSON parsing → cuts.json
    snap_silence.py             # nudge cut edges to silent gaps
    render.py                   # ffmpeg concat kept segments
  server/
    main.py                     # FastAPI: GET /projects, GET /project/{id}, POST /cuts, POST /render
  ui/                           # React app (Vite)
    src/
      App.tsx
      components/
        VideoPlayer.tsx
        Waveform.tsx
        Transcript.tsx
        Toolbar.tsx
      styles/
        tokens.css              # warm-monochrome palette + typography vars (mirrors design/mockup.html)
  design/
    mockup.html                 # the locked-in visual reference
  projects/
    {video-hash}/
      source.mp4                # original — never written to
      audio.wav                 # extracted
      words.json                # whisper output
      cuts.json                 # edit decisions (editable, source of truth)
      cuts.history/             # timestamped snapshots for undo
      output.mp4                # final render
  scripts/
    start.sh                    # boots server + opens browser in --app mode
  LoomCutter.app/               # macOS app bundle wrapping start.sh (built last)
```

---

## The LLM edit prompt (key quality lever)

Most iteration will happen here. Initial shape:

> You're editing a sales video transcript with word-level timestamps. Identify segments to CUT based on:
> 1. **Repeated takes** — speaker says the same idea 2+ times trying to nail it. Keep the LAST clean version, cut the earlier attempts.
> 2. **False starts** — abandoned sentences ("I think we should— actually let me—").
> 3. **Long pauses** — silences over 1.5s.
>
> Output JSON: `[{start, end, reason}]` for cuts only. Be conservative — when in doubt, keep it. The user will review.

Tricks to build in from day one:
- Pass the **timing gap before each word** to the LLM — long gaps are strong retake-boundary signals
- Run a cheap **second-opinion pass** on each proposed cut ("would removing this hurt flow?") to filter false positives

---

## UI Specification

Single page. From top to bottom:

1. **Faux-macOS window chrome** — traffic-light dots, monospace filename centered, Render button right.
2. **Video preview** — restrained max-width (~640px), centered, plain time pill bottom-right.
3. **Waveform** (full-width inside window) — see Waveform Specification below.
4. **Transcript** — large body type (~17px), click any word to toggle cut. Strikethrough + pale-red-bg on cut words. Long pauses render as dashed `[1.8s]` monospace chips.

Cut-reason chips (`FALSE START`, `REPEATED TAKE`, `LONG PAUSE`) appear inline in the transcript, not in the waveform — the waveform stays purely visual.

Removed from earlier iterations after the "ruthlessly purge" pass:
- Stats column (cuts proposed / time trimmed / confidence)
- H1 headline
- Header metadata row
- Re-transcribe / Reset cuts header buttons (move to `…` overflow menu later if missed)
- Waveform legend
- Status bar of keyboard shortcuts (move to `?` overlay)

### Waveform Specification

This is the design-critical component. Spec, not just style:

- **Smooth filled SVG path**, mirrored around a horizontal center axis. Not discrete bars. Lozenge-blob silhouette like Descript / Logic.
- **Speech-envelope rendering** — amplitude pinches to near-zero between syllables, making zero-crossings visually obvious without needing labels.
- **Kept regions** filled with ink-soft (`#57534E`); **cut regions** filled with pale-red ink (`#9F2F2D`, 55% opacity) as part of the same path — not an overlay box.
- **Snap markers** at the boundary of each cut: vertical pale-red tick (1.5px × 22px) with a small dot at the top, positioned exactly on a chosen zero-crossing.
- **Zero line** is a very faint horizontal hairline (12% opacity) — visible but not loud.
- **Playhead** as a thin ink-colored vertical line spanning slightly above/below the waveform.
- **Time ruler** below the waveform in Geist Mono, 10px, muted color.

### Zoom + pan controls

- **`⌘` + scroll** zooms in/out, anchored on the cursor position. Range 1× → 20×.
- **`⇧` + scroll** pans horizontally.
- **`⌘+` / `⌘-`** keyboard zoom; **`⌘0`** resets.
- Native horizontal trackpad scroll pans without modifiers.
- Zoom level indicator (e.g. `2.4×`) in mono font at the top-right of the waveform.

Implementation note: zoom by setting `width: ${zoom * 100}%` on a `.zoom-inner` wrapper inside an `overflow-x: auto` scroll host. The SVG `preserveAspectRatio="none"` lets it stretch horizontally while the height stays pixel-locked. The ruler scales with the waveform inside the same wrapper, so labels and audio always align.

### Manual editing affordances

- **Click any word** in transcript → toggle keep/cut for that word.
- **Shift-click word range** → toggle range.
- **Shift-click on waveform timeline** → drop a cut at an arbitrary timestamp (not bound to word boundaries). This handles the "halfway between a phrase" case Ryan flagged on day one.
- **Drag cut region edges** in the waveform → nudge cut boundaries. Snaps to nearest zero-crossing by default; hold `Alt` to override snap.
- **Keyboard:** `space` play/pause, `j/k/l` scrub, `x` toggle cut at playhead, `[`/`]` set in/out, `z` snap-to-zero, `⌘Z` undo.

---

## Build order

### v0 — End-to-end CLI, no UI (target: 1 evening)
Steps 1, 2, 3, 6. Drop MP4, get cut MP4 out. No review.
**Goal:** prove LLM cuts are good enough on a real Loom. Informs every UI decision.

### v1 — Review UI, waveform + transcript (target: 1 weekend) — *waveform pulled forward from v2 on 2026-05-26*
FastAPI + React. Both visible: waveform on top (cut regions shown as muted blobs, kept regions colored), transcript below (strikethroughs, click-to-toggle). Right-click a cut blob in the waveform to toggle keep/cut. Drag handles on cut edges to adjust boundaries. Render button.

**Why waveform-first:** the AI will always be imperfect at cut-detection. The product is "AI's best guess + 30 seconds of human review" — the review UI IS the product. Visual review (waveform) is faster than reading every word. Confirmed with Ryan 2026-05-26 after Step 2.

Match `design/mockup.html` visual style exactly — extract tokens into `ui/src/styles/tokens.css`. Snap-to-silence already wired up in `pipeline/snap_silence.py` from Step 2.

### v2 — Zoom + pan + arbitrary cuts (target: a few hours)
Add `⌘`-scroll zoom anchored on cursor and `⇧`-scroll pan. Shift-click on waveform timeline to drop a cut at any point (not bound to word boundaries). Snap-marker pips at every cut boundary.

### v3 — Polish (ongoing)
- Full keyboard shortcut set + `?` overlay for discoverability
- Drag-edge nudge with zero-crossing snap
- Watched-folder mode (auto-import new files in `~/Downloads/looms/`)
- Saved prompt presets ("aggressive", "conservative", "remove um/uh")
- `LoomCutter.app` bundle + `launchd` background service

---

## Operational rules baked into v0

1. **Source MP4 is read-only.** Pipeline reads it, never writes to it. All output goes elsewhere.
2. **`cuts.json` is the source of truth.** It's the only file the render step needs. Hand-editable.
3. **Every UI save snapshots to `cuts.history/`.** Cheap undo. Newest 50 kept, older pruned.
4. **Re-render is a one-button operation.** No re-transcribe needed.
5. **Failure modes are loud.** If Whisper or Claude fails, the UI shows the error in plain English — never silently produces a bad render.

---

## Risks to watch

- **Whisper accuracy on Ryan's voice.** If `medium` model is shaky, jump to `large-v3` or Whisper API. Test on one real Loom in NEXT_STEPS Step 1 before building further.
- **LLM over-cuts.** Mitigation: prompt says "be conservative," review UI is mandatory in v1+, second-opinion pass in v2.
- **Splice audio pops.** Mitigated by snap-to-silence + 80ms audio crossfade at every cut boundary.
- **Whisper model load time.** Lazy-load on first transcription, not at server boot.
- **Misalignment between waveform and ruler under zoom.** Mitigated by putting both inside the same `.zoom-inner` wrapper so they scale together.

---

## Daily UX (target)

```
1. Record Loom in browser, download MP4 → ~/Downloads/looms/loom-xyz.mp4
2. Click "Loom Cutter" in dock (or it auto-detects new file in watched folder — v3)
3. Window pops open in <1 sec (server already running via launchd)
4. ~30 sec while it transcribes + LLM cuts
5. Review/tweak cuts in transcript + waveform
6. Click Render → output to ~/Downloads/looms-cut/loom-xyz-cut.mp4
7. Upload to Upwork
```

Total user time: ~2 min review.

---

## Cost expectations

- **Whisper local:** $0. Runs on Mac, ~30 sec per minute of audio.
- **Claude API (edit pass):** ~$0.01–0.03 per video (Sonnet 4.6, ~2K tokens in, 500 out).
- **Hosting:** $0. Everything local.
- **Time saved:** ~15-25 min per Loom. Pays for itself after one video.

---

## Open questions

- Run Whisper local (free, ~30s per minute of audio on M-series) vs Whisper API ($0.006/min, faster)? Default to local for v0; switch is one-line.
- Drag-drop UI vs watched folder vs both? Both is trivial — build watched folder in v3.
- Export anything other than MP4? Probably not — Loom uploads accept MP4.
- Should the LLM also generate a one-line "title" for the video? Cheap nice-to-have for v3.
