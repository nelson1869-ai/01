import { describe, expect, it } from "vitest";

import { resumeAfterCooldown } from "./resume-after-cooldown";
import type { AgentContext } from "./types";

describe("resumeAfterCooldown", () => {
  // ============================================================
  // TEST 1: COOLDOWN CANNOT BE BYPASSED EARLY
  // ============================================================
  it("rejects a resume attempt while the cooldown is still active", () => {
    const context: AgentContext = {
      sessionId: "session-1",
      phase: "COOLDOWN",

      failureCount: 2,
      retryCount: 1,
      maxRetries: 2,

      // Cooldown ends at 250,000 ms.
      cooldownUntilMs: 250_000,

      workingMemory: {
        cue: {
          id: "cue-1",
        },
      },

      createdAt: "2026-08-30T00:00:00.000Z",
    };

    // Current time is still BEFORE the cooldown end.
    const nowMs = 249_999;

    expect(() => resumeAfterCooldown(context, nowMs)).toThrow(
      "Cooldown is still active.",
    );
  });

  // ============================================================
  // TEST 2: COOLDOWN COMPLETE → RESUME WITH FRESH CONTEXT
  // ============================================================
  it("resumes when the cooldown has completed", () => {
    const context: AgentContext = {
      sessionId: "session-1",
      phase: "COOLDOWN",

      failureCount: 2,
      retryCount: 1,
      maxRetries: 2,

      cooldownUntilMs: 250_000,

      workingMemory: {
        cue: {
          id: "cue-1",
        },

        // This must not survive the fresh resume.
        assumption: "temporary data",
      },

      createdAt: "2026-08-30T00:00:00.000Z",
    };

    // Exact cooldown boundary.
    const nowMs = 250_000;

    const result = resumeAfterCooldown(context, nowMs);

    expect(result.phase).toBe("BUILD_CONTEXT");

    // Failure count stays the same.
    expect(result.failureCount).toBe(2);

    // The second real retry starts now.
    expect(result.retryCount).toBe(2);

    // Cooldown is finished.
    expect(result.cooldownUntilMs).toBeNull();

    // Fresh mind:
    // preserve only the original cue.
    expect(result.workingMemory).toEqual({
      cue: {
        id: "cue-1",
      },
    });
  });

  // ============================================================
  // TEST 3: RETRY BUDGET EXHAUSTED → DO NOT RESUME
  // ============================================================
  it("rejects resume when the retry budget is exhausted", () => {
    const context: AgentContext = {
      sessionId: "session-1",
      phase: "COOLDOWN",

      failureCount: 2,

      // Already used all allowed retries.
      retryCount: 2,
      maxRetries: 2,

      cooldownUntilMs: 250_000,

      workingMemory: {
        cue: {
          id: "cue-1",
        },
      },

      createdAt: "2026-08-30T00:00:00.000Z",
    };

    const nowMs = 250_000;

    expect(() => resumeAfterCooldown(context, nowMs)).toThrow(
      "Retry budget has been exhausted.",
    );
  });
});
