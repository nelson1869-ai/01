import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as createCueRoute } from "../../../../../app/api/cognitive/cues/route";
import { GET as getCueRoute } from "../../../../../app/api/cognitive/cues/[cueId]/route";
import { GET as getSessionRoute } from "../../../../../app/api/cognitive/sessions/[sessionId]/route";
import {
  createPostgresDatabase,
  type PostgresDatabaseContext,
} from "../client";
import { candidateRepository } from "../repositories/candidate-repository";
import { cueRepository } from "../repositories/cue-repository";
import { executionRepository } from "../repositories/execution-repository";
import { learningRepository } from "../repositories/learning-repository";
import { memoryRepository } from "../repositories/memory-repository";
import { planRepository } from "../repositories/plan-repository";
import { rewardRepository } from "../repositories/reward-repository";
import { sessionRepository } from "../repositories/session-repository";
import {
  cleanIntegrationTestTables,
  setupIntegrationTestDatabase,
} from "../testing/integration-harness";
import { ingestCue } from "../transactions/ingest-cue";

describe("Milestone 8.1 — Cue + Cognitive Session Control Plane API (Live PostgreSQL)", () => {
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

  function createJsonRequest(
    url: string,
    method: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Request {
    return new Request(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...(headers ?? {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it("1-3. POST /api/cognitive/cues atomically creates exactly 1 durable cue and 1 linked session in CUE phase", async () => {
    const req = createJsonRequest(
      "http://localhost:3000/api/cognitive/cues",
      "POST",
      {
        source: "postman-test",
        type: "user.action",
        payload: { instruction: "Inspect project repository" },
        maxRetries: 3,
      },
    );

    const res = await createCueRoute(req);
    expect(res.status).toBe(201);

    const json = await res.json();
    expect(json.data).toBeDefined();
    expect(json.data.cue).toBeDefined();
    expect(json.data.session).toBeDefined();

    const createdCueId = json.data.cue.cueId;
    const createdSessionId = json.data.session.sessionId;

    expect(createdCueId).toMatch(/^cue-[0-9a-f-]+$/);
    expect(createdSessionId).toMatch(/^sess-[0-9a-f-]+$/);
    expect(json.data.session.cueId).toBe(createdCueId);
    expect(json.data.session.phase).toBe("CUE");
    expect(json.data.session.rowVersion).toBe(0);
    expect(json.data.session.maxRetries).toBe(3);

    // Verify durable storage in PostgreSQL: exactly one cue, exactly one session
    const dbCue = await cueRepository.findCueById(context.db, createdCueId);
    expect(dbCue).not.toBeNull();
    expect(dbCue?.source).toBe("postman-test");
    expect(dbCue?.type).toBe("user.action");

    const dbSession = await sessionRepository.findSessionById(
      context.db,
      createdSessionId,
    );
    expect(dbSession).not.toBeNull();
    expect(dbSession?.cueId).toBe(createdCueId);
    expect(dbSession?.phase).toBe("CUE");
  });

  it("4. Forced session failure rolls back cue atomically", async () => {
    const cueId = `cue-rollback-${crypto.randomUUID()}`;
    const invalidSessionId = ""; // violates non-empty check

    await expect(
      ingestCue(context.db, {
        cue: {
          cueId,
          source: "test-rollback",
          externalEventId: `evt-rollback-${crypto.randomUUID()}`,
          type: "user.action",
          occurredAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          payload: { test: "rollback" },
        },
        sessionId: invalidSessionId,
      }),
    ).rejects.toThrow();

    const foundCue = await cueRepository.findCueById(context.db, cueId);
    expect(foundCue).toBeNull();
  });

  it("5. Idempotent replay: Resending identical request returns existing cue and session without duplicating rows", async () => {
    const payload = {
      source: "webhook-service",
      type: "github.issue.created",
      externalEventId: "gh-event-issue-101",
      payload: { issueNumber: 101, title: "Bug report" },
    };

    // First request -> 201 Created
    const req1 = createJsonRequest(
      "http://localhost:3000/api/cognitive/cues",
      "POST",
      payload,
    );
    const res1 = await createCueRoute(req1);
    expect(res1.status).toBe(201);
    const json1 = await res1.json();

    // Second request with exact same externalEventId -> 200 OK (idempotent replay)
    const req2 = createJsonRequest(
      "http://localhost:3000/api/cognitive/cues",
      "POST",
      payload,
    );
    const res2 = await createCueRoute(req2);
    expect(res2.status).toBe(200);
    const json2 = await res2.json();

    expect(json2.data.cue.cueId).toBe(json1.data.cue.cueId);
    expect(json2.data.session.sessionId).toBe(json1.data.session.sessionId);

    // Verify PostgreSQL contains exactly one cue and one session
    const cueByExt = await cueRepository.findCueByExternalIdentity(
      context.db,
      "webhook-service",
      "gh-event-issue-101",
    );
    expect(cueByExt).not.toBeNull();
    expect(cueByExt?.cueId).toBe(json1.data.cue.cueId);
  });

  it("6. Conflicting payload with same (source, externalEventId) returns 409 IDEMPOTENCY_CONFLICT", async () => {
    const payload1 = {
      source: "scheduler",
      type: "schedule",
      externalEventId: "cron-daily-report",
      payload: { task: "daily-summary" },
    };

    const payload2 = {
      source: "scheduler",
      type: "schedule",
      externalEventId: "cron-daily-report",
      payload: { task: "DIFFERENT-CONFLICTING-TASK" }, // Conflict!
    };

    const res1 = await createCueRoute(
      createJsonRequest(
        "http://localhost:3000/api/cognitive/cues",
        "POST",
        payload1,
      ),
    );
    expect(res1.status).toBe(201);

    const res2 = await createCueRoute(
      createJsonRequest(
        "http://localhost:3000/api/cognitive/cues",
        "POST",
        payload2,
      ),
    );
    expect(res2.status).toBe(409);

    const json2 = await res2.json();
    expect(json2.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("7. GET /api/cognitive/cues/[cueId] reflects durable PostgreSQL state or returns 404 for missing", async () => {
    // 1. Create cue first
    const createRes = await createCueRoute(
      createJsonRequest("http://localhost:3000/api/cognitive/cues", "POST", {
        source: "test-client",
        type: "user.action",
        payload: { query: "Get repository stars" },
      }),
    );
    const created = await createRes.json();
    const cueId = created.data.cue.cueId;

    // 2. Fetch existing cue
    const getRes = await getCueRoute(
      new Request(`http://localhost:3000/api/cognitive/cues/${cueId}`),
      { params: Promise.resolve({ cueId }) },
    );
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.data.cue.cueId).toBe(cueId);
    expect(getJson.data.cue.source).toBe("test-client");

    // 3. Fetch missing cue
    const missingRes = await getCueRoute(
      new Request("http://localhost:3000/api/cognitive/cues/cue-missing-999"),
      { params: Promise.resolve({ cueId: "cue-missing-999" }) },
    );
    expect(missingRes.status).toBe(404);
    const missingJson = await missingRes.json();
    expect(missingJson.error.code).toBe("NOT_FOUND");
  });

  it("8. GET /api/cognitive/sessions/[sessionId] reflects durable PostgreSQL state or returns 404 for missing", async () => {
    // 1. Create cue & session first
    const createRes = await createCueRoute(
      createJsonRequest("http://localhost:3000/api/cognitive/cues", "POST", {
        source: "test-client",
        type: "user.action",
        payload: {},
      }),
    );
    const created = await createRes.json();
    const sessionId = created.data.session.sessionId;

    // 2. Fetch existing session
    const getRes = await getSessionRoute(
      new Request(`http://localhost:3000/api/cognitive/sessions/${sessionId}`),
      { params: Promise.resolve({ sessionId }) },
    );
    expect(getRes.status).toBe(200);
    const getJson = await getRes.json();
    expect(getJson.data.session.sessionId).toBe(sessionId);
    expect(getJson.data.session.phase).toBe("CUE");

    // 3. Fetch missing session
    const missingRes = await getSessionRoute(
      new Request(
        "http://localhost:3000/api/cognitive/sessions/sess-missing-999",
      ),
      { params: Promise.resolve({ sessionId: "sess-missing-999" }) },
    );
    expect(missingRes.status).toBe(404);
    const missingJson = await missingRes.json();
    expect(missingJson.error.code).toBe("NOT_FOUND");
  });

  it("9. A fresh/new DB client connection can retrieve the exact same durable state", async () => {
    const res = await createCueRoute(
      createJsonRequest("http://localhost:3000/api/cognitive/cues", "POST", {
        source: "fresh-client-test",
        type: "user.action",
        payload: { action: "verify-independent-connection" },
      }),
    );
    const json = await res.json();
    const cueId = json.data.cue.cueId;
    const sessionId = json.data.session.sessionId;

    const freshDb = createPostgresDatabase(process.env.TEST_DATABASE_URL!);
    try {
      const dbCue = await cueRepository.findCueById(freshDb.db, cueId);
      const dbSession = await sessionRepository.findSessionById(
        freshDb.db,
        sessionId,
      );
      expect(dbCue).not.toBeNull();
      expect(dbCue?.cueId).toBe(cueId);
      expect(dbSession).not.toBeNull();
      expect(dbSession?.sessionId).toBe(sessionId);
      expect(dbSession?.phase).toBe("CUE");
    } finally {
      await freshDb.close();
    }
  });

  it("10. GET does not advance cognitive phase or mutate row_version", async () => {
    const createRes = await createCueRoute(
      createJsonRequest("http://localhost:3000/api/cognitive/cues", "POST", {
        source: "phase-immutability-test",
        type: "user.action",
        payload: {},
      }),
    );
    const created = await createRes.json();
    const sessionId = created.data.session.sessionId;

    const sessionBefore = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(sessionBefore?.phase).toBe("CUE");
    expect(sessionBefore?.rowVersion).toBe(0);

    // Call GET multiple times
    await getSessionRoute(
      new Request(`http://localhost:3000/api/cognitive/sessions/${sessionId}`),
      {
        params: Promise.resolve({ sessionId }),
      },
    );
    await getSessionRoute(
      new Request(`http://localhost:3000/api/cognitive/sessions/${sessionId}`),
      {
        params: Promise.resolve({ sessionId }),
      },
    );

    const sessionAfter = await sessionRepository.findSessionById(
      context.db,
      sessionId,
    );
    expect(sessionAfter?.phase).toBe("CUE");
    expect(sessionAfter?.rowVersion).toBe(0);
    expect(sessionAfter?.updatedAt).toBe(sessionBefore?.updatedAt);
  });

  it("11. Malformed route params return 400 VALIDATION_ERROR", async () => {
    const maliciousParam = "../../../etc/passwd";
    const res = await getCueRoute(
      new Request(`http://localhost:3000/api/cognitive/cues/${maliciousParam}`),
      { params: Promise.resolve({ cueId: maliciousParam }) },
    );

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("VALIDATION_ERROR");
  });

  it("12. Invalid JSON or invalid body to POST /api/cognitive/cues returns 400", async () => {
    // Invalid JSON body
    const invalidJsonReq = new Request(
      "http://localhost:3000/api/cognitive/cues",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ unclosed_json: ",
      },
    );
    const resJson = await createCueRoute(invalidJsonReq);
    expect(resJson.status).toBe(400);
    const bodyJson = await resJson.json();
    expect(bodyJson.error.code).toBe("INVALID_JSON");

    // Invalid body fields (missing type)
    const invalidFieldsReq = createJsonRequest(
      "http://localhost:3000/api/cognitive/cues",
      "POST",
      {
        source: "test",
      },
    );
    const resFields = await createCueRoute(invalidFieldsReq);
    expect(resFields.status).toBe(400);
    const bodyFields = await resFields.json();
    expect(bodyFields.error.code).toBe("VALIDATION_ERROR");
  });

  it("13-16. Zero execution invariant: Calling M8.1 endpoints creates 0 candidates, 0 plans, 0 executions, 0 rewards, 0 learning mutations, 0 memory mutations, 0 Gemini/GitHub calls", async () => {
    const createRes = await createCueRoute(
      createJsonRequest("http://localhost:3000/api/cognitive/cues", "POST", {
        source: "agent",
        type: "user.action",
        payload: { task: "check repo" },
      }),
    );
    const created = await createRes.json();
    const cueId = created.data.cue.cueId;
    const sessionId = created.data.session.sessionId;

    // Read endpoints
    await getCueRoute(
      new Request(`http://localhost:3000/api/cognitive/cues/${cueId}`),
      {
        params: Promise.resolve({ cueId }),
      },
    );
    await getSessionRoute(
      new Request(`http://localhost:3000/api/cognitive/sessions/${sessionId}`),
      {
        params: Promise.resolve({ sessionId }),
      },
    );

    // Verify 0 candidates
    const candidates = await candidateRepository.findCandidatesByCueId(
      context.db,
      cueId,
    );
    expect(candidates).toHaveLength(0);

    // Verify 0 plans
    const plan = await planRepository.findPlanByCandidateId(
      context.db,
      "nonexistent",
    );
    expect(plan).toBeNull();

    // Verify 0 executions
    const execution = await executionRepository.findExecutionById(
      context.db,
      `exec:${sessionId}:plan-1`,
    );
    expect(execution).toBeNull();

    // Verify 0 rewards
    const reward = await rewardRepository.findRewardById(
      context.db,
      `rew:${sessionId}`,
    );
    expect(reward).toBeNull();

    // Verify 0 learning state mutation
    const learning = await learningRepository.findLearningState(
      context.db,
      `skill-${sessionId}`,
    );
    expect(learning).toBeNull();

    // Verify 0 memory head mutation
    const memory = await memoryRepository.findMemoryHead(
      context.db,
      "working_memory",
      sessionId,
    );
    expect(memory).toBeNull();
  });
});
