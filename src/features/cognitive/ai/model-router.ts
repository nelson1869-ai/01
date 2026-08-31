export type TaskClass =
  | "STATIC_CAPABILITY"
  | "SIMPLE_GENERAL"
  | "FAST_CLOUD_STRUCTURED"
  | "COMPLEX_REASONING"
  | "CURRENT_EXTERNAL_DATA";

export type ModelProviderName = "autodo" | "ollama" | "gemini";

export type ModelIdentifier =
  | "deterministic"
  | "qwen3.5:9b"
  | "gemini-3.5-flash-lite"
  | "gemini-3.7-flash";

export interface ModelRouteDecision {
  readonly taskClass: TaskClass;
  readonly selectedProvider: ModelProviderName;
  readonly selectedModel: ModelIdentifier;
  readonly reasonCode: string;
  readonly fallbackChain: readonly {
    readonly provider: ModelProviderName;
    readonly model: ModelIdentifier;
  }[];
}

export const STATIC_AUTODO_CAPABILITY_RESPONSE =
  "I am AutoDo AI, a safe autonomous assistant for software repositories. I can answer general software questions, explain code and architecture, and inspect repository contents (such as reading files, issues, and pull requests) in a strictly read-only, verified mode.";

const STATIC_CAPABILITY_PATTERNS: readonly RegExp[] = [
  /^(hello|hi|hey)\s+autodo[!.?]*$/i,
  /^(hello|hi|hey)\s+autodo[!,.]*\s*(what can you do|who are you|help)[?.!]*$/i,
  /^(what can you do|who are you|help|what is autodo|what does autodo do)[?.!]*$/i,
];

const EXTERNAL_DATA_PATTERNS: readonly RegExp[] = [
  /\b(readme(\.md)?|repository|repo|github|issue|issues|pull request|pull requests|pr|prs|commit|commits|branch|branches|file|files|directory|folder|contents)\b/i,
  /\b(check (my|the) (repo|repository|codebase))\b/i,
  /\b(read|inspect|list|summarize)\s+[a-z0-9_.-]+(\.[a-z0-9]+)?\b/i,
];

const COMPLEX_REASONING_PATTERNS: readonly RegExp[] = [
  /\b(architecture|architectural|refactor|refactoring|distributed system|consensus algorithm|concurrency model|race condition|deadlock analysis|time complexity|space complexity|memory leak analysis|formal verification|differential testing)\b/i,
  /\b(design pattern|microservice|database schema migration strategy|zero-downtime|threat model)\b/i,
];

export function isStaticCapabilityQuery(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return STATIC_CAPABILITY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function routeTask(message: string): ModelRouteDecision {
  const normalized = message.trim();

  // 1. Zero-model fast path for static capability & greetings
  if (isStaticCapabilityQuery(normalized)) {
    return {
      taskClass: "STATIC_CAPABILITY",
      selectedProvider: "autodo",
      selectedModel: "deterministic",
      reasonCode: "STATIC_CAPABILITY",
      fallbackChain: [],
    };
  }

  // 2. Repository & External Data
  if (EXTERNAL_DATA_PATTERNS.some((p) => p.test(normalized))) {
    return {
      taskClass: "CURRENT_EXTERNAL_DATA",
      selectedProvider: "gemini",
      selectedModel: "gemini-3.5-flash-lite",
      reasonCode: "CURRENT_EXTERNAL_DATA",
      fallbackChain: [{ provider: "ollama", model: "qwen3.5:9b" }],
    };
  }

  // 3. Complex Reasoning & Architecture
  if (COMPLEX_REASONING_PATTERNS.some((p) => p.test(normalized))) {
    return {
      taskClass: "COMPLEX_REASONING",
      selectedProvider: "gemini",
      selectedModel: "gemini-3.7-flash",
      reasonCode: "COMPLEX_REASONING",
      fallbackChain: [{ provider: "ollama", model: "qwen3.5:9b" }],
    };
  }

  // 4. Default: Simple General Conversation (Local-first with Qwen)
  return {
    taskClass: "SIMPLE_GENERAL",
    selectedProvider: "ollama",
    selectedModel: "qwen3.5:9b",
    reasonCode: "SIMPLE_LOCAL",
    fallbackChain: [{ provider: "gemini", model: "gemini-3.5-flash-lite" }],
  };
}
