import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { Cut, ProjectState, RenderSettings } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import VideoPlayer, { type VideoPlayerHandle } from "./components/VideoPlayer";
import Waveform from "./components/Waveform";
import Transcript from "./components/Transcript";
import ShortcutsOverlay from "./components/ShortcutsOverlay";
import SettingsOverlay from "./components/SettingsOverlay";
import DropZone from "./components/DropZone";
import ImportStatus from "./components/ImportStatus";
import "./styles/app.css";

const SETTINGS_STORAGE_KEY = "loom-cutter-render-settings";

function loadSettings(): RenderSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return {
      voiceEnhance:
        typeof parsed.voiceEnhance === "boolean"
          ? parsed.voiceEnhance
          : DEFAULT_SETTINGS.voiceEnhance,
      colorPreset:
        parsed.colorPreset === "warm" || parsed.colorPreset === "vivid"
          ? parsed.colorPreset
          : DEFAULT_SETTINGS.colorPreset,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function App() {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [state, setState] = useState<ProjectState | null>(null);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [rendering, setRendering] = useState(false);
  const [renderedAt, setRenderedAt] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [copyFlash, setCopyFlash] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<RenderSettings>(() => loadSettings());

  // Persist render settings on change.
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage might be blocked; keep settings in-memory.
    }
  }, [settings]);

  const [theme, setTheme] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined") return "light";
    const saved = window.localStorage.getItem("loom-cutter-theme");
    return saved === "dark" ? "dark" : "light";
  });

  // Apply theme to the document root + persist.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem("loom-cutter-theme", theme);
    } catch {
      // Storage might be blocked; theme stays in-memory.
    }
  }, [theme]);

  // Undo / redo history. Stored in a ref so rapid edits don't trigger
  // a flood of re-renders. Snapshots are debounced 250ms so drag-handle
  // moves collapse into one history entry.
  const historyRef = useRef<{ states: Cut[][]; idx: number }>({ states: [], idx: -1 });
  const skipNextSnapshotRef = useRef(false);

  const videoHandleRef = useRef<VideoPlayerHandle>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get("project");
    api
      .listProjects()
      .then((projects) => {
        if (projects.length === 0) {
          // No projects yet — show empty UI with drop-zone overlay only.
          setError(null);
          setProjectId(null);
          setState(null);
          return;
        }
        const picked = requested && projects.some((p) => p.id === requested)
          ? requested
          : projects[0].id;
        setProjectId(picked);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Initial project fetch + poll while the pipeline is processing.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    let timer: number | null = null;

    const tick = () => {
      api
        .getProject(projectId)
        .then((s) => {
          if (cancelled) return;
          const wasPending = state && state.status && state.status.stage !== "ready";
          setState(s);
          // Only seed cuts from server when transitioning to ready, or on first load.
          if (!state || (wasPending && s.status?.stage === "ready")) {
            // Filter out any toggled-off cuts from older saves — that concept is
            // gone now. Right-click deletes, Cmd-Z restores.
            setCuts(s.cuts.filter((c) => c.active ?? true));
          }
          const stage = s.status?.stage;
          if (stage && stage !== "ready" && stage !== "error") {
            timer = window.setTimeout(tick, 2500);
          }
        })
        .catch((e) => !cancelled && setError(String(e)));
    };

    tick();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!projectId || !state) return;
    // Don't save while pipeline is still building — that overwrites the
    // freshly-computed cuts.json with our (empty/stale) local copy.
    if (state.status && state.status.stage !== "ready") return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      api.saveCuts(projectId, cuts).catch((e) => setError(String(e)));
    }, 400);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [cuts, projectId, state]);

  // Drag-drop import: upload, then switch URL/state to the new project.
  const handleImport = useCallback(async (file: File) => {
    setError(null);
    setUploadProgress(0);
    try {
      const { id } = await api.importFile(file, (frac) => setUploadProgress(frac));
      // Switch to the new project. It'll render in "processing" state until pipeline finishes.
      window.history.replaceState({}, "", `?project=${encodeURIComponent(id)}`);
      setState(null);
      setCuts([]);
      setRenderedAt(0);
      setProjectId(id);
      setUploadProgress(null);
    } catch (e) {
      setError(String(e));
      setUploadProgress(null);
    }
  }, []);

  const removeCut = useCallback((idx: number) => {
    setCuts((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const adjustCut = useCallback((idx: number, start: number, end: number) => {
    setCuts((prev) => prev.map((c, i) => (i === idx ? { ...c, start, end } : c)));
  }, []);

  // Uncut a range — split or remove every active cut that overlaps the
  // requested time window so words inside that window become kept again.
  // Inactive (ghost) cuts are left alone.
  const uncutWordRange = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (!state) return;
      const fromWord = state.words[fromIdx];
      const toWord = state.words[toIdx];
      if (!fromWord || !toWord) return;
      const selStart = fromWord.start;
      const selEnd = toWord.end;

      setCuts((prev) => {
        const result: Cut[] = [];
        for (const c of prev) {
          if (!(c.active ?? true)) {
            result.push(c);
            continue;
          }
          // No overlap → keep cut as-is.
          if (c.end <= selStart || c.start >= selEnd) {
            result.push(c);
            continue;
          }
          // Selection fully covers cut → remove entirely.
          if (selStart <= c.start && selEnd >= c.end) {
            continue;
          }
          // Cut fully contains selection → split into two pieces.
          if (c.start < selStart && c.end > selEnd) {
            result.push({ ...c, end: selStart });
            result.push({ ...c, start: selEnd });
            continue;
          }
          // Selection overlaps cut's left edge → trim left.
          if (selStart <= c.start && selEnd > c.start && selEnd < c.end) {
            result.push({ ...c, start: selEnd });
            continue;
          }
          // Selection overlaps cut's right edge → trim right.
          if (selStart > c.start && selStart < c.end && selEnd >= c.end) {
            result.push({ ...c, end: selStart });
            continue;
          }
        }
        return result.sort((a, b) => a.start - b.start);
      });
    },
    [state],
  );

  // Insert a new manual cut, union-merging into any overlapping cuts.
  const insertManualCut = useCallback((newCut: Cut) => {
    setCuts((prev) => {
      let merged = { ...newCut };
      const kept: Cut[] = [];
      for (const c of prev) {
        const overlaps = c.start <= merged.end && c.end >= merged.start;
        if (!overlaps) {
          kept.push(c);
          continue;
        }
        const oldNote = c.note ?? "";
        merged = {
          ...merged,
          start: Math.min(merged.start, c.start),
          end: Math.max(merged.end, c.end),
          note:
            oldNote && !(merged.note ?? "").includes(oldNote)
              ? `${merged.note ?? ""} ⊕ ${oldNote}`.trim().slice(0, 240)
              : merged.note,
        };
      }
      kept.push(merged);
      return kept.sort((a, b) => a.start - b.start);
    });
  }, []);

  // Shift-click in transcript → create a new manual cut covering the range.
  const addCutRange = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (!state) return;
      const fromWord = state.words[fromIdx];
      const toWord = state.words[toIdx];
      if (!fromWord || !toWord) return;
      const phrase = state.words
        .slice(fromIdx, toIdx + 1)
        .map((w) => w.word)
        .join("")
        .trim()
        .slice(0, 80);
      insertManualCut({
        start: fromWord.start,
        end: toWord.end,
        reason: "MANUAL",
        note: `manual: "${phrase}"`,
        active: true,
        source: "manual",
        from: fromIdx,
        to: toIdx,
      });
    },
    [state, insertManualCut],
  );

  // Drag-select on waveform → press Delete to commit as a manual cut.
  const addCutFromTime = useCallback(
    (start: number, end: number) => {
      if (end - start < 0.05) return;
      insertManualCut({
        start,
        end,
        reason: "MANUAL",
        note: `manual selection: ${(end - start).toFixed(2)}s`,
        active: true,
        source: "manual",
      });
    },
    [insertManualCut],
  );

  // Smooth-playhead source for the waveform — reads directly from the video.
  const getCurrentTime = useCallback(() => {
    return videoHandleRef.current?.getTime() ?? currentTime;
  }, [currentTime]);

  // Cut-aware seek: if the target time lands inside an active cut, snap
  // forward to the cut's end so the playhead lands on real audio.
  const seekTo = useCallback(
    (t: number) => {
      const hit = cuts.find((c) => (c.active ?? true) && t >= c.start && t < c.end);
      setCurrentTime(hit ? hit.end + 0.01 : t);
    },
    [cuts],
  );

  // Reset undo history when switching projects.
  useEffect(() => {
    historyRef.current = { states: [], idx: -1 };
    skipNextSnapshotRef.current = false;
  }, [projectId]);

  // Snapshot the cuts state after a quiet beat. Debounced so a drag of a
  // cut handle (which fires many setCuts) becomes a SINGLE undo entry.
  useEffect(() => {
    if (!state) return;
    if (skipNextSnapshotRef.current) {
      // Just applied an undo/redo — don't snapshot the result.
      skipNextSnapshotRef.current = false;
      return;
    }
    const HISTORY_MAX = 50;
    const HISTORY_DEBOUNCE_MS = 250;
    const timer = window.setTimeout(() => {
      const h = historyRef.current;
      const serialized = JSON.stringify(cuts);
      const lastSerialized = h.idx >= 0 ? JSON.stringify(h.states[h.idx]) : null;
      if (serialized === lastSerialized) return;
      // Trim any "future" (redo branch) before pushing the new state.
      const trimmed = h.idx >= 0 ? h.states.slice(0, h.idx + 1) : [];
      trimmed.push(cuts);
      while (trimmed.length > HISTORY_MAX) trimmed.shift();
      h.states = trimmed;
      h.idx = trimmed.length - 1;
    }, HISTORY_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [cuts, state]);

  // ⌘Z / ⌘⇧Z: undo / redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== "z" && e.key !== "Z") return;
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      e.preventDefault();
      const h = historyRef.current;
      if (e.shiftKey) {
        // Redo
        if (h.idx < h.states.length - 1) {
          h.idx += 1;
          skipNextSnapshotRef.current = true;
          setCuts(h.states[h.idx]);
        }
      } else {
        // Undo
        if (h.idx > 0) {
          h.idx -= 1;
          skipNextSnapshotRef.current = true;
          setCuts(h.states[h.idx]);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleRender = useCallback(async () => {
    if (!projectId) return;
    setRendering(true);
    setError(null);
    try {
      await api.saveCuts(projectId, cuts);
      await api.render(projectId, settings);
      setRenderedAt(Date.now());
    } catch (e) {
      setError(String(e));
    } finally {
      setRendering(false);
    }
  }, [projectId, cuts, settings]);

  const handleReveal = useCallback(async () => {
    if (!projectId) return;
    try {
      await api.revealOutput(projectId);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  const activeCuts = useMemo(() => cuts.filter((c) => c.active ?? true), [cuts]);

  // Build the post-cut transcript — the words that actually play in the
  // rendered video, suitable to paste into /upwork-proposal as input.
  const cleanTranscript = useMemo(() => {
    if (!state) return "";
    const kept: string[] = [];
    for (const w of state.words) {
      const mid = (w.start + w.end) / 2;
      const isCut = activeCuts.some((c) => mid >= c.start && mid <= c.end);
      if (!isCut) kept.push(w.word);
    }
    return kept.join("").trim().replace(/\s+/g, " ");
  }, [state, activeCuts]);

  const handleCopyTranscript = useCallback(async () => {
    if (!cleanTranscript) return;
    // Try the modern Clipboard API first; fall back to execCommand for
    // browser contexts that deny it (iframes, restricted permissions).
    let ok = false;
    try {
      await navigator.clipboard.writeText(cleanTranscript);
      ok = true;
    } catch {
      // ignore — try fallback
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = cleanTranscript;
        // Off-screen but selectable.
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "0";
        ta.setAttribute("readonly", "");
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, cleanTranscript.length);
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (e) {
        setError(`copy failed: ${e}`);
        return;
      }
    }
    if (ok) {
      setCopyFlash(true);
      window.setTimeout(() => setCopyFlash(false), 1400);
    } else {
      setError("copy failed: browser blocked clipboard write");
    }
  }, [cleanTranscript]);

  // Remove the cut whose range contains the playhead (⌘Z restores).
  const removeAtPlayhead = useCallback(() => {
    const t = videoHandleRef.current?.getTime() ?? currentTime;
    const idx = cuts.findIndex((c) => t >= c.start && t < c.end);
    if (idx !== -1) removeCut(idx);
  }, [cuts, currentTime, removeCut]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Suppress auto-repeat — holding ? was causing the overlay to thrash.
      if (e.repeat) return;
      // Ignore when the user's typing in an input.
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target && target.isContentEditable)
      ) {
        return;
      }
      // ⌘+/-/0 are handled inside Waveform; bail here so they don't get eaten.
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "=" || e.key === "+" || e.key === "-" || e.key === "0") return;
      }

      const v = videoHandleRef.current;
      switch (e.key) {
        case " ":
          e.preventDefault();
          v?.togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          v?.seekBy(e.shiftKey ? -10 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          v?.seekBy(e.shiftKey ? 10 : 1);
          break;
        case "j":
        case "J":
          e.preventDefault();
          v?.seekBy(-2);
          break;
        case "l":
        case "L":
          e.preventDefault();
          v?.seekBy(2);
          break;
        case "k":
        case "K":
          e.preventDefault();
          v?.togglePlay();
          break;
        case "x":
        case "X":
          e.preventDefault();
          removeAtPlayhead();
          break;
        case "r":
        case "R":
          if (e.metaKey || e.ctrlKey) return; // don't hijack reload
          e.preventDefault();
          handleRender();
          break;
        case "?":
          e.preventDefault();
          setShortcutsOpen((p) => !p);
          break;
        case "Escape":
          if (shortcutsOpen) setShortcutsOpen(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [removeAtPlayhead, handleRender, shortcutsOpen]);

  if (error) {
    return (
      <>
        <div className="window">
          <div className="titlebar">
            <div className="traffic"><span /><span /><span /></div>
            <div className="titlebar-label">loom-cutter</div>
          </div>
          <div className="error">{error}</div>
        </div>
        <DropZone onFile={handleImport} />
      </>
    );
  }

  // Empty state: no projects yet. Show drop-zone-only UI.
  if (!projectId) {
    return (
      <>
        <div className="window">
          <div className="titlebar">
            <div className="traffic"><span /><span /><span /></div>
            <div className="titlebar-label">loom-cutter</div>
          </div>
          <div className="empty-state">
            <h2>No projects yet</h2>
            <p>Drag a Loom MP4 anywhere on this window to get started.</p>
          </div>
        </div>
        <DropZone onFile={handleImport} />
      </>
    );
  }

  // Loading state for the freshly-selected project.
  if (!state) {
    return (
      <>
        <div className="window">
          <div className="titlebar">
            <div className="traffic"><span /><span /><span /></div>
            <div className="titlebar-label">loading…</div>
          </div>
        </div>
        <DropZone onFile={handleImport} />
      </>
    );
  }

  // Processing state: pipeline still building artifacts (or upload still going).
  const stage = state.status?.stage;
  const isProcessing = stage && stage !== "ready" && stage !== "error";
  if (state.status && (isProcessing || stage === "error")) {
    return (
      <>
        <div className="window">
          <div className="titlebar">
            <div className="traffic"><span /><span /><span /></div>
            <div className="titlebar-label">{projectId}/source.mp4</div>
          </div>
          <ImportStatus
            projectId={projectId}
            status={state.status}
            uploadProgress={uploadProgress}
          />
        </div>
        <DropZone onFile={handleImport} />
      </>
    );
  }

  return (
    <>
      <div className="window">
        <div className="titlebar">
          <div className="traffic"><span /><span /><span /></div>
          <div className="titlebar-label">{projectId}/source.mp4</div>
          <div className="titlebar-right">
            <button
              className="btn-copy"
              onClick={handleCopyTranscript}
              title="copy the post-cut transcript (paste into /upwork-proposal)"
              aria-label="copy clean transcript"
              disabled={!cleanTranscript}
            >
              {copyFlash ? "copied!" : "copy transcript"}
            </button>
            {(state.has_output || renderedAt > 0) && (
              <button
                className="btn-copy"
                onClick={handleReveal}
                title="reveal the rendered MP4 in ~/Downloads/looms-cut/ — drag straight into Loom's uploader"
                aria-label="show rendered clip in finder"
              >
                show rendered clip
              </button>
            )}
            <button
              className="btn-theme"
              onClick={() => setSettingsOpen(true)}
              title="render settings (audio + color)"
              aria-label="open render settings"
            >
              ⚙
            </button>
            <button
              className="btn-theme"
              onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
              title={`switch to ${theme === "light" ? "dark" : "light"} mode`}
              aria-label="toggle theme"
            >
              {theme === "light" ? "☾" : "☀"}
            </button>
            <button
              className="btn-help"
              onClick={() => setShortcutsOpen(true)}
              title="keyboard shortcuts (?)"
              aria-label="keyboard shortcuts"
            >
              ?
            </button>
            <button className="btn-render" onClick={handleRender} disabled={rendering}>
              {rendering ? "Rendering…" : "Render"}
              <svg viewBox="0 0 16 16" fill="currentColor">
                <path d="M5 3l7 5-7 5V3z" />
              </svg>
            </button>
          </div>
        </div>

        <VideoPlayer
          ref={videoHandleRef}
          projectId={projectId}
          cuts={activeCuts}
          currentTime={currentTime}
          onTimeChange={setCurrentTime}
          renderedAt={renderedAt}
          showOutput={renderedAt > 0}
        />

        <Waveform
          duration={state.duration}
          peaks={state.peaks.peaks}
          cuts={cuts}
          silences={state.silences}
          currentTime={currentTime}
          getCurrentTime={getCurrentTime}
          onRemoveCut={removeCut}
          onAdjustCut={adjustCut}
          onSeek={seekTo}
          onAddRange={addCutFromTime}
        />

        <Transcript
          words={state.words}
          cuts={cuts}
          currentTime={currentTime}
          onSeek={seekTo}
          onAddCutRange={addCutRange}
          onRemoveCut={removeCut}
          onUncutRange={uncutWordRange}
        />
      </div>

      <ShortcutsOverlay open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SettingsOverlay
        open={settingsOpen}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
      />
      <DropZone onFile={handleImport} />
    </>
  );
}
