export const REPLAY_AGENT_RUNTIME_NAME = "TraceReplayAgent";

export const DEFAULT_PROMPT = "Trigger the captured multi-tool trace replay.";
export const DEFAULT_REPLAY_SPEED_MULTIPLIER = 8;

export interface ReplayFixtureSummary {
  readonly captureRequestId: string;
  readonly durationMs: number;
  readonly inputAvailableCount: number;
  readonly inputDeltaCount: number;
  readonly outputAvailableCount: number;
  readonly toolCount: number;
}
