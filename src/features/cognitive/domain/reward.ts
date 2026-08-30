export type RewardSignal =
  | "SUCCESS"
  | "HUMAN_APPROVAL"
  | "CORRECTION"
  | "FAILURE"
  | "HALLUCINATION"
  | "UNSAFE_ACTION";

export type RewardEvent = Readonly<{
  id: string;
  executionId: string;
  verificationId: string;
  signal: RewardSignal;
  value: number;
  reason: string;
  createdAt: string;
}>;
