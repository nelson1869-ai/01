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
  // Specific file paths or README
  /\b(read|inspect|summarize|check|view|open|show|find|list)\b[\s\S]{0,40}\b(readme(\.md)?|[a-z0-9_./-]+\.(md|json|ts|tsx|js|jsx|yaml|yml|toml|sql|txt|py|go|rs|css|html))\b/i,
  /\b[a-z0-9_./-]+\.(md|json|ts|tsx|js|jsx|yaml|yml|toml|sql|py|go|rs)\b/i,

  // Explicit repository inspection
  /\b(in|from|of)\s+(my|the|this)\s+(repo|repository|codebase|project)\b/i,
  /\b(check|inspect|explore|search|look\s+at)\s+(my|the|this)\s+(repo|repository|codebase)\b/i,
  /\bwhat\s+(does\s+this\s+(repository|repo|project|codebase)\s+do|files\s+are\s+in\s+(the|this|my)\s+(repository|repo))\b/i,
  /\b(inspect|check|explore|search)\s+my\s+repository\b/i,

  // Issues / PR inspection
  /\b(read|check|inspect|list|summarize|get|open|show)\s+(my\s+|the\s+|open\s+)?(github\s+)?(issues?|pull\s*requests?|prs?)(\s+#?\d+)?\b/i,
  /\b(read|check|inspect|get|show)\s+(issue|pr|pull\s*request)\s+#?\d+\b/i,
  /\b(list\s+open\s+pull\s*requests|list\s+open\s+issues)\b/i,

  // Mutation commands targeting repository (routed to external data then denied safely)
  /\b(delete|remove)\s+(my\s+|the\s+)?(github\s+)?(repository|repo)\b/i,
];

interface ComplexitySignal {
  readonly pattern: RegExp;
  readonly weight: number;
}

const STRONG_COMPLEXITY_SIGNALS: readonly ComplexitySignal[] = [
  { pattern: /\barchitect(ur(e|al)|ing)?\b/i, weight: 2 },
  { pattern: /\brefactor(ing|s)?\b/i, weight: 2 },
  { pattern: /\brace\s+conditions?\b/i, weight: 2 },
  { pattern: /\bdeadlocks?\b/i, weight: 2 },
  {
    pattern: /\bconcurrency(\s+(models?|problems?|issues?|control))?\b/i,
    weight: 2,
  },
  { pattern: /\bconsensus(\s+algorithms?)?\b/i, weight: 2 },
  { pattern: /\b(time|space|algorithmic)\s+complexity\b/i, weight: 2 },
  { pattern: /\bmemory\s+leak(\s+analysis)?\b/i, weight: 2 },
  { pattern: /\bformal\s+verification\b/i, weight: 2 },
  { pattern: /\bdifferential\s+testing\b/i, weight: 2 },
  {
    pattern:
      /\b(system\s+design|design(\s+a|\s+an|\s+the)?\s+(distributed|scalable|event[\s-]processing))\b/i,
    weight: 2,
  },
  { pattern: /\btransaction\s+isolation\b/i, weight: 2 },
  { pattern: /\bconsistency\s+models?\b/i, weight: 2 },
  { pattern: /\bfault[\s-]toleran(ce|t)\b/i, weight: 2 },
  { pattern: /\bzero[\s-]downtime\b/i, weight: 2 },
  { pattern: /\bthreat\s+models?\b/i, weight: 2 },
  { pattern: /\b(database\s+schema\s+)?migration\s+strategy\b/i, weight: 2 },
];

const SUPPORTING_COMPLEXITY_SIGNALS: readonly ComplexitySignal[] = [
  { pattern: /\bdistributed\b/i, weight: 1 },
  { pattern: /\bconcurrent(ly)?\b/i, weight: 1 },
  { pattern: /\bscalab(le|ility)\b/i, weight: 1 },
  { pattern: /\bmicroservices?\b/i, weight: 1 },
  { pattern: /\bidempotenc(y|e|ent)\b/i, weight: 1 },
  { pattern: /\bdesign\s+patterns?\b/i, weight: 1 },
];

export function normalizeTaskMessage(message: string): string {
  return message.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isStaticCapabilityQuery(message: string): boolean {
  const normalized = normalizeTaskMessage(message);
  return STATIC_CAPABILITY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isExternalDataQuery(message: string): boolean {
  const normalized = normalizeTaskMessage(message);
  return EXTERNAL_DATA_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function calculateComplexityScore(message: string): number {
  const normalized = normalizeTaskMessage(message);
  let score = 0;

  for (const signal of STRONG_COMPLEXITY_SIGNALS) {
    if (signal.pattern.test(normalized)) {
      score += signal.weight;
    }
  }

  for (const signal of SUPPORTING_COMPLEXITY_SIGNALS) {
    if (signal.pattern.test(normalized)) {
      score += signal.weight;
    }
  }

  return score;
}

export function routeTask(message: string): ModelRouteDecision {
  const normalized = normalizeTaskMessage(message);

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
  if (isExternalDataQuery(normalized)) {
    return {
      taskClass: "CURRENT_EXTERNAL_DATA",
      selectedProvider: "gemini",
      selectedModel: "gemini-3.5-flash-lite",
      reasonCode: "CURRENT_EXTERNAL_DATA",
      fallbackChain: [{ provider: "ollama", model: "qwen3.5:9b" }],
    };
  }

  // 3. Complex Reasoning & Architecture (Threshold score >= 2)
  const complexityScore = calculateComplexityScore(normalized);
  if (complexityScore >= 2) {
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
