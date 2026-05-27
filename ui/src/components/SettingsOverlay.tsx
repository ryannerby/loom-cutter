import { useEffect } from "react";
import type { ColorPreset, RenderSettings } from "../types";
import "./SettingsOverlay.css";

interface Props {
  open: boolean;
  settings: RenderSettings;
  onChange: (next: RenderSettings) => void;
  onClose: () => void;
}

const COLOR_OPTIONS: { value: ColorPreset; label: string; desc: string }[] = [
  { value: "natural", label: "Natural", desc: "No color adjustment (raw)" },
  { value: "warm", label: "Warm", desc: "Slight red shift + warmth" },
  { value: "vivid", label: "Vivid", desc: "Punchier saturation + contrast" },
];

export default function SettingsOverlay({ open, settings, onChange, onClose }: Props) {
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
    <div className="settings-backdrop" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Render Settings</h2>
          <button className="settings-close" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Voice enhancement</div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.voiceEnhance}
              onChange={(e) => onChange({ ...settings, voiceEnhance: e.target.checked })}
            />
            <span className="settings-toggle-label">
              <span>{settings.voiceEnhance ? "On" : "Off"}</span>
              <span className="settings-toggle-desc">
                highpass · compressor · de-esser · presence EQ · exciter · limiter · loudnorm
              </span>
            </span>
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Color preset</div>
          <div className="settings-radios">
            {COLOR_OPTIONS.map((opt) => (
              <label key={opt.value} className="settings-radio">
                <input
                  type="radio"
                  name="color"
                  value={opt.value}
                  checked={settings.colorPreset === opt.value}
                  onChange={() => onChange({ ...settings, colorPreset: opt.value })}
                />
                <span className="settings-radio-label">
                  <span>{opt.label}</span>
                  <span className="settings-toggle-desc">{opt.desc}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Editor</div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.snapToSilence}
              onChange={(e) => onChange({ ...settings, snapToSilence: e.target.checked })}
            />
            <span className="settings-toggle-label">
              <span>{settings.snapToSilence ? "Snap drag-select edges to silence" : "Snap off — exact mouse position"}</span>
              <span className="settings-toggle-desc">
                When on, cut boundaries land on nearby quiet within 200ms.
                Hold <kbd className="kbd-inline">⌥</kbd> while dragging to override momentarily either way.
              </span>
            </span>
          </label>
        </div>

        <div className="settings-footnote">
          Settings persist across sessions. Render settings apply at <strong>render time</strong> — no re-render needed when you change them, just hit Render again.
        </div>
      </div>
    </div>
  );
}
