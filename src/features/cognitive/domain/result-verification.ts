export type VerificationStatus = "VERIFIED" | "FAILED" | "INCONCLUSIVE";

export type ResultVerification = Readonly<{
  id: string;
  executionId: string;
  observationIds: readonly string[];
  status: VerificationStatus;
  confidence: number;
  reason: string;
  verifiedAt: string;
}>;
