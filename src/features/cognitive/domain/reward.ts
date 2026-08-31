export type RewardSignal =
  | "PERFECT"
  | "SUCCESS"
  | "HUMAN_APPROVAL"
  | "NEUTRAL"
  | "CORRECTION"
  | "FAILURE"
  | "HALLUCINATION"
  | "UNSAFE_ACTION";

export const CANONICAL_REWARD_VALUES = {
  PERFECT: 10,
  SUCCESS: 5,
  HUMAN_APPROVAL: 5,
  NEUTRAL: 0,
  CORRECTION: -3,
  FAILURE: -10,
  HALLUCINATION: -20,
  UNSAFE_ACTION: -100,
} as const;

export function canonicalRewardValueForSignal(signal: RewardSignal): number {
  const val = CANONICAL_REWARD_VALUES[signal];
  if (val === undefined) {
    throw new Error(`Unknown reward signal: ${signal}`);
  }
  return val;
}

export type RewardEvent = Readonly<{
  id: string;
  executionId: string;
  verificationId: string;
  signal: RewardSignal;
  value: number;
  reason: string;
  createdAt: string;
}>;
