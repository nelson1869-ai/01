export type ObservationSource =
  | "tool"
  | "api"
  | "database"
  | "browser"
  | "file"
  | "human";

export type Observation = Readonly<{
  id: string;
  executionId: string;
  stepId: string | null;
  source: ObservationSource;
  summary: string;
  data: Readonly<Record<string, unknown>>;
  observedAt: string;
}>;
