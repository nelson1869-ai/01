import type { Cue } from "./cue";
import type { AgentContext } from "./types";

export function receiveCue(context: AgentContext, cue: Cue): AgentContext {
  if (context.phase !== "IDLE") {
    throw new Error("A new cue can only start from IDLE.");
  }

  return {
    ...context,
    phase: "CUE",
    failureCount: 0,
    retryCount: 0,
    cooldownUntilMs: null,
    workingMemory: {
      cue,
    },
  };
}
