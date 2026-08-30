import type { AgentContext } from "./types";

export function resumeAfterCooldown(
  context: AgentContext,
  nowMs: number,
): AgentContext {
  if (context.phase !== "COOLDOWN") {
    throw new Error("Only a cooling-down task can be resumed.");
  }

  if (context.cooldownUntilMs === null) {
    throw new Error("Cooldown end time is missing.");
  }

  if (nowMs < context.cooldownUntilMs) {
    throw new Error("Cooldown is still active.");
  }

  if (context.retryCount >= context.maxRetries) {
    throw new Error("Retry budget has been exhausted.");
  }

  const cue = context.workingMemory.cue;

  return {
    ...context,

    // Rebuild from trusted context after the cooldown.
    phase: "BUILD_CONTEXT",

    // A real retry starts now.
    retryCount: context.retryCount + 1,

    // Cooldown is finished.
    cooldownUntilMs: null,

    // Keep only the original root event.
    workingMemory: cue === undefined ? {} : { cue },
  };
}
