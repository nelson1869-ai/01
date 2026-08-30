export type EvidenceSource =
  | "tool"
  | "api"
  | "database"
  | "document"
  | "memory"
  | "human";

export type Evidence = Readonly<{
  id: string;
  source: EvidenceSource;
  sourceId: string;
  claim: string;
  observedAt: string;
}>;

export type GroundingStatus =
  | "VERIFIED"
  | "INSUFFICIENT_EVIDENCE"
  | "CONFLICTING_EVIDENCE";

export type GroundingResult = Readonly<{
  candidateId: string;
  status: GroundingStatus;
  confidence: number;
  evidence: readonly Evidence[];
  reason: string;
}>;
