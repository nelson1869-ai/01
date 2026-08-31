import { describe, expect, it } from "vitest";
import { PersistenceError } from "../persistence/postgres/errors/persistence-errors";
import {
  apiCreated,
  apiError,
  apiSuccess,
  handleRouteError,
} from "./api-response";
import {
  createCueRequestSchema,
  identifierParamSchema,
} from "./cue-api-contracts";

describe("Milestone 8.1 Cue & Session API Schemas & Response Helpers", () => {
  it("validates well-formed createCueRequestSchema payload", () => {
    const valid = {
      source: "github-webhook",
      type: "user.action",
      payload: { instruction: "Read README.md" },
      occurredAt: "2026-08-31T05:00:00.000Z",
      externalEventId: "ev-github-123",
      maxRetries: 3,
    };

    const parsed = createCueRequestSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.source).toBe("github-webhook");
      expect(parsed.data.type).toBe("user.action");
      expect(parsed.data.maxRetries).toBe(3);
    }
  });

  it("applies defaults for optional fields (payload default {}, optional occurredAt, optional maxRetries)", () => {
    const minimal = {
      source: "user",
      type: "user.action",
    };

    const parsed = createCueRequestSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.payload).toEqual({});
      expect(parsed.data.occurredAt).toBeUndefined();
      expect(parsed.data.externalEventId).toBeUndefined();
    }
  });

  it("rejects missing source or invalid cue type", () => {
    const missingSource = {
      type: "user.action",
    };
    expect(createCueRequestSchema.safeParse(missingSource).success).toBe(false);

    const invalidType = {
      source: "test",
      type: "invalid.fake.type",
    };
    expect(createCueRequestSchema.safeParse(invalidType).success).toBe(false);
  });

  it("rejects invalid externalEventId with dangerous characters", () => {
    const malicious = {
      source: "test",
      type: "user.action",
      externalEventId: "../../../etc/passwd",
    };
    expect(createCueRequestSchema.safeParse(malicious).success).toBe(false);
  });

  it("validates identifierParamSchema strictly", () => {
    expect(identifierParamSchema.safeParse("cue-abc-123_456").success).toBe(
      true,
    );
    expect(identifierParamSchema.safeParse("sess:123.456-789").success).toBe(
      true,
    );
    expect(identifierParamSchema.safeParse("").success).toBe(false);
    expect(identifierParamSchema.safeParse("id with spaces").success).toBe(
      false,
    );
    expect(identifierParamSchema.safeParse("../traversal").success).toBe(false);
    expect(identifierParamSchema.safeParse("a".repeat(300)).success).toBe(
      false,
    );
  });

  it("formats API success and created envelopes correctly", async () => {
    const resSuccess = apiSuccess({ hello: "world" });
    expect(resSuccess.status).toBe(200);
    const jsonSuccess = await resSuccess.json();
    expect(jsonSuccess).toEqual({ data: { hello: "world" } });

    const resCreated = apiCreated({ id: "123" });
    expect(resCreated.status).toBe(201);
    const jsonCreated = await resCreated.json();
    expect(jsonCreated).toEqual({ data: { id: "123" } });

    const resError = apiError("BAD_REQUEST", "Custom error message", 400, {
      field: "test",
    });
    expect(resError.status).toBe(400);
    const jsonError = await resError.json();
    expect(jsonError).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Custom error message",
        details: { field: "test" },
      },
    });
  });

  it("maps ZodError to 400 VALIDATION_ERROR envelope", async () => {
    const parseResult = createCueRequestSchema.safeParse({
      source: 123,
      type: "invalid.type",
    });
    expect(parseResult.success).toBe(false);
    if (!parseResult.success) {
      const res = handleRouteError(parseResult.error);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details).toBeDefined();
    }
  });

  it("maps PersistenceError.notFound to 404 NOT_FOUND envelope", async () => {
    const notFoundErr = PersistenceError.notFound('Cue "cue-1" not found.');
    const res = handleRouteError(notFoundErr);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain('Cue "cue-1" not found.');
  });

  it("maps PersistenceError.idempotencyConflict to 409 IDEMPOTENCY_CONFLICT envelope", async () => {
    const conflictErr = PersistenceError.idempotencyConflict(
      "Idempotency collision detected.",
    );
    const res = handleRouteError(conflictErr);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("redacts secrets from internal server error messages", async () => {
    const secretError = new Error(
      "Connection failed for key AIzaSyD1234567890abcdefghijklmnop and token ghp_secret1234567890abcdefghijklm",
    );
    const res = handleRouteError(secretError);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).not.toContain(
      "AIzaSyD1234567890abcdefghijklmnop",
    );
    expect(body.error.message).not.toContain(
      "ghp_secret1234567890abcdefghijklm",
    );
    expect(body.error.message).toContain("[REDACTED_GEMINI_KEY]");
    expect(body.error.message).toContain("[REDACTED_GITHUB_TOKEN]");
  });
});
