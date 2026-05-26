import { useEffect, useMemo, useRef, useState } from "react";
import type { Cut, Word } from "../types";
import "./Transcript.css";

interface Props {
  words: Word[];
  cuts: Cut[];
  currentTime: number;
  onSeek: (t: number) => void;
  onAddCutRange: (fromIdx: number, toIdx: number) => void;
  onRemoveCut: (idx: number) => void;
  onUncutRange: (fromIdx: number, toIdx: number) => void;
}

interface Selection {
  anchor: number;
  focus: number;
}

export default function Transcript({
  words,
  cuts,
  currentTime,
  onSeek,
  onAddCutRange,
  onRemoveCut,
  onUncutRange,
}: Props) {
  const [selection, setSelection] = useState<Selection | null>(null);
  // dragRef stores in-flight drag state so we can distinguish click vs drag on mouseup.
  const dragRef = useRef<{ startIdx: number; word: Word; didDrag: boolean } | null>(null);

  // Per-word metadata: is it cut, and which cut entry contains it.
  const wordMeta = useMemo(() => {
    return words.map((w) => {
      const mid = (w.start + w.end) / 2;
      for (let k = 0; k < cuts.length; k++) {
        const c = cuts[k];
        if ((c.active ?? true) && mid >= c.start && mid <= c.end) {
          return { isCut: true, cutIdx: k };
        }
      }
      return { isCut: false, cutIdx: null as number | null };
    });
  }, [words, cuts]);

  const currentIdx = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < words.length; i++) {
      if (words[i].start <= currentTime + 0.02) idx = i;
      else break;
    }
    return idx;
  }, [words, currentTime]);

  // Document-level mouseup: distinguish click (no drag) from drag-finish.
  useEffect(() => {
    const onUp = () => {
      const d = dragRef.current;
      if (d && !d.didDrag) {
        // It was a click — seek to the word.
        onSeek(d.word.start + 0.02);
        // Collapse selection to that word (so Delete after a click cuts just it).
        setSelection({ anchor: d.startIdx, focus: d.startIdx });
      }
      dragRef.current = null;
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [onSeek]);

  // Keyboard: Delete/Backspace cuts the selection, Esc clears.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;

      if (e.key === "Escape") {
        if (selection) {
          e.preventDefault();
          setSelection(null);
        }
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        const min = Math.min(selection.anchor, selection.focus);
        const max = Math.max(selection.anchor, selection.focus);
        e.preventDefault();
        onAddCutRange(min, max);
        setSelection(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, onAddCutRange]);

  const onWordMouseDown = (e: React.MouseEvent, idx: number, w: Word) => {
    if (e.button !== 0) return;
    // Shift-click extends the existing selection's focus instead of starting fresh.
    if (e.shiftKey) {
      e.preventDefault();
      setSelection((prev) =>
        prev ? { anchor: prev.anchor, focus: idx } : { anchor: idx, focus: idx },
      );
      return;
    }
    // Suppress native text-selection — we draw our own.
    e.preventDefault();
    dragRef.current = { startIdx: idx, word: w, didDrag: false };
    setSelection({ anchor: idx, focus: idx });
  };

  const onWordMouseEnter = (idx: number) => {
    const d = dragRef.current;
    if (!d) return;
    d.didDrag = true;
    setSelection((prev) =>
      prev ? { anchor: prev.anchor, focus: idx } : { anchor: idx, focus: idx },
    );
  };

  const onWordContext = (e: React.MouseEvent, idx: number, cutIdx: number | null) => {
    e.preventDefault();
    // If there's an active multi-word selection that includes this word,
    // right-click means "uncut this range" — split active cuts so the
    // selected (possibly currently-cut) words become kept.
    if (selection) {
      const min = Math.min(selection.anchor, selection.focus);
      const max = Math.max(selection.anchor, selection.focus);
      if (min !== max && idx >= min && idx <= max) {
        onUncutRange(min, max);
        setSelection(null);
        return;
      }
    }
    // No multi-word selection — right-click on a cut word deletes the cut,
    // on a kept word makes a single-word cut.
    if (cutIdx !== null) {
      onRemoveCut(cutIdx);
    } else {
      onAddCutRange(idx, idx);
    }
  };

  const selMin = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const selMax = selection ? Math.max(selection.anchor, selection.focus) : -1;
  const selSpans = selection && selMin !== selMax; // only highlight multi-word selections

  return (
    <div className="transcript-section">
      <p className="transcript">
        {words.map((w, idx) => {
          const meta = wordMeta[idx];
          const classes = ["word"];
          if (meta.isCut) classes.push("cut");
          if (idx === currentIdx) classes.push("current");
          // Selected highlight: include cut words too — user might want to
          // uncut a subsection. Single-word collapsed selections still skip
          // the highlight (no visual noise for a plain click).
          if (selSpans && idx >= selMin && idx <= selMax) {
            classes.push("selected");
          }
          return (
            <span
              key={idx}
              data-word-idx={idx}
              className={classes.join(" ")}
              onMouseDown={(e) => onWordMouseDown(e, idx, w)}
              onMouseEnter={() => onWordMouseEnter(idx)}
              onContextMenu={(e) => onWordContext(e, idx, meta.cutIdx)}
              title={`${w.start.toFixed(2)}s · click=seek · drag=select · right-click=remove`}
            >
              {w.word}
            </span>
          );
        })}
      </p>
      <div className="transcript-hint">
        drag to select · <kbd>delete</kbd> to cut · select + right-click to uncut · right-click cut to remove · <kbd>⌘Z</kbd> undo
      </div>
    </div>
  );
}
