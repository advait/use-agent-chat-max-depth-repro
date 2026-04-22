export const REPLAY_AGENT_RUNTIME_NAME = "TraceReplayAgent";

export const DEFAULT_PROMPT = "Trigger the captured multi-tool trace replay.";
export const DEFAULT_REPLAY_SPEED_MULTIPLIER = 4;

export const REPLAY_SPEED_OPTIONS = [
  { label: "4x faster (repro default)", value: 4 },
  { label: "2x faster", value: 2 },
  { label: "1x captured", value: 1 },
] as const;

export interface ReplayFixtureSummary {
  readonly captureRequestId: string;
  readonly durationMs: number;
  readonly inputAvailableCount: number;
  readonly inputDeltaCount: number;
  readonly outputAvailableCount: number;
  readonly toolCount: number;
}
