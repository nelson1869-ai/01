import { describe, expect, it } from "vitest";

import { createPostgresDatabase } from "./client";
import {
  cognitiveSessions,
  cues,
  executionOperations,
  executionSafetyState,
  executions,
  failureAuditEvents,
  rewardEvents,
  verifiedMemory,
} from "./schema";

describe("PostgreSQL schema foundation", () => {
  it("does not expose workingMemory or speculative fields on cognitive sessions", () => {
    const sessionColumns = Object.keys(cognitiveSessions);
    expect(sessionColumns).not.toContain("workingMemory");
    expect(sessionColumns).not.toContain("chainOfThought");
    expect(sessionColumns).not.toContain("temporaryAssumptions");
    expect(sessionColumns).toContain("sessionId");
    expect(sessionColumns).toContain("cueId");
    expect(sessionColumns).toContain("rowVersion");
  });

  it("defines execution safety state with fail-closed status defaults", () => {
    const safetyColumns = Object.keys(executionSafetyState);
    expect(safetyColumns).toContain("sessionId");
    expect(safetyColumns).toContain("generation");
    expect(safetyColumns).toContain("durableStatus");
    expect(safetyColumns).not.toContain("authorizationBrand");
    expect(safetyColumns).not.toContain("runtimeToken");
  });

  it("exports cue ingress table with external event deduplication columns", () => {
    const cueColumns = Object.keys(cues);
    expect(cueColumns).toContain("cueId");
    expect(cueColumns).toContain("source");
    expect(cueColumns).toContain("externalEventId");
    expect(cueColumns).toContain("payload");
  });

  it("exports executions and execution operations with idempotency and reconciliation fields", () => {
    const execColumns = Object.keys(executions);
    expect(execColumns).toContain("executionId");
    expect(execColumns).toContain("safetyGenerationAtStart");
    expect(execColumns).toContain("rowVersion");

    const opColumns = Object.keys(executionOperations);
    expect(opColumns).toContain("operationId");
    expect(opColumns).toContain("operationGeneration");
    expect(opColumns).toContain("operationIdempotencyKey");
    expect(opColumns).toContain("reconciliationStatus");
    expect(opColumns).toContain("uncertaintyReason");
  });

  it("exports failure audit and reward events with logical deduplication columns", () => {
    const auditColumns = Object.keys(failureAuditEvents);
    expect(auditColumns).toContain("auditEventId");
    expect(auditColumns).toContain("logicalFailureKey");
    expect(auditColumns).toContain("fromSafetyGeneration");
    expect(auditColumns).toContain("revokedSafetyGeneration");

    const rewardColumns = Object.keys(rewardEvents);
    expect(rewardColumns).toContain("rewardEventId");
    expect(rewardColumns).toContain("rewardRuleId");
    expect(rewardColumns).toContain("rewardIdempotencyKey");
  });

  it("exports verified memory with versioning and confidence", () => {
    const memoryColumns = Object.keys(verifiedMemory);
    expect(memoryColumns).toContain("memoryId");
    expect(memoryColumns).toContain("kind");
    expect(memoryColumns).toContain("memoryKey");
    expect(memoryColumns).toContain("memoryVersion");
    expect(memoryColumns).toContain("confidence");
    expect(memoryColumns).not.toContain("scratchpad");
    expect(memoryColumns).not.toContain("reasoning");
  });

  it("provides a lazy database factory without connecting on module load", () => {
    const dbContext = createPostgresDatabase();
    expect(dbContext).toBeDefined();
    expect(typeof dbContext.close).toBe("function");
    expect(dbContext.db).toBeDefined();
    expect(dbContext.pool).toBeDefined();
  });
});
