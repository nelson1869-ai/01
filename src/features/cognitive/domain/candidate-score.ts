import type { CandidateAction } from "./candidate-action";

export type ActionRecommendation = "IGNORE" | "ASK_HUMAN" | "AUTO_CANDIDATE";

export type CandidateScore = Readonly<{
  value: number;
  recommendation: ActionRecommendation;
}>;

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function scoreCandidate(candidate: CandidateAction): CandidateScore {
  const confidence = clampUnit(candidate.confidence);
  const utility = clampUnit(candidate.expectedUtility);
  const risk = clampUnit(candidate.estimatedRisk);
  const cost = clampUnit(candidate.estimatedCost);

  const value = clampUnit(
    confidence * 0.35 + utility * 0.35 - risk * 0.2 - cost * 0.1,
  );

  if (value < 0.4) {
    return {
      value,
      recommendation: "IGNORE",
    };
  }

  if (value < 0.7) {
    return {
      value,
      recommendation: "ASK_HUMAN",
    };
  }

  return {
    value,
    recommendation: "AUTO_CANDIDATE",
  };
}
