export type CognitivePhase =
  | "CUE"
  | "PERCEIVE"
  | "BUILD_CONTEXT"
  | "RETRIEVE_MEMORY"
  | "GENERATE_CANDIDATES"
  | "SCORE"
  | "GROUND_VERIFY"
  | "POLICY_SAFETY"
  | "PLAN"
  | "DURABLE_EXECUTION"
  | "ACT"
  | "OBSERVE"
  | "VERIFY_RESULT"
  | "REWARD"
  | "LEARN"
  | "SAVE_MEMORY"
  | "CLEAR_WORKING_MEMORY"
  | "IDLE";

export type FailureStatus =
  | "HALLUCINATION_DETECTED"
  | "POLICY_VIOLATION"
  | "EXECUTION_TIMEOUT"
  | "UNVERIFIED_RESULT"
  | "COOLDOWN_ACTIVE"
  | "ESCALATED_TO_HUMAN";

export type AgentContext = Readonly<{
  sessionId: string;
  phase: CognitivePhase;
  retryCount: number;
  maxRetries: number;
  cooldownUntilMs: number | null;
  workingMemory: Readonly<Record<string, unknown>>;
  createdAt: string;
}>;
