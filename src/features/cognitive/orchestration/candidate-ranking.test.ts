import { describe, expect, it } from "vitest";

import type { PersistedCandidateAction } from "../persistence/contracts/persisted-candidate-action";
import type { PersistedLearningState } from "../persistence/postgres/repositories/learning-repository";
import {
  calculateLearningAwareScore,
  rankCandidates,
} from "./candidate-ranking";

describe("learning-aware candidate scoring and ranking unit tests", () => {
  const baseCandidate: PersistedCandidateAction = {
    candidateId: "cand-1",
    sessionId: "sess-1",
    cueId: "cue-1",
    evaluationGeneration: 1,
    goal: "Process notification",
    action: "email.send",
    confidence: 0.8,
    expectedUtility: 0.8,
    estimatedRisk: 0.1,
    estimatedCost: 0.1,
    scoreValue: 0.5,
    recommendation: "AUTO_CANDIDATE",
    scoreFormulaVersion: "v1",
    evidenceIds: [],
    createdAt: "2026-08-31T05:00:00.000Z",
  };

  it("yields learningDelta = 0 when sample count is 0", () => {
    const neutralLearning: PersistedLearningState = {
      skillKey: "email.send",
      confidence: 0.9,
      totalReward: 100,
      sampleCount: 0,
      rowVersion: 0,
      updatedAt: "2026-08-31T05:00:00.000Z",
    };

    const scored = calculateLearningAwareScore(baseCandidate, neutralLearning);
    expect(scored.learningDelta).toBe(0);
    expect(scored.finalScore).toBe(scored.baseScore);
  });

  it("bounds learning delta near +/- 0.05", () => {
    const maxPositiveLearning: PersistedLearningState = {
      skillKey: "email.send",
      confidence: 1.0,
      totalReward: 500,
      sampleCount: 50,
      rowVersion: 1,
      updatedAt: "2026-08-31T05:00:00.000Z",
    };

    const maxNegativeLearning: PersistedLearningState = {
      skillKey: "email.send",
      confidence: 0.0,
      totalReward: -500,
      sampleCount: 50,
      rowVersion: 1,
      updatedAt: "2026-08-31T05:00:00.000Z",
    };

    const pos = calculateLearningAwareScore(baseCandidate, maxPositiveLearning);
    const neg = calculateLearningAwareScore(baseCandidate, maxNegativeLearning);

    expect(pos.learningDelta).toBeCloseTo(0.05, 4);
    expect(neg.learningDelta).toBeCloseTo(-0.05, 4);
  });

  it("ensures final score remains strictly in [0, 1]", () => {
    const perfectCandidate: PersistedCandidateAction = {
      ...baseCandidate,
      confidence: 1.0,
      expectedUtility: 1.0,
      estimatedRisk: 0.0,
      estimatedCost: 0.0,
    };

    const maxPositiveLearning: PersistedLearningState = {
      skillKey: "email.send",
      confidence: 1.0,
      totalReward: 500,
      sampleCount: 50,
      rowVersion: 1,
      updatedAt: "2026-08-31T05:00:00.000Z",
    };

    const scored = calculateLearningAwareScore(
      perfectCandidate,
      maxPositiveLearning,
    );
    expect(scored.finalScore).toBeLessThanOrEqual(1.0);
    expect(scored.finalScore).toBeGreaterThanOrEqual(0.0);
  });

  it("ranks candidates deterministically breaking ties by candidateId ASC", () => {
    const neutralLearning: PersistedLearningState = {
      skillKey: "email.send",
      confidence: 0.5,
      totalReward: 0,
      sampleCount: 0,
      rowVersion: 0,
      updatedAt: "2026-08-31T05:00:00.000Z",
    };

    const cB: PersistedCandidateAction = {
      ...baseCandidate,
      candidateId: "cand-B",
    };
    const cA: PersistedCandidateAction = {
      ...baseCandidate,
      candidateId: "cand-A",
    };

    const ranked = rankCandidates([cB, cA], neutralLearning);
    expect(ranked[0].candidateId).toBe("cand-A");
    expect(ranked[1].candidateId).toBe("cand-B");
  });

  it("categorizes recommendations into IGNORE, ASK_HUMAN, and AUTO_CANDIDATE", () => {
    const neutralLearning: PersistedLearningState = {
      skillKey: "email.send",
      confidence: 0.5,
      totalReward: 0,
      sampleCount: 0,
      rowVersion: 0,
      updatedAt: "2026-08-31T05:00:00.000Z",
    };

    const lowScoreCand: PersistedCandidateAction = {
      ...baseCandidate,
      confidence: 0.1,
      expectedUtility: 0.1,
      estimatedRisk: 0.9,
      estimatedCost: 0.9,
    };
    expect(
      calculateLearningAwareScore(lowScoreCand, neutralLearning).recommendation,
    ).toBe("IGNORE");

    const mediumScoreCand: PersistedCandidateAction = {
      ...baseCandidate,
      confidence: 0.5,
      expectedUtility: 0.5,
      estimatedRisk: 0.4,
      estimatedCost: 0.4,
    };
    expect(
      calculateLearningAwareScore(mediumScoreCand, neutralLearning)
        .recommendation,
    ).toBe("ASK_HUMAN");

    const highScoreCand: PersistedCandidateAction = {
      ...baseCandidate,
      confidence: 0.9,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.1,
    };
    expect(
      calculateLearningAwareScore(highScoreCand, neutralLearning)
        .recommendation,
    ).toBe("AUTO_CANDIDATE");
  });
});
