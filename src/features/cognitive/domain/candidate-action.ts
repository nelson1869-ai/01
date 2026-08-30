export type CandidateAction = Readonly<{
  id: string;
  cueId: string;
  goal: string;
  action: string;

  confidence: number;
  expectedUtility: number;
  estimatedRisk: number;
  estimatedCost: number;

  evidence: readonly string[];
}>;
