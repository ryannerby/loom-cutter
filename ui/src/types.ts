// Mirror server/main.py response shapes.

export interface Word {
  word: string;
  start: number;
  end: number;
  probability: number;
}

export type CutReason =
  | "REPEATED_TAKE"
  | "FALSE_START"
  | "LONG_PAUSE"
  | "DEAD_SPACE"
  | "MANUAL";

export interface Cut {
  start: number;
  end: number;
  reason: CutReason;
  note?: string;
  source?: string;
  from?: number;
  to?: number;
  // Legacy: older saves had cuts that could be toggled off. Loader filters
  // these out so the rest of the app can treat every cut as active. Kept
  // here for type-checking against snapshots / cuts.history files.
  active?: boolean;
}

export interface Silence {
  start: number;
  end: number;
  duration: number;
}

export interface Peaks {
  duration?: number;
  n: number;
  peaks: number[];
}

export type Stage =
  | "transcribing"
  | "extracting_peaks"
  | "detecting_silences"
  | "llm_edit"
  | "snapping"
  | "ready"
  | "error";

export interface ProjectStatus {
  stage: Stage;
  error: string | null;
  started_at?: string;
  stage_at?: string;
  audio_duration?: number; // seconds — used by UI for ETA / progress estimation
}

export interface ProjectState {
  id: string;
  duration: number;
  language?: string;
  words: Word[];
  text: string;
  cuts: Cut[];
  silences: Silence[];
  peaks: Peaks;
  has_output: boolean;
  status: ProjectStatus | null;
}

export interface ProjectSummary {
  id: string;
  has_words: boolean;
  has_cuts: boolean;
  has_output: boolean;
}

export type ColorPreset = "natural" | "warm" | "vivid";

export interface RenderSettings {
  voiceEnhance: boolean;
  colorPreset: ColorPreset;
}

export const DEFAULT_SETTINGS: RenderSettings = {
  voiceEnhance: true,
  colorPreset: "natural",
};
