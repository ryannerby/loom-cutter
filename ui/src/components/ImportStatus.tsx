import { useEffect, useState } from "react";
import type { ProjectStatus, Stage } from "../types";
import "./ImportStatus.css";

interface Props {
  projectId: string;
  status: ProjectStatus;
  uploadProgress: number | null;
}

interface StageDef {
  key: Stage;
  label: string;
  // Estimated duration in seconds, given the audio duration. Numbers
  // come from observed runtimes on M-series CPUs.
  estimate: (audioSec: number) => number;
}

const STAGE_DEFS: StageDef[] = [
  { key: "transcribing", label: "Transcribing audio", estimate: (s) => Math.max(20, s * 0.55) },
  { key: "extracting_peaks", label: "Building waveform", estimate: () => 2 },
  { key: "detecting_silences", label: "Detecting silences", estimate: () => 1 },
  { key: "llm_edit", label: "AI edit decisions", estimate: () => 15 },
  { key: "snapping", label: "Finalizing cuts", estimate: () => 1 },
  { key: "ready", label: "Ready", estimate: () => 0 },
];

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ImportStatus({ projectId, status, uploadProgress }: Props) {
  const isError = status.stage === "error";
  const activeIdx = STAGE_DEFS.findIndex((s) => s.key === status.stage);
  const audioSec = status.audio_duration ?? 60;

  // Live elapsed timer for the active stage + overall.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (isError || status.stage === "ready") return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [isError, status.stage]);

  const startedMs = status.started_at ? new Date(status.started_at).getTime() : now;
  const stageStartedMs = status.stage_at ? new Date(status.stage_at).getTime() : startedMs;
  const elapsedOverallSec = Math.max(0, (now - startedMs) / 1000);
  const elapsedStageSec = Math.max(0, (now - stageStartedMs) / 1000);

  const totalEstimateSec = STAGE_DEFS.slice(0, -1).reduce(
    (a, s) => a + s.estimate(audioSec),
    0,
  );
  // Overall progress: completed stages + fraction of active stage.
  let weightDone = 0;
  for (let i = 0; i < activeIdx; i++) weightDone += STAGE_DEFS[i].estimate(audioSec);
  const activeEst = activeIdx >= 0 ? STAGE_DEFS[activeIdx].estimate(audioSec) : 0;
  const activeFraction = activeEst > 0 ? Math.min(1, elapsedStageSec / activeEst) : 0;
  const overallFraction =
    totalEstimateSec > 0
      ? Math.min(0.99, (weightDone + activeFraction * activeEst) / totalEstimateSec)
      : 0;

  return (
    <div className="import-status">
      <h2>{isError ? "Import failed" : "Importing…"}</h2>
      <div className="import-id">
        {projectId}
        {status.audio_duration ? (
          <span className="import-meta">
            {" · "}
            {fmt(status.audio_duration)} of audio · est. {fmt(totalEstimateSec)}
          </span>
        ) : null}
      </div>

      {uploadProgress !== null && uploadProgress < 1 && (
        <div className="upload-bar">
          <div className="upload-bar-fill" style={{ width: `${uploadProgress * 100}%` }} />
          <span className="upload-bar-label">
            uploading · {(uploadProgress * 100).toFixed(0)}%
          </span>
        </div>
      )}

      {!isError && status.stage !== "ready" && (
        <div className="progress-bar">
          <div
            className="progress-bar-fill"
            style={{ width: `${Math.max(2, overallFraction * 100)}%` }}
          />
          <div className="progress-bar-label">
            <span>elapsed {fmt(elapsedOverallSec)}</span>
            <span>{Math.round(overallFraction * 100)}%</span>
          </div>
        </div>
      )}

      <ol className="steps">
        {STAGE_DEFS.map((s, i) => {
          const done = !isError && i < activeIdx;
          const active = !isError && i === activeIdx;
          const est = s.estimate(audioSec);
          return (
            <li
              key={s.key}
              className={`step ${done ? "done" : ""} ${active ? "active" : ""}`}
            >
              <span className="step-dot" />
              <span className="step-label">{s.label}</span>
              <span className="step-hint">
                {active && est > 0
                  ? `${fmt(elapsedStageSec)} / ~${fmt(est)}`
                  : done
                  ? "✓"
                  : est > 0
                  ? `~${fmt(est)}`
                  : ""}
              </span>
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
