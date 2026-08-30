import type { AgentContext } from "./types";

export function enterIdle(context: AgentContext): AgentContext {
  return {
    ...context,
    phase: "IDLE",
  };
}
