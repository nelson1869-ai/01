export type ExecutionStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "BLOCKED";

export type ExecutionRecord = Readonly<{
  id: string;
  planId: string;
  status: ExecutionStatus;
  currentStepId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}>;
