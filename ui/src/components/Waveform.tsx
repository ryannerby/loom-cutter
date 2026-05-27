import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Cut, Silence } from "../types";
import "./Waveform.css";

interface Props {
  duration: number;
  peaks: number[];
  cuts: Cut[];
  silences: Silence[];
  currentTime: number;
  getCurrentTime: () => number;
  snapEnabled: boolean;
  onRemoveCut: (idx: number) => void;
  onAdjustCut: (idx: number, start: number, end: number) => void;
  onSeek: (t: number) => void;
  onAddRange: (start: number, end: number) => void;
}

interface Selection {
  id: number;
  start: number;
  end: number;
}

const SVG_W = 1000;
const SVG_H = 120;
const MID = SVG_H / 2;
const MAX_AMP = (SVG_H / 2) * 0.86;
const MIN_ZOOM = 1;
const MAX_ZOOM_FLOOR = 20;     // shortest clips can still zoom this much
const MAX_ZOOM_CEILING = 200;  // hard cap for very long clips
const MAX_ZOOM_MIN_VISIBLE_SEC = 1; // ideal: zoom in until ~1s of audio is visible
const DRAG_THRESHOLD_PX = 4;
const SNAP_THRESHOLD_SEC = 0.2;
// Push the snap target INSIDE the silence region by this much. ffmpeg's
// silencedetect marks silence_end at the moment the signal crosses ABOVE
// threshold — which on a slow consonant attack ('s', 'f', soft 'th') is
// often 50-100ms into the actual consonant. 100ms pad on each side keeps
// us safely inside the quiet zone for those attacks/decays.
const SNAP_PAD_SEC = 0.1;
// Snap auto-disables when the visible window shrinks below this many
// seconds — that's "surgical mode," sub-word work. Threshold is ABSOLUTE
// time (not a zoom multiplier) so it scales correctly across clip lengths:
// a 30-min clip and a 60-sec clip both flip to surgical mode when ~8s of
// audio is visible.
const SNAP_DISABLE_BELOW_VISIBLE_SEC = 8;

// Edge-aware snap. "start" = cut start (snap a bit AFTER silence_start to
// preserve any trailing decay of the previous word). "end" = cut end (snap
// a bit BEFORE silence_end so we don't eat the next word's consonant).
function snapTime(
  t: number,
  silences: Silence[],
  tolerance: number,
  edge: "start" | "end",
): number {
  let best = t;
  let bestDist = tolerance + 1;
  for (const s of silences) {
    const target = edge === "start" ? s.start + SNAP_PAD_SEC : s.end - SNAP_PAD_SEC;
    // Snap target must still be inside its silence region (won't happen
    // unless the silence is <2*pad long, but be safe):
    if (edge === "start" && target > s.end) continue;
    if (edge === "end" && target < s.start) continue;
    const d = Math.abs(target - t);
    if (d < bestDist) {
      bestDist = d;
      best = target;
    }
  }
  return bestDist <= tolerance ? best : t;
}

// Union-merge: collapse any selections that overlap or touch each other so
// that the array stays non-overlapping after every edit.
function mergeAllSelections(sels: Selection[]): Selection[] {
  if (sels.length <= 1) return sels;
  const sorted = sels.slice().sort((a, b) => a.start - b.start);
  const out: Selection[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      out.push(cur);
    }
  }
  return out;
}

function envelopePathSegment(peaks: number[], from: number, to: number): string {
  if (to <= from) return "";
  const n = peaks.length;
  const x = (i: number) => (i / (n - 1)) * SVG_W;
  const parts: string[] = [];
  parts.push(`M ${x(from).toFixed(2)} ${(MID - peaks[from] * MAX_AMP).toFixed(2)}`);
  for (let i = from + 1; i <= to; i++) {
    parts.push(`L ${x(i).toFixed(2)} ${(MID - peaks[i] * MAX_AMP).toFixed(2)}`);
  }
  for (let i = to; i >= from; i--) {
    parts.push(`L ${x(i).toFixed(2)} ${(MID + peaks[i] * MAX_AMP).toFixed(2)}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

function invertCuts(duration: number, cuts: Cut[]): { start: number; end: number }[] {
  const active = cuts.filter((c) => c.active ?? true).slice().sort((a, b) => a.start - b.start);
  const keeps: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const c of active) {
    if (c.start > cursor) keeps.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (cursor < duration) keeps.push({ start: cursor, end: duration });
  return keeps;
}

function timeToBucket(t: number, duration: number, n: number): number {
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(n - 1, Math.round((t / duration) * (n - 1))));
}

function fmtTime(s: number): string {
  if (!isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

export default function Waveform({
  duration,
  peaks,
  cuts,
  silences,
  currentTime,
  getCurrentTime,
  snapEnabled,
  onRemoveCut,
  onAdjustCut,
  onSeek,
  onAddRange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const pendingScrollRef = useRef<number | null>(null);
  const [selections, setSelections] = useState<Selection[]>([]);
  const selIdRef = useRef(0);

  // Max zoom scales with clip length. Short clips don't need 200×;
  // long clips do. Caps prevent silly behavior at either end.
  const maxZoom = useMemo(() => {
    if (duration <= 0) return MAX_ZOOM_FLOOR;
    const ideal = duration / MAX_ZOOM_MIN_VISIBLE_SEC;
    return Math.max(MAX_ZOOM_FLOOR, Math.min(MAX_ZOOM_CEILING, ideal));
  }, [duration]);

  const { keptPath, cutPath } = useMemo(() => {
    if (peaks.length < 2 || duration <= 0) return { keptPath: "", cutPath: "" };
    const n = peaks.length;
    const keptRanges = invertCuts(duration, cuts);
    const cutRanges: { start: number; end: number }[] = [];
    let prevEnd = 0;
    for (const r of keptRanges) {
      if (r.start > prevEnd) cutRanges.push({ start: prevEnd, end: r.start });
      prevEnd = r.end;
    }
    if (prevEnd < duration) cutRanges.push({ start: prevEnd, end: duration });
    const buildSegments = (ranges: { start: number; end: number }[]) =>
      ranges
        .map((r) => envelopePathSegment(peaks, timeToBucket(r.start, duration, n), timeToBucket(r.end, duration, n)))
        .filter(Boolean)
        .join(" ");
    return { keptPath: buildSegments(keptRanges), cutPath: buildSegments(cutRanges) };
  }, [peaks, cuts, duration]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const t = getCurrentTime();
      if (playheadRef.current && duration > 0) {
        playheadRef.current.style.left = `${(t / duration) * 100}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getCurrentTime, duration]);

  useLayoutEffect(() => {
    if (pendingScrollRef.current !== null && hostRef.current) {
      hostRef.current.scrollLeft = pendingScrollRef.current;
      pendingScrollRef.current = null;
    }
  }, [zoom]);

  const applyZoom = useCallback(
    (newZoom: number, anchorClientX?: number) => {
      const clamped = Math.max(MIN_ZOOM, Math.min(maxZoom, newZoom));
      if (clamped === zoom) return;
      const host = hostRef.current;
      if (!host) {
        setZoom(clamped);
        return;
      }
      const rect = host.getBoundingClientRect();
      const anchor = anchorClientX != null ? anchorClientX - rect.left : rect.width / 2;
      const contentX = host.scrollLeft + anchor;
      const ratio = clamped / zoom;
      pendingScrollRef.current = contentX * ratio - anchor;
      setZoom(clamped);
    },
    [zoom, maxZoom],
  );

  // Wheel handler must be a NATIVE listener with passive:false — React's
  // synthetic wheel handlers are passive-by-default, so preventDefault() is
  // ignored and Chrome's built-in ⌘-scroll page-zoom fires anyway. Native
  // listener properly suppresses the page zoom and lets us own ⌘+scroll.
  const zoomRef = useRef(zoom);
  const applyZoomRef = useRef(applyZoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    applyZoomRef.current = applyZoom;
  }, [applyZoom]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheelNative = (e: WheelEvent) => {
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        e.stopPropagation();
        const delta = -e.deltaY * 0.025;
        applyZoomRef.current(zoomRef.current * (1 + delta), e.clientX);
      } else if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        host.scrollLeft += e.deltaY + e.deltaX;
      }
    };
    host.addEventListener("wheel", onWheelNative, { passive: false });
    return () => host.removeEventListener("wheel", onWheelNative);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (selections.length > 0 && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        for (const s of selections) onAddRange(s.start, s.end);
        setSelections([]);
        return;
      }
      if (selections.length > 0 && e.key === "Escape") {
        e.preventDefault();
        setSelections([]);
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        applyZoom(zoom * 1.25);
      } else if (e.key === "-") {
        e.preventDefault();
        applyZoom(zoom / 1.25);
      } else if (e.key === "0") {
        e.preventDefault();
        applyZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom, applyZoom, selections, onAddRange]);

  // Mousedown on waveform background: starts EITHER a click-seek OR a
  // drag that creates a new selection. Existing selections are preserved
  // and merge in on overlap.
  const onWaveMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest(".drag-handle")) return;
      if (target.closest(".selection-handle")) return;

      const rect = waveRef.current?.getBoundingClientRect();
      if (!rect) return;
      const startClientX = e.clientX;
      const startTRaw = ((startClientX - rect.left) / rect.width) * duration;
      let didDrag = false;
      // Snap auto-disables when zoomed in surgically OR when user turns it
      // off in settings. Alt-key live-overrides within a single drag.
      const visibleSec = zoom > 0 ? duration / zoom : duration;
      const baseTol =
        !snapEnabled || visibleSec < SNAP_DISABLE_BELOW_VISIBLE_SEC
          ? 0
          : SNAP_THRESHOLD_SEC;
      const initialSnap = snapTime(
        startTRaw,
        silences,
        e.altKey ? 0 : baseTol,
        "start",
      );

      const id = selIdRef.current++;
      setSelections((prev) => [...prev, { id, start: initialSnap, end: initialSnap }]);

      const onMove = (ev: MouseEvent) => {
        const dxPx = Math.abs(ev.clientX - startClientX);
        if (dxPx < DRAG_THRESHOLD_PX && !didDrag) return;
        didDrag = true;
        const tol = ev.altKey ? 0 : baseTol;
        const rawT = ((ev.clientX - rect.left) / rect.width) * duration;
        const rawLo = Math.min(startTRaw, rawT);
        const rawHi = Math.max(startTRaw, rawT);
        const lo = snapTime(rawLo, silences, tol, "start");
        const hi = snapTime(rawHi, silences, tol, "end");
        setSelections((prev) =>
          prev.map((s) =>
            s.id === id
              ? {
                  ...s,
                  start: Math.max(0, Math.min(duration, lo)),
                  end: Math.max(0, Math.min(duration, hi)),
                }
              : s,
          ),
        );
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (!didDrag) {
          // Click, not drag — remove the in-flight selection, seek.
          setSelections((prev) => prev.filter((s) => s.id !== id));
          onSeek(Math.max(0, Math.min(duration, startTRaw)));
        } else {
          // Drag finished — union-merge any selections that now overlap.
          setSelections((prev) => mergeAllSelections(prev));
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [duration, onSeek, silences, zoom],
  );

  // Drag the start/end edge of an existing selection.
  const startSelectionDrag = useCallback(
    (id: number, edge: "start" | "end") => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = waveRef.current?.getBoundingClientRect();
      if (!rect) return;
      const initial = selections.find((s) => s.id === id);
      if (!initial) return;
      let lastVal = edge === "start" ? initial.start : initial.end;
      let lastX = e.clientX;

      const visibleSec = zoom > 0 ? duration / zoom : duration;
      const baseTol =
        !snapEnabled || visibleSec < SNAP_DISABLE_BELOW_VISIBLE_SEC
          ? 0
          : SNAP_THRESHOLD_SEC;
      const onMove = (ev: MouseEvent) => {
        const tol = ev.altKey ? 0 : baseTol;
        const dxT = ((ev.clientX - lastX) / rect.width) * duration;
        const newVal = lastVal + dxT;
        lastX = ev.clientX;
        lastVal = newVal;
        const snapped = snapTime(newVal, silences, tol, edge);
        setSelections((prev) =>
          prev.map((s) => {
            if (s.id !== id) return s;
            if (edge === "start") {
              return { ...s, start: Math.max(0, Math.min(s.end - 0.05, snapped)) };
            }
            return { ...s, end: Math.max(s.start + 0.05, Math.min(duration, snapped)) };
          }),
        );
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        setSelections((prev) => mergeAllSelections(prev));
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [selections, duration, silences, zoom, snapEnabled],
  );

  const startCutDrag = useCallback(
    (idx: number, edge: "start" | "end") => (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = waveRef.current?.getBoundingClientRect();
      if (!rect) return;
      const startCut = cuts[idx];
      let lastVal = edge === "start" ? startCut.start : startCut.end;
      let lastX = e.clientX;
      const visibleSec = zoom > 0 ? duration / zoom : duration;
      const baseTol =
        !snapEnabled || visibleSec < SNAP_DISABLE_BELOW_VISIBLE_SEC
          ? 0
          : SNAP_THRESHOLD_SEC;
      const onMove = (ev: MouseEvent) => {
        const tol = ev.altKey ? 0 : baseTol;
        const dxT = ((ev.clientX - lastX) / rect.width) * duration;
        const newVal = lastVal + dxT;
        lastX = ev.clientX;
        lastVal = newVal;
        const snapped = snapTime(newVal, silences, tol, edge);
        if (edge === "start") {
          const newStart = Math.max(0, Math.min(startCut.end - 0.05, snapped));
          onAdjustCut(idx, newStart, startCut.end);
        } else {
          const newEnd = Math.max(startCut.start + 0.05, Math.min(duration, snapped));
          onAdjustCut(idx, startCut.start, newEnd);
        }
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [cuts, duration, onAdjustCut, silences, zoom, snapEnabled],
  );

  return (
    <div className="waveform-section">
      <div className="zoom-indicator">
        <span>{zoom.toFixed(1)}×</span>
      </div>
      <div className="scroll-host" ref={hostRef}>
        <div className="zoom-inner" style={{ width: `${zoom * 100}%` }}>
          <div className="waveform-wrap" ref={waveRef} onMouseDown={onWaveMouseDown}>
            <svg
              className="wave-svg"
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              preserveAspectRatio="none"
              aria-hidden
            >
              {cutPath && <path className="cut" d={cutPath} />}
              {keptPath && <path className="kept" d={keptPath} />}
            </svg>

            <div className="zero-line" />

            {cuts.map((c, idx) => {
              const left = (c.start / duration) * 100;
              const width = ((c.end - c.start) / duration) * 100;
              return (
                <div
                  key={idx}
                  className="cut-region"
                  style={{ left: `${left}%`, width: `${width}%` }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onRemoveCut(idx);
                  }}
                >
                  <div
                    className="drag-handle drag-handle-start"
                    onMouseDown={startCutDrag(idx, "start")}
                  />
                  <div
                    className="drag-handle drag-handle-end"
                    onMouseDown={startCutDrag(idx, "end")}
                  />
                </div>
              );
            })}

            {selections.map((sel) => (
              <div
                key={sel.id}
                className="selection"
                style={{
                  left: `${(sel.start / duration) * 100}%`,
                  width: `${((sel.end - sel.start) / duration) * 100}%`,
                }}
              >
                <div
                  className="selection-handle selection-handle-start"
                  onMouseDown={startSelectionDrag(sel.id, "start")}
                />
                <div
                  className="selection-handle selection-handle-end"
                  onMouseDown={startSelectionDrag(sel.id, "end")}
                />
              </div>
            ))}

            <div className="playhead" ref={playheadRef} />
          </div>

          <div className="ruler">
            {[0, 0.25, 0.5, 0.75, 1].map((p) => (
              <span key={p}>{fmtTime(p * duration)}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
