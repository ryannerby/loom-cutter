import type { ProjectStatus, Stage } from "../types";
import "./ImportStatus.css";

interface Props {
  projectId: string;
  status: ProjectStatus;
  uploadProgress: number | null;
}

const STAGES: { key: Stage; label: string; hint: string }[] = [
  { key: "transcribing", label: "Transcribing audio", hint: "≈ 1× realtime" },
  { key: "extracting_peaks", label: "Building waveform", hint: "fast" },
  { key: "detecting_silences", label: "Detecting silences", hint: "fast" },
  { key: "llm_edit", label: "AI edit decisions", hint: "~15s" },
  { key: "snapping", label: "Finalizing cuts", hint: "fast" },
  { key: "ready", label: "Ready", hint: "" },
];

export default function ImportStatus({ projectId, status, uploadProgress }: Props) {
  const isError = status.stage === "error";
  const activeIdx = STAGES.findIndex((s) => s.key === status.stage);

  return (
    <div className="import-status">
      <h2>{isError ? "Import failed" : "Importing…"}</h2>
      <div className="import-id">{projectId}</div>

      {uploadProgress !== null && uploadProgress < 1 && (
        <div className="upload-bar">
          <div className="upload-bar-fill" style={{ width: `${uploadProgress * 100}%` }} />
          <span className="upload-bar-label">
            uploading · {(uploadProgress * 100).toFixed(0)}%
          </span>
        </div>
      )}

      <ol className="steps">
        {STAGES.map((s, i) => {
          const done = !isError && i < activeIdx;
          const active = !isError && i === activeIdx;
          return (
            <li key={s.key} className={`step ${done ? "done" : ""} ${active ? "active" : ""}`}>
              <span className="step-dot" />
              <span className="step-label">{s.label}</span>
              {s.hint && <span className="step-hint">{s.hint}</span>}
            </li>
          );
        })}
      </ol>

      {isError && status.error && (
        <div className="import-error">{status.error}</div>
      )}
    </div>
  );
}
