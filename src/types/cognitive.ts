/**
 * AutoDo AI - Core Cognitive Cycle Domain Types
 * Strict, immutable state and phase representations.
 */

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

export interface AgentContext {
  readonly sessionId: string;
  readonly phase: CognitivePhase;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly cooldownUntilMs: number | null;
  readonly workingMemory: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface CandidateAction {
  readonly id: string;
  readonly toolName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly confidenceScore: number;
  readonly isGrounded: boolean;
  readonly rationale: string;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly score: number;
  readonly failureReason?: string;
  readonly auditEvidence?: Readonly<Record<string, unknown>>;
}
