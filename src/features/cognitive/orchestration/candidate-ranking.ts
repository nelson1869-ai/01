import {
  type ActionRecommendation,
  scoreCandidate,
} from "../domain/candidate-score";
import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedLearningState } from "../persistence/postgres/repositories/learning-repository";

export interface CandidateRankingScore {
  readonly candidateId: string;
  readonly baseScore: number;
  readonly learningDelta: number;
  readonly finalScore: number;
  readonly recommendation: ActionRecommendation;
}

export function calculateLearningAwareScore(
  candidate: PersistedCandidateAction,
  learningState: PersistedLearningState,
): CandidateRankingScore {
  const base = scoreCandidate({
    id: candidate.candidateId,
    cueId: candidate.cueId,
    goal: candidate.goal,
    action: candidate.action,
    confidence: candidate.confidence,
    expectedUtility: candidate.expectedUtility,
    estimatedRisk: candidate.estimatedRisk,
    estimatedCost: candidate.estimatedCost,
    evidence: candidate.evidenceIds,
  });

  // Evidence weight scales from 0 to 1 at 20 samples
  const evidenceWeight = Math.min(learningState.sampleCount / 20, 1);
  const learningDelta =
    (learningState.confidence - 0.5) * 0.1 * evidenceWeight;
  const finalScore = Math.min(1, Math.max(0, base.value + learningDelta));

  let recommendation: ActionRecommendation;
  if (finalScore < 0.4) {
    recommendation = "IGNORE";
  } else if (finalScore < 0.7) {
    recommendation = "ASK_HUMAN";
  } else {
    // Note: AUTO_CANDIDATE means candidate may proceed to grounding evaluation.
    // It NEVER grants autonomous execution permission.
    recommendation = "AUTO_CANDIDATE";
  }

  return {
    candidateId: candidate.candidateId,
    baseScore: Number(base.value.toFixed(4)),
    learningDelta: Number(learningDelta.toFixed(4)),
    finalScore: Number(finalScore.toFixed(4)),
    recommendation,
  };
}

export function rankCandidates(
  candidates: readonly PersistedCandidateAction[],
  learningState: PersistedLearningState,
): readonly CandidateRankingScore[] {
  const scored = candidates.map((c) =>
    calculateLearningAwareScore(c, learningState),
  );

  // Deterministic sort: finalScore DESC, then candidateId ASC for ties
  return [...scored].sort((a, b) => {
    const diff = b.finalScore - a.finalScore;
    if (Math.abs(diff) > 1e-6) {
      return diff;
    }
    return a.candidateId.localeCompare(b.candidateId);
  });
}
