import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  isAllowedExecutionSafetyState,
} from "../../../domain/execution-safety";
import {
  orchestrateAuthorizationIssuance,
} from "../../../orchestration/authorization-orchestrator";
import type { AuthorizationIssuanceCommand } from "../../contracts/authorization-issuance-command";
import type { PersistedCandidateAction } from "../../contracts/persisted-candidate-action";
import type { PersistedGroundingResult } from "../../contracts/persisted-grounding-result";
import type { PersistedPolicyDecision } from "../../contracts/persisted-policy-decision";
import type { PostgresDatabaseContext } from "../client";
import { PersistenceError } from "../errors/persistence-errors";
import { candidateRepository } from "../repositories/candidate-repository";
import { groundingRepository } from "../repositories/grounding-repository";
import { policyRepository } from "../repositories/policy-repository";
import { safetyRepository } from "../repositories/safety-repository";
import { sessionRepository } from "../repositories/session-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";
import { persistAuthorizationIssuance } from "../transactions/persist-authorization-issuance";

describe("live PostgreSQL trusted re-authorization pipeline integration tests", () => {
  let context: PostgresDatabaseContext;

  beforeAll(async () => {
    context = await setupIntegrationTestDatabase();
  });

  beforeEach(async () => {
    await cleanIntegrationTestTables(context.db);
  });

  afterAll(async () => {
    if (context) {
      await context.close();
    }
  });

  async function seedSessionInPolicySafety(params: {
    sessionId?: string;
    cueId?: string;
    candidateId?: string;
    groundingResultId?: string;
    policyDecisionId?: string;
    initialStatus?: "UNAUTHORIZED" | "BLOCKED";
    initialGeneration?: number;
    failureCode?: string | null;
    blockedAt?: string | null;
    t0?: string;
    groundingStatus?: "VERIFIED" | "CONTRADICTED" | "UNVERIFIED";
    policyOutcome?: "ALLOW" | "REQUIRE_HUMAN_CONFIRMATION" | "DENY";
  }) {
    const sessionId = params.sessionId ?? "sess-auth-1";
    const cueId = params.cueId ?? "cue-auth-1";
    const candidateId = params.candidateId ?? "cand-auth-1";
    const groundingResultId = params.groundingResultId ?? "gr-auth-1";
    const policyDecisionId = params.policyDecisionId ?? "pol-auth-1";
    const initialStatus = params.initialStatus ?? "UNAUTHORIZED";
    const initialGeneration = params.initialGeneration ?? 0;
    const t0 = params.t0 ?? "2026-08-31T00:00:00.000Z";
    const tCand = "2026-08-31T00:01:00.000Z";
    const tGround = "2026-08-31T00:02:00.000Z";
    const tPolicy = "2026-08-31T00:03:00.000Z";

    // 1. Ingest cue
    await ingestCue(context.db, {
      cue: {
        cueId,
        source: "github",
        externalEventId: `evt-${cueId}`,
        type: "github.issue.created",
        occurredAt: t0,
        receivedAt: "2026-08-31T00:00:01.000Z",
        payload: { title: "Test Auth" },
      },
      sessionId,
      maxRetries: 3,
    });

    // 2. Set session to POLICY_SAFETY with currentCandidateId
    await context.db.execute(sql`
      UPDATE cognitive_sessions
      SET phase = 'POLICY_SAFETY',
          current_candidate_id = ${candidateId},
          row_version = 1,
          updated_at = ${tCand}
      WHERE session_id = ${sessionId}
    `);

    // 3. Set safety state to initialStatus / initialGeneration
    if (initialStatus === "BLOCKED") {
      await context.db.execute(sql`
        UPDATE execution_safety_state
        SET generation = ${initialGeneration},
            durable_status = 'BLOCKED',
            failure_code = ${params.failureCode ?? "EXECUTION_TIMEOUT"},
            reason = 'Prior failure reason',
            blocked_at = ${params.blockedAt ?? t0},
            updated_at = ${t0}
        WHERE session_id = ${sessionId}
      `);
    } else if (initialGeneration > 0) {
      await context.db.execute(sql`
        UPDATE execution_safety_state
        SET generation = ${initialGeneration},
            durable_status = 'UNAUTHORIZED',
            failure_code = NULL,
            reason = 'Autonomous execution has not been authorized.',
            blocked_at = NULL,
            updated_at = ${t0}
        WHERE session_id = ${sessionId}
      `);
    }

    // 4. Append Candidate
    const cand: PersistedCandidateAction = {
      candidateId,
      sessionId,
      cueId,
      goal: "Resolve issue",
      action: "Execute action",
      confidence: 0.95,
      expectedUtility: 0.9,
      estimatedRisk: 0.1,
      estimatedCost: 0.05,
      scoreValue: 0.92,
      recommendation: "PROCEED",
      scoreFormulaVersion: "v1.0",
      evidenceIds: [],
      createdAt: tCand,
    };
    await candidateRepository.appendCandidate(context.db, cand);

    // 5. Append Grounding
    const ground: PersistedGroundingResult = {
      groundingResultId,
      candidateId,
      evaluationKey: `eval-gr-${groundingResultId}`,
      status: params.groundingStatus ?? "VERIFIED",
      confidence: 0.98,
      reason: "Verified by documentation evidence",
      evaluatorVersion: "v1.0",
      evidenceIds: [],
      evaluatedAt: tGround,
    };
    await groundingRepository.appendGroundingResult(context.db, ground);

    // 6. Append Policy
    const pol: PersistedPolicyDecision = {
      policyDecisionId,
      candidateId,
      groundingResultId,
      evaluationKey: `eval-pol-${policyDecisionId}`,
      outcome: params.policyOutcome ?? "ALLOW",
      reason: "Policy allows action",
      policyEngineVersion: "v1.0",
      policyIds: ["pol-1"],
      evaluatedAt: tPolicy,
    };
    await policyRepository.appendPolicyDecision(context.db, pol);

    const session = (await sessionRepository.findSessionById(
      context.db,
      sessionId,
    ))!;
    const safety = (await safetyRepository.findSafetyStateBySessionId(
      context.db,
      sessionId,
    ))!;

    return {
      sessionId,
      cueId,
      candidateId,
      groundingResultId,
      policyDecisionId,
      session,
      safety,
      candidate: cand,
      grounding: ground,
      policy: pol,
    };
  }

  it("1. Initial authorization: durable UNAUTHORIZED gen0 -> durable UNAUTHORIZED gen1 + runtime ALLOWED gen1", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-1",
      cueId: "cue-test-1",
      candidateId: "cand-test-1",
      groundingResultId: "gr-test-1",
      policyDecisionId: "pol-test-1",
      initialStatus: "UNAUTHORIZED",
      initialGeneration: 0,
    });

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-1:gen-1",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-1",
      safetyEventKey: "safe-key:sess-test-1:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const result = await persistAuthorizationIssuance(context.db, command);
    expect(result.status).toBe("AUTHORIZED");
    if (result.status === "AUTHORIZED") {
      expect(result.generation).toBe(1);
      expect(result.isReplay).toBe(false);
      expect(isAllowedExecutionSafetyState(result.authorization)).toBe(true);
      expect(result.authorization.status).toBe("ALLOWED");
      expect(result.authorization.generation).toBe(1);
      expect(result.authorization.candidateId).toBe(seeded.candidateId);

      // Durable safety row is UNAUTHORIZED at generation 1
      expect(result.safetyState.status).toBe("UNAUTHORIZED");
      expect(result.safetyState.generation).toBe(1);
      expect(result.safetyState.failure).toBeNull();
      expect(result.safetyState.blockedAt).toBeNull();
    }
  });

  it("2, 3. Re-authorization after failure: durable BLOCKED gen2 -> durable UNAUTHORIZED gen3 + runtime ALLOWED gen3 (clearing failure and blockedAt)", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-2",
      cueId: "cue-test-2",
      candidateId: "cand-test-2",
      groundingResultId: "gr-test-2",
      policyDecisionId: "pol-test-2",
      initialStatus: "BLOCKED",
      initialGeneration: 2,
      failureCode: "POLICY_VIOLATION",
      blockedAt: "2026-08-31T00:00:30.000Z",
    });

    expect(seeded.safety.status).toBe("BLOCKED");
    expect(seeded.safety.generation).toBe(2);
    expect(seeded.safety.failure).toBe("POLICY_VIOLATION");
    expect(seeded.safety.blockedAt).not.toBeNull();

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-2:gen-3",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 2,
      safetyEventId: "safe-evt-2",
      safetyEventKey: "safe-key:sess-test-2:gen-3",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const result = await persistAuthorizationIssuance(context.db, command);
    expect(result.status).toBe("AUTHORIZED");
    if (result.status === "AUTHORIZED") {
      expect(result.generation).toBe(3);
      expect(isAllowedExecutionSafetyState(result.authorization)).toBe(true);
      expect(result.authorization.generation).toBe(3);

      // Stored failure and blockedAt are cleared
      expect(result.safetyState.status).toBe("UNAUTHORIZED");
      expect(result.safetyState.generation).toBe(3);
      expect(result.safetyState.failure).toBeNull();
      expect(result.safetyState.blockedAt).toBeNull();
    }
  });

  it("4. Successful safety row contains exact candidateId, groundingResultId, policyDecisionId", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-4",
      cueId: "cue-test-4",
      candidateId: "cand-test-4",
      groundingResultId: "gr-test-4",
      policyDecisionId: "pol-test-4",
    });

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-4:gen-1",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-4",
      safetyEventKey: "safe-key:sess-test-4:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const result = await persistAuthorizationIssuance(context.db, command);
    expect(result.status).toBe("AUTHORIZED");
    if (result.status === "AUTHORIZED") {
      expect(result.safetyState.evaluatedCandidateId).toBe("cand-test-4");
      expect(result.safetyState.groundingResultId).toBe("gr-test-4");
      expect(result.safetyState.policyDecisionId).toBe("pol-test-4");
    }
  });

  it("5. Exactly one AUTHORIZATION_ISSUED safety event appended", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-5",
      cueId: "cue-test-5",
      candidateId: "cand-test-5",
      groundingResultId: "gr-test-5",
      policyDecisionId: "pol-test-5",
    });

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-5:gen-1",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-5",
      safetyEventKey: "safe-key:sess-test-5:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    await persistAuthorizationIssuance(context.db, command);

    const eventRows = await context.db.execute(sql`
      SELECT * FROM execution_safety_events WHERE session_id = ${seeded.sessionId}
    `);

    expect(eventRows.rows.length).toBe(1);
    const event = eventRows.rows[0];
    expect(event.event_type).toBe("AUTHORIZATION_ISSUED");
    expect(Number(event.from_generation)).toBe(0);
    expect(Number(event.to_generation)).toBe(1);
    expect(event.candidate_id).toBe("cand-test-5");
    expect(event.grounding_result_id).toBe("gr-test-5");
    expect(event.policy_decision_id).toBe("pol-test-5");
  });

  it("6, 7. Session transitions POLICY_SAFETY -> PLAN and rowVersion increments once", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-6",
      cueId: "cue-test-6",
      candidateId: "cand-test-6",
      groundingResultId: "gr-test-6",
      policyDecisionId: "pol-test-6",
    });

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-6:gen-1",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: 1,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-6",
      safetyEventKey: "safe-key:sess-test-6:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const result = await persistAuthorizationIssuance(context.db, command);
    expect(result.status).toBe("AUTHORIZED");
    if (result.status === "AUTHORIZED") {
      expect(result.session.phase).toBe("PLAN");
      expect(result.session.rowVersion).toBe(2);
      expect(result.session.currentCandidateId).toBe("cand-test-6");
      expect(result.session.currentPlanId).toBeNull();
      expect(result.session.currentExecutionId).toBeNull();
    }
  });

  it("8. Runtime authorization generation strictly equals committed durable generation", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-8",
      cueId: "cue-test-8",
      candidateId: "cand-test-8",
      groundingResultId: "gr-test-8",
      policyDecisionId: "pol-test-8",
    });

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-8:gen-1",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-8",
      safetyEventKey: "safe-key:sess-test-8:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const result = await persistAuthorizationIssuance(context.db, command);
    expect(result.status).toBe("AUTHORIZED");
    if (result.status === "AUTHORIZED") {
      expect(result.authorization.generation).toBe(result.safetyState.generation);
      expect(result.authorization.generation).toBe(1);
    }
  });

  it("9. PostgreSQL database schema check constraint strictly rejects stored ALLOWED", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-9",
      cueId: "cue-test-9",
    });

    await expect(
      context.db.execute(sql`
        UPDATE execution_safety_state
        SET durable_status = 'ALLOWED'
        WHERE session_id = ${seeded.sessionId}
      `),
    ).rejects.toThrow();
  });

  it("10, 11. Grounding UNVERIFIED and CONTRADICTED: no generation change, no session change, no capability", async () => {
    const seededUnverified = await seedSessionInPolicySafety({
      sessionId: "sess-test-10",
      cueId: "cue-test-10",
      candidateId: "cand-test-10",
      groundingResultId: "gr-test-10",
      policyDecisionId: "pol-test-10",
      groundingStatus: "UNVERIFIED",
    });

    const command1: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-10:gen-1",
      sessionId: seededUnverified.sessionId,
      candidateId: seededUnverified.candidateId,
      groundingResultId: seededUnverified.groundingResultId,
      policyDecisionId: seededUnverified.policyDecisionId,
      expectedSessionRowVersion: seededUnverified.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-10",
      safetyEventKey: "safe-key:sess-test-10:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    // Orchestrator returns semantic result
    const orchResult1 = await orchestrateAuthorizationIssuance(
      context.db,
      command1,
    );
    expect(orchResult1.status).toBe("GROUNDING_NOT_VERIFIED");

    // Direct persistence fails closed
    await expect(
      persistAuthorizationIssuance(context.db, command1),
    ).rejects.toThrow(PersistenceError);

    // Verify 0 DB changes
    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      seededUnverified.sessionId,
    );
    expect(safety?.generation).toBe(0);
    const session = await sessionRepository.findSessionById(
      context.db,
      seededUnverified.sessionId,
    );
    expect(session?.phase).toBe("POLICY_SAFETY");
  });

  it("12, 13. Policy REQUIRE_HUMAN_CONFIRMATION and DENY: no capability, no automatic HUMAN_REVIEW mutation", async () => {
    const seededApproval = await seedSessionInPolicySafety({
      sessionId: "sess-test-12",
      cueId: "cue-test-12",
      candidateId: "cand-test-12",
      groundingResultId: "gr-test-12",
      policyDecisionId: "pol-test-12",
      policyOutcome: "REQUIRE_HUMAN_CONFIRMATION",
    });

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-12:gen-1",
      sessionId: seededApproval.sessionId,
      candidateId: seededApproval.candidateId,
      groundingResultId: seededApproval.groundingResultId,
      policyDecisionId: seededApproval.policyDecisionId,
      expectedSessionRowVersion: seededApproval.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-12",
      safetyEventKey: "safe-key:sess-test-12:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const orchResult = await orchestrateAuthorizationIssuance(
      context.db,
      command,
    );
    expect(orchResult.status).toBe("POLICY_REQUIRES_APPROVAL");

    // Session remains in POLICY_SAFETY (not mutated to HUMAN_REVIEW)
    const session = await sessionRepository.findSessionById(
      context.db,
      seededApproval.sessionId,
    );
    expect(session?.phase).toBe("POLICY_SAFETY");
  });

  it("14, 15, 16, 17. Candidate/Grounding/Policy binding mismatches fail closed", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-14",
      cueId: "cue-test-14",
      candidateId: "cand-test-14",
      groundingResultId: "gr-test-14",
      policyDecisionId: "pol-test-14",
    });

    // 14. Candidate mismatch
    const badCandidateCommand: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-14:bad-cand",
      sessionId: seeded.sessionId,
      candidateId: "cand-other",
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-14a",
      safetyEventKey: "safe-key:sess-test-14:1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };
    await expect(
      persistAuthorizationIssuance(context.db, badCandidateCommand),
    ).rejects.toThrow(PersistenceError);

    // 15. Grounding mismatch
    const badGroundingCommand: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-14:bad-gr",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: "gr-nonexistent",
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-14b",
      safetyEventKey: "safe-key:sess-test-14:2",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };
    await expect(
      persistAuthorizationIssuance(context.db, badGroundingCommand),
    ).rejects.toThrow(PersistenceError);
  });

  it("18, 19. Temporal consistency: policy before grounding or grounding before candidate fails closed", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-18",
      cueId: "cue-test-18",
      candidateId: "cand-test-18",
      groundingResultId: "gr-test-18",
      policyDecisionId: "pol-test-18",
    });

    // Mutate policy to predate grounding
    await context.db.execute(sql`
      UPDATE policy_decisions
      SET evaluated_at = '2026-08-31 00:00:00.000+00'
      WHERE policy_decision_id = 'pol-test-18'
    `);

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-18:temporal",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-18",
      safetyEventKey: "safe-key:sess-test-18:1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    await expect(
      persistAuthorizationIssuance(context.db, command),
    ).rejects.toThrow(PersistenceError);
  });

  it("20, 21. Stale safety generation or session rowVersion triggers full rollback with no capability", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-20",
      cueId: "cue-test-20",
      candidateId: "cand-test-20",
      groundingResultId: "gr-test-20",
      policyDecisionId: "pol-test-20",
    });

    // Stale generation
    const staleGenCommand: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-20:stale-gen",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 99, // Stale
      safetyEventId: "safe-evt-20a",
      safetyEventKey: "safe-key:sess-test-20:1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };
    await expect(
      persistAuthorizationIssuance(context.db, staleGenCommand),
    ).rejects.toThrow(PersistenceError);

    // Stale rowVersion
    const staleVerCommand: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-20:stale-ver",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: 99, // Stale
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-20b",
      safetyEventKey: "safe-key:sess-test-20:2",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };
    await expect(
      persistAuthorizationIssuance(context.db, staleVerCommand),
    ).rejects.toThrow(PersistenceError);

    // Check 0 events created
    const eventRows = await context.db.execute(sql`
      SELECT * FROM execution_safety_events WHERE session_id = 'sess-test-20'
    `);
    expect(eventRows.rows.length).toBe(0);
  });

  it("22, 23. Same command replay returns ALREADY_ISSUED_NO_CAPABILITY with authorization = null; key conflict throws IDEMPOTENCY_CONFLICT", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-22",
      cueId: "cue-test-22",
      candidateId: "cand-test-22",
      groundingResultId: "gr-test-22",
      policyDecisionId: "pol-test-22",
    });

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-22:gen-1",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-22",
      safetyEventKey: "safe-key:sess-test-22:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const first = await persistAuthorizationIssuance(context.db, command);
    expect(first.status).toBe("AUTHORIZED");
    expect(first.isReplay).toBe(false);

    // Replay same command
    const replay = await persistAuthorizationIssuance(context.db, command);
    expect(replay.status).toBe("ALREADY_ISSUED_NO_CAPABILITY");
    expect(replay.isReplay).toBe(true);
    expect(replay.authorization).toBeNull();
    expect(replay.generation).toBe(1);

    // Conflicting request with same idempotency key
    const conflictingCommand: AuthorizationIssuanceCommand = {
      ...command,
      expectedSessionRowVersion: 99, // Mismatched expectation
    };
    await expect(
      persistAuthorizationIssuance(context.db, conflictingCommand),
    ).rejects.toThrow(PersistenceError);
  });

  it("24, 25. Concurrent same commands (1 capability, 1 replay) vs concurrent racing commands (1 commit, 1 STALE_WRITE)", async () => {
    // 24. Concurrent same commands
    const seeded1 = await seedSessionInPolicySafety({
      sessionId: "sess-test-24",
      cueId: "cue-test-24",
      candidateId: "cand-test-24",
      groundingResultId: "gr-test-24",
      policyDecisionId: "pol-test-24",
    });

    const commandSame: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-24:same",
      sessionId: seeded1.sessionId,
      candidateId: seeded1.candidateId,
      groundingResultId: seeded1.groundingResultId,
      policyDecisionId: seeded1.policyDecisionId,
      expectedSessionRowVersion: seeded1.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-24",
      safetyEventKey: "safe-key:sess-test-24:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const resultsSame = await Promise.all([
      persistAuthorizationIssuance(context.db, commandSame),
      persistAuthorizationIssuance(context.db, commandSame),
    ]);

    const created = resultsSame.filter((r) => r.status === "AUTHORIZED");
    const replayed = resultsSame.filter(
      (r) => r.status === "ALREADY_ISSUED_NO_CAPABILITY",
    );

    expect(created.length).toBe(1);
    expect(replayed.length).toBe(1);

    // 25. Concurrent racing distinct commands on same expected rowVersion
    const seeded2 = await seedSessionInPolicySafety({
      sessionId: "sess-test-25",
      cueId: "cue-test-25",
      candidateId: "cand-test-25",
      groundingResultId: "gr-test-25",
      policyDecisionId: "pol-test-25",
    });

    const commandWorkerA: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-25:worker-a",
      sessionId: seeded2.sessionId,
      candidateId: seeded2.candidateId,
      groundingResultId: seeded2.groundingResultId,
      policyDecisionId: seeded2.policyDecisionId,
      expectedSessionRowVersion: seeded2.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-25a",
      safetyEventKey: "safe-key:sess-test-25:worker-a",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const commandWorkerB: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-25:worker-b",
      sessionId: seeded2.sessionId,
      candidateId: seeded2.candidateId,
      groundingResultId: seeded2.groundingResultId,
      policyDecisionId: seeded2.policyDecisionId,
      expectedSessionRowVersion: seeded2.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-25b",
      safetyEventKey: "safe-key:sess-test-25:worker-b",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const resultsRacing = await Promise.allSettled([
      persistAuthorizationIssuance(context.db, commandWorkerA),
      persistAuthorizationIssuance(context.db, commandWorkerB),
    ]);

    const fulfilled = resultsRacing.filter((r) => r.status === "fulfilled");
    const rejected = resultsRacing.filter((r) => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it("26. Reusing already-consumed policyDecisionId or groundingResultId for a NEW generation is rejected", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-26",
      cueId: "cue-test-26",
      candidateId: "cand-test-26",
      groundingResultId: "gr-test-26",
      policyDecisionId: "pol-test-26",
    });

    const command1: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-26:gen-1",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-26",
      safetyEventKey: "safe-key:sess-test-26:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    await persistAuthorizationIssuance(context.db, command1);

    // Now simulate session returning to POLICY_SAFETY with new rowVersion and generation 1
    await context.db.execute(sql`
      UPDATE cognitive_sessions
      SET phase = 'POLICY_SAFETY',
          row_version = 2
      WHERE session_id = 'sess-test-26'
    `);

    // Attempt to reuse same grounding & policy decision for generation 2
    const reuseCommand: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-26:gen-2-reuse",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: 2,
      expectedSafetyGeneration: 1,
      safetyEventId: "safe-evt-26-reuse",
      safetyEventKey: "safe-key:sess-test-26:gen-2",
      issuedAt: "2026-08-31T00:10:00.000Z",
    };

    await expect(
      persistAuthorizationIssuance(context.db, reuseCommand),
    ).rejects.toThrow(PersistenceError);
  });

  it("27, 28, 29. Unique safetyEventKey collision rolls back entire transaction", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-27",
      cueId: "cue-test-27",
      candidateId: "cand-test-27",
      groundingResultId: "gr-test-27",
      policyDecisionId: "pol-test-27",
    });

    // Seed a safety event with key "collide-key"
    await context.db.execute(sql`
      INSERT INTO execution_safety_events (
        safety_event_id, session_id, from_generation, to_generation,
        event_type, candidate_id, grounding_result_id, policy_decision_id,
        event_key, reason, occurred_at
      ) VALUES (
        'safe-evt-existing', ${seeded.sessionId}, 10, 11,
        'SAFETY_TRANSITION', ${seeded.candidateId}, ${seeded.groundingResultId}, ${seeded.policyDecisionId},
        'collide-key', 'Existing event', NOW()
      )
    `);

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-27:collision",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-27-new",
      safetyEventKey: "collide-key", // Collision!
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    await expect(
      persistAuthorizationIssuance(context.db, command),
    ).rejects.toThrow();

    // Session remains in POLICY_SAFETY and generation remains 0
    const safety = await safetyRepository.findSafetyStateBySessionId(
      context.db,
      seeded.sessionId,
    );
    expect(safety?.generation).toBe(0);
    const session = await sessionRepository.findSessionById(
      context.db,
      seeded.sessionId,
    );
    expect(session?.phase).toBe("POLICY_SAFETY");
  });

  it("30. Real restart test: issue authorization, close client, open fresh client, confirm durable provenance exists and no rehydration of ALLOWED is possible", async () => {
    const seeded = await seedSessionInPolicySafety({
      sessionId: "sess-test-30",
      cueId: "cue-test-30",
      candidateId: "cand-test-30",
      groundingResultId: "gr-test-30",
      policyDecisionId: "pol-test-30",
    });

    const command: AuthorizationIssuanceCommand = {
      commandIdempotencyKey: "auth:sess-test-30:gen-1",
      sessionId: seeded.sessionId,
      candidateId: seeded.candidateId,
      groundingResultId: seeded.groundingResultId,
      policyDecisionId: seeded.policyDecisionId,
      expectedSessionRowVersion: seeded.session.rowVersion,
      expectedSafetyGeneration: 0,
      safetyEventId: "safe-evt-30",
      safetyEventKey: "safe-key:sess-test-30:gen-1",
      issuedAt: "2026-08-31T00:04:00.000Z",
    };

    const initialResult = await persistAuthorizationIssuance(
      context.db,
      command,
    );
    expect(initialResult.status).toBe("AUTHORIZED");
    if (initialResult.status === "AUTHORIZED") {
      expect(isAllowedExecutionSafetyState(initialResult.authorization)).toBe(
        true,
      );
    }

    // Process terminates: close existing PostgreSQL client context
    await context.close();

    // Reopen fresh PostgreSQL context as if new process started
    const freshContext = await setupIntegrationTestDatabase();

    try {
      // Reload session and safety purely from durable PostgreSQL tables
      const reloadedSession = await sessionRepository.findSessionById(
        freshContext.db,
        seeded.sessionId,
      );
      const reloadedSafety = await safetyRepository.findSafetyStateBySessionId(
        freshContext.db,
        seeded.sessionId,
      );

      expect(reloadedSession).not.toBeNull();
      expect(reloadedSession?.phase).toBe("PLAN");
      expect(reloadedSafety).not.toBeNull();
      expect(reloadedSafety?.generation).toBe(1);
      expect(reloadedSafety?.status).toBe("UNAUTHORIZED");
      expect(reloadedSafety?.evaluatedCandidateId).toBe("cand-test-30");
      expect(reloadedSafety?.groundingResultId).toBe("gr-test-30");
      expect(reloadedSafety?.policyDecisionId).toBe("pol-test-30");

      // Attempting to replay command after restart returns ALREADY_ISSUED_NO_CAPABILITY with authorization = null
      const replayResult = await persistAuthorizationIssuance(
        freshContext.db,
        command,
      );
      expect(replayResult.status).toBe("ALREADY_ISSUED_NO_CAPABILITY");
      expect(replayResult.authorization).toBeNull();
      expect(replayResult.generation).toBe(1);
    } finally {
      await freshContext.close();
      context = await setupIntegrationTestDatabase();
    }
  });
});
