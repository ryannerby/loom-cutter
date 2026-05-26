import { useEffect } from "react";
import "./ShortcutsOverlay.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ShortcutRow {
  keys: string[];
  desc: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

const GROUPS: ShortcutGroup[] = [
  {
    title: "Playback",
    rows: [
      { keys: ["space"], desc: "play / pause" },
      { keys: ["←", "→"], desc: "seek ±1s" },
      { keys: ["⇧", "←"], desc: "seek ±10s (with arrow)" },
      { keys: ["j", "l"], desc: "seek ±2s (YouTube style)" },
    ],
  },
  {
    title: "Cuts (waveform)",
    rows: [
      { keys: ["click"], desc: "seek (auto-skips into next kept region)" },
      { keys: ["drag"], desc: "select range on waveform" },
      { keys: ["⌫", "del"], desc: "cut the selected range" },
      { keys: ["esc"], desc: "clear selection" },
      { keys: ["right-click"], desc: "remove cut (⌘Z to restore)" },
      { keys: ["x"], desc: "remove cut at playhead" },
      { keys: ["drag handles"], desc: "nudge cut boundaries" },
    ],
  },
  {
    title: "Cuts (transcript)",
    rows: [
      { keys: ["drag"], desc: "select whole words (cut + kept)" },
      { keys: ["select", "del"], desc: "cut highlighted text" },
      { keys: ["select", "right-click"], desc: "uncut highlighted text" },
      { keys: ["right-click"], desc: "remove cut / cut single word" },
      { keys: ["shift", "click"], desc: "extend selection to word" },
      { keys: ["click"], desc: "seek to word" },
    ],
  },
  {
    title: "History",
    rows: [
      { keys: ["⌘", "z"], desc: "undo (up to 50 actions)" },
      { keys: ["⌘", "⇧", "z"], desc: "redo" },
    ],
  },
  {
    title: "Zoom",
    rows: [
      { keys: ["⌘", "scroll"], desc: "zoom waveform at cursor" },
      { keys: ["⇧", "scroll"], desc: "pan waveform horizontally" },
      { keys: ["⌘", "+"], desc: "zoom in" },
      { keys: ["⌘", "-"], desc: "zoom out" },
      { keys: ["⌘", "0"], desc: "reset zoom" },
    ],
  },
  {
    title: "Action",
    rows: [
      { keys: ["r"], desc: "render" },
      { keys: ["?"], desc: "show this panel" },
      { keys: ["esc"], desc: "close this panel" },
    ],
  },
];

export default function ShortcutsOverlay({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-header">
          <h2>Shortcuts</h2>
          <button className="overlay-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>
        <div className="overlay-grid">
          {GROUPS.map((g) => (
            <div className="overlay-group" key={g.title}>
              <div className="overlay-group-title">{g.title}</div>
              {g.rows.map((r, i) => (
                <div className="overlay-row" key={i}>
                  <div className="overlay-keys">
                    {r.keys.map((k, j) => (
                      <kbd key={j}>{k}</kbd>
                    ))}
                  </div>
                  <div className="overlay-desc">{r.desc}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
