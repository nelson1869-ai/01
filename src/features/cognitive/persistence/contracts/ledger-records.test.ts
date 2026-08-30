import { describe, expect, it } from "vitest";

import { persistedCueIngressSchema } from "./cue-ingress";
import { persistedFailureAuditSchema } from "./failure-audit";
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
