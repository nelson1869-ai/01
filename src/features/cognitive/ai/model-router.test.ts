import { describe, expect, it } from "vitest";
import {
  isStaticCapabilityQuery,
  routeTask,
  STATIC_AUTODO_CAPABILITY_RESPONSE,
} from "./model-router";

describe("Deterministic Model Router", () => {
  it("recognizes static AutoDo capability and greeting queries", () => {
    const greetingQueries = [
      "Hello AutoDo",
      "Hi AutoDo!",
      "Hello AutoDo. What can you do?",
      "What can you do?",
      "who are you?",
      "Help",
      "what is autodo?",
    ];

    for (const query of greetingQueries) {
      expect(isStaticCapabilityQuery(query)).toBe(true);
      const decision = routeTask(query);
      expect(decision).toMatchObject({
        taskClass: "STATIC_CAPABILITY",
        selectedProvider: "autodo",
        selectedModel: "deterministic",
        reasonCode: "STATIC_CAPABILITY",
        fallbackChain: [],
      });
    }
  });

  it("routes simple general queries to local Ollama (qwen3.5:9b) with cloud fallback", () => {
    const simpleQueries = [
      "What is TypeScript?",
      "Explain React state simply.",
      "Help me understand CSS flexbox.",
      "How do promises work in JavaScript?",
    ];

    for (const query of simpleQueries) {
      const decision = routeTask(query);
      expect(decision).toMatchObject({
        taskClass: "SIMPLE_GENERAL",
        selectedProvider: "ollama",
        selectedModel: "qwen3.5:9b",
        reasonCode: "SIMPLE_LOCAL",
      });
      expect(decision.fallbackChain).toEqual([
        { provider: "gemini", model: "gemini-3.5-flash-lite" },
      ]);
    }
  });

  it("routes repository and external data queries to Gemini Flash-Lite with fallback chain", () => {
    const repoQueries = [
      "Read README.md from my repository and tell me what this project does.",
      "Check my repo and summarize open issues.",
      "What files are in the repository?",
      "Inspect the pull requests on GitHub.",
    ];

    for (const query of repoQueries) {
      const decision = routeTask(query);
      expect(decision).toMatchObject({
        taskClass: "CURRENT_EXTERNAL_DATA",
        selectedProvider: "gemini",
        selectedModel: "gemini-3.5-flash-lite",
        reasonCode: "CURRENT_EXTERNAL_DATA",
      });
      expect(decision.fallbackChain).toEqual([
        { provider: "ollama", model: "qwen3.5:9b" },
      ]);
    }
  });

  it("routes complex reasoning and architectural queries to Gemini 3.7 Flash", () => {
    const complexQueries = [
      "Explain our distributed system architecture and consensus algorithm.",
      "Perform a deadlock analysis and race condition review.",
      "What is the time complexity and space complexity of this sorting algorithm?",
      "Design a zero-downtime database schema migration strategy.",
    ];

    for (const query of complexQueries) {
      const decision = routeTask(query);
      expect(decision).toMatchObject({
        taskClass: "COMPLEX_REASONING",
        selectedProvider: "gemini",
        selectedModel: "gemini-3.7-flash",
        reasonCode: "COMPLEX_REASONING",
      });
      expect(decision.fallbackChain).toEqual([
        { provider: "ollama", model: "qwen3.5:9b" },
      ]);
    }
  });

  it("provides safe static capability description without private details", () => {
    expect(STATIC_AUTODO_CAPABILITY_RESPONSE).toContain("AutoDo AI");
    expect(STATIC_AUTODO_CAPABILITY_RESPONSE).toContain("read-only");
    expect(STATIC_AUTODO_CAPABILITY_RESPONSE).not.toMatch(
      /AIza|ghp_|token|secret|password|bearer/i,
    );
  });
});
