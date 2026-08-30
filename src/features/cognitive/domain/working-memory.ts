import type { AgentContext } from "./types";

export function clearWorkingMemory(context: AgentContext): AgentContext {
  return {
    ...context,
    workingMemory: {},
  };
}
