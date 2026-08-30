import { describe, expect, it } from "vitest";

import { persistedCueIngressSchema } from "./cue-ingress";
import { failureRecoveryCommandSchema } from "./failure-recovery-command";
import { persistedFailureAuditSchema } from "./failure-audit";
import { persistedActionPlanSchema } from "./persisted-action-plan";
import { persistedCandidateActionSchema } from "./persisted-candidate-action";
import { persistedEvidenceSchema } from "./persisted-evidence";
import { persistedGroundingResultSchema } from "./persisted-grounding-result";
import { persistedObservationSchema } from "./persisted-observation";
import { persistedPolicyDecisionSchema } from "./persisted-policy-decision";
import { persistedResultVerificationSchema } from "./result-verification";
import { persistedRewardEventSchema } from "./reward-event";
import { persistedVerifiedMemorySchema } from "./verified-memory";

const validCue = {
  cueId: "cue-1",
  source: "github",
  externalEventId: "delivery-123",
  type: "github.issue.created",
  occurredAt: "2026-08-30T00:00:00.000Z",
  receivedAt: "2026-08-30T00:00:01.000Z",
  payload: { issueId: 42 },
};

const validAudit = {
  auditEventId: "audit-1",
  sessionId: "session-1",
  candidateId: "candidate-1",
  planId: "plan-1",
  executionId: "execution-1",
  stepId: "step-1",
  failure: "EXECUTION_TIMEOUT",
  recoveryAction: "START_COOLDOWN",
  phase: "ACT",
  failureCount: 2,
  retryCount: 1,
  fromSafetyGeneration: 6,
  revokedSafetyGeneration: 7,
  reason: "The execution outcome could not be confirmed before timeout.",
  evidenceIds: ["observation-1"],
  logicalFailureKey: "failure:execution-1:step-1:timeout:1",
  createdAt: "2026-08-30T00:02:00.000Z",
};

const validVerification = {
  verificationId: "verification-1",
  executionId: "execution-1",
  verificationGeneration: 1,
  observationSetDigest: "sha256:observations-1",
  verifierVersion: "result-verifier-v1",
  status: "VERIFIED",
  confidence: 0.95,
  reason: "The observed result matches the expected result.",
  verifiedAt: "2026-08-30T00:03:00.000Z",
};

const validReward = {
  rewardEventId: "reward-1",
  executionId: "execution-1",
  verificationId: "verification-1",
  rewardRuleId: "verified-success-v1",
  rewardIdempotencyKey: "reward:verification-1:verified-success-v1",
  signal: "SUCCESS",
  value: 10,
  reason: "Verified successful completion.",
  createdAt: "2026-08-30T00:04:00.000Z",
};

const validMemory = {
  memoryId: "memory-1",
  kind: "FACT",
  key: "customer:42:preferred-timezone",
  version: 1,
  content: { timezone: "Asia/Singapore" },
  sourceIds: ["verification-1"],
  confidence: 0.98,
  admissionRuleVersion: "verified-result-admission-v1",
  supersedesMemoryId: null,
  verifiedAt: "2026-08-30T00:03:00.000Z",
  createdAt: "2026-08-30T00:05:00.000Z",
};

const validEvidence = {
  evidenceId: "ev-1",
  source: "git",
  sourceId: "commit-abc1234",
  claim: "Repository is clean at commit abc1234",
  observedAt: "2026-08-30T00:00:00.000Z",
  createdAt: "2026-08-30T00:00:01.000Z",
  providerMetadata: { branch: "main" },
};

const validCandidate = {
  candidateId: "cand-1",
  sessionId: "session-1",
  cueId: "cue-1",
  goal: "Fix lint errors",
  action: "Run eslint --fix",
  confidence: 0.95,
  expectedUtility: 0.9,
  estimatedRisk: 0.1,
  estimatedCost: 0.05,
  scoreValue: 0.88,
  recommendation: "PROCEED",
  scoreFormulaVersion: "score-v1",
  evidenceIds: ["ev-1"],
  createdAt: "2026-08-30T00:01:00.000Z",
};

const validGrounding = {
  groundingResultId: "ground-1",
  candidateId: "cand-1",
  evaluationKey: "ground:cand-1:eval-1",
  status: "VERIFIED",
  confidence: 0.98,
  reason: "Candidate is grounded by source commit",
  evaluatorVersion: "grounder-v1",
  evidenceIds: ["ev-1"],
  evaluatedAt: "2026-08-30T00:01:30.000Z",
};

const validPolicy = {
  policyDecisionId: "policy-1",
  candidateId: "cand-1",
  groundingResultId: "ground-1",
  evaluationKey: "policy:cand-1:eval-1",
  outcome: "ALLOW",
  reason: "Action is safe and verified",
  policyEngineVersion: "policy-engine-v1",
  policyIds: ["pol-safety-check"],
  evaluatedAt: "2026-08-30T00:01:45.000Z",
};

const validPlan = {
  planId: "plan-1",
  candidateId: "cand-1",
  planGeneration: 1,
  steps: [
    { stepId: "step-1", ordinal: 0, description: "Lint" },
    { stepId: "step-2", ordinal: 1, description: "Test" },
  ],
  dependencies: [{ stepId: "step-2", dependsOnStepId: "step-1" }],
  createdAt: "2026-08-30T00:02:00.000Z",
};

const validObservation = {
  observationId: "obs-1",
  executionId: "exec-1",
  stepId: "step-1",
  source: "terminal",
  sourceEventId: "stdout-line-1",
  summary: "Exit code 0 received",
  data: { exitCode: 0 },
  observedAt: "2026-08-30T00:02:30.000Z",
  payloadExpiresAt: null,
};

const validFailureCommand = {
  commandIdempotencyKey: "failure:session-1:gen-0:1",
  sessionId: "session-1",
  expectedSessionRowVersion: 0,
  expectedSafetyGeneration: 0,
  failure: "HALLUCINATION_DETECTED",
  reason: "Grounding check contradicted candidate claim",
  evidenceIds: ["ev-1"],
  auditEventId: "audit-1",
  safetyEventId: "safety-evt-1",
  safetyEventKey: "safety:revoke:1",
  createdAt: "2026-08-30T00:03:00.000Z",
};

describe("cue ingress contract", () => {
  it("parses stable source and external-event identity", () => {
    expect(persistedCueIngressSchema.safeParse(validCue).success).toBe(true);
  });

  it("rejects empty external event identity", () => {
    expect(
      persistedCueIngressSchema.safeParse({
        ...validCue,
        externalEventId: "",
      }).success,
    ).toBe(false);
  });

  it("keeps payload JSON-shaped", () => {
    expect(
      persistedCueIngressSchema.safeParse({
        ...validCue,
        payload: { callback: () => "not JSON" },
      }).success,
    ).toBe(false);
  });
});

describe("evidence persistence contract", () => {
  it("parses valid immutable evidence", () => {
    expect(persistedEvidenceSchema.safeParse(validEvidence).success).toBe(true);
  });

  it.each(["chainOfThought", "workingMemory", "reasoning"])(
    "rejects speculative field %s in evidence",
    (field) => {
      expect(
        persistedEvidenceSchema.safeParse({
          ...validEvidence,
          [field]: "forbidden",
        }).success,
      ).toBe(false);
    },
  );
});

describe("candidate action persistence contract", () => {
  it("parses valid candidate action record", () => {
    expect(
      persistedCandidateActionSchema.safeParse(validCandidate).success,
    ).toBe(true);
  });

  it.each([-0.1, 1.1, Number.NaN])(
    "rejects invalid scoreValue %s",
    (scoreValue) => {
      expect(
        persistedCandidateActionSchema.safeParse({
          ...validCandidate,
          scoreValue,
        }).success,
      ).toBe(false);
    },
  );
});

describe("grounding result persistence contract", () => {
  it("parses valid grounding result", () => {
    expect(
      persistedGroundingResultSchema.safeParse(validGrounding).success,
    ).toBe(true);
  });

  it("rejects invalid status", () => {
    expect(
      persistedGroundingResultSchema.safeParse({
        ...validGrounding,
        status: "INVALID_STATUS",
      }).success,
    ).toBe(false);
  });
});

describe("policy decision persistence contract", () => {
  it("parses valid policy decision record", () => {
    expect(persistedPolicyDecisionSchema.safeParse(validPolicy).success).toBe(
      true,
    );
  });

  it("rejects invalid outcome", () => {
    expect(
      persistedPolicyDecisionSchema.safeParse({
        ...validPolicy,
        outcome: "SUPER_ALLOW",
      }).success,
    ).toBe(false);
  });
});

describe("action plan persistence contract", () => {
  it("parses valid plan with steps and internal dependencies", () => {
    expect(persistedActionPlanSchema.safeParse(validPlan).success).toBe(true);
  });

  it("rejects self-dependency in step", () => {
    expect(
      persistedActionPlanSchema.safeParse({
        ...validPlan,
        dependencies: [{ stepId: "step-1", dependsOnStepId: "step-1" }],
      }).success,
    ).toBe(false);
  });

  it("rejects dependency on step not in plan", () => {
    expect(
      persistedActionPlanSchema.safeParse({
        ...validPlan,
        dependencies: [
          { stepId: "step-1", dependsOnStepId: "step-non-existent" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("observation persistence contract", () => {
  it("parses valid observation record", () => {
    expect(
      persistedObservationSchema.safeParse(validObservation).success,
    ).toBe(true);
  });
});

describe("failure recovery command contract", () => {
  it("parses valid failure recovery command", () => {
    expect(
      failureRecoveryCommandSchema.safeParse(validFailureCommand).success,
    ).toBe(true);
  });

  it("rejects negative expectedSessionRowVersion", () => {
    expect(
      failureRecoveryCommandSchema.safeParse({
        ...validFailureCommand,
        expectedSessionRowVersion: -1,
      }).success,
    ).toBe(false);
  });
});

describe("failure audit persistence contract", () => {
  it("parses complete execution and safety-generation correlation", () => {
    expect(persistedFailureAuditSchema.safeParse(validAudit).success).toBe(
      true,
    );
  });

  it("rejects a negative revoked generation", () => {
    expect(
      persistedFailureAuditSchema.safeParse({
        ...validAudit,
        revokedSafetyGeneration: -1,
      }).success,
    ).toBe(false);
  });
});

describe("result verification persistence contract", () => {
  it("parses one authoritative verification identity", () => {
    expect(
      persistedResultVerificationSchema.safeParse(validVerification).success,
    ).toBe(true);
  });

  it.each([1.01, -0.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid confidence %s",
    (confidence) => {
      expect(
        persistedResultVerificationSchema.safeParse({
          ...validVerification,
          confidence,
        }).success,
      ).toBe(false);
    },
  );

  it("rejects an empty observation-set digest", () => {
    expect(
      persistedResultVerificationSchema.safeParse({
        ...validVerification,
        observationSetDigest: "",
      }).success,
    ).toBe(false);
  });
});

describe("reward event persistence contract", () => {
  it("requires the verification, rule, and idempotency identity", () => {
    expect(persistedRewardEventSchema.safeParse(validReward).success).toBe(
      true,
    );

    expect(
      persistedRewardEventSchema.safeParse({
        ...validReward,
        rewardRuleId: undefined,
      }).success,
    ).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects non-finite reward value %s",
    (value) => {
      expect(
        persistedRewardEventSchema.safeParse({ ...validReward, value }).success,
      ).toBe(false);
    },
  );
});

describe("verified memory persistence contract", () => {
  it("parses verified, sourced, versioned memory", () => {
    expect(persistedVerifiedMemorySchema.safeParse(validMemory).success).toBe(
      true,
    );
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid memory confidence %s",
    (confidence) => {
      expect(
        persistedVerifiedMemorySchema.safeParse({
          ...validMemory,
          confidence,
        }).success,
      ).toBe(false);
    },
  );

  it.each([0, -1, 1.5])("rejects invalid memory version %s", (version) => {
    expect(
      persistedVerifiedMemorySchema.safeParse({
        ...validMemory,
        version,
      }).success,
    ).toBe(false);
  });

  it.each(["reasoning", "chainOfThought", "scratchpad"])(
    "rejects unexpected speculative top-level field %s",
    (field) => {
      expect(
        persistedVerifiedMemorySchema.safeParse({
          ...validMemory,
          [field]: "must not persist",
        }).success,
      ).toBe(false);
    },
  );
});
