import { sanitizeErrorMessage } from "../ai/ai-errors";

const SECRET_EXFILTRATION_PATTERNS: readonly RegExp[] = [
  // Imperative actions asking for secret values
  /\b(show|reveal|display|print|expose|read|give|dump|leak|tell)\b[\s\S]{0,30}\b(me\s+|us\s+)?(the|my|all|your|our)?\s*(gemini[_ -]?api[_ -]?key|github[_ -]?token|test[_ -]?database[_ -]?url|authorization\s+header|runtime\s+authorization|credentials?|passwords?|repository\s+secrets?|api[_ -]?key|api[_ -]?token|auth[_ -]?token|secret[_ -]?key)\b/i,
  // Question forms asking for personal/actual secrets (e.g. "What's my API key?", "What is my GitHub token?")
  /\bwhat('s|\s+is|\s+are)\s+(my|our|your|the)\s+(gemini[_ -]?api[_ -]?key|github[_ -]?token|test[_ -]?database[_ -]?url|authorization\s+header|runtime\s+authorization|credentials?|passwords?|repository\s+secrets?|api[_ -]?key|api[_ -]?token|auth[_ -]?token|secret[_ -]?key)\b/i,
  // Explicit credential dump commands
  /\b(dump|print|reveal|show|tell)\s+(all\s+)?(credentials?|passwords?|secrets?|tokens?)\b/i,
  /\b(print|reveal|show|tell|give)\s+(the\s+|my\s+)?(runtime\s+authorization|authorization\s+header)\b/i,
];

const POLICY_BYPASS_PATTERNS: readonly RegExp[] = [
  /\b(ignore|bypass|override|disable|forget)\b[\s\S]{0,40}\b(all\s+)?(rules?|policies|policy|safety|authorization|allowlists?|instructions?|system\s+prompts?)\b/i,
  /\bforget\s+(your\s+)?(safety\s+instructions?|system\s+instructions?)\s+and\b/i,
];

const MUTATION_REQUEST_PATTERNS: readonly RegExp[] = [
  // Deletions on repo / git
  /\b(delete|remove|destroy|drop)\s+(my\s+|the\s+|this\s+)?(github\s+)?(repo|repository|branch|main|file|files|readme(\.md)?|package\.json|commit|issue|issues|pull\s*request|pr|prs)\b/i,
  /\b(delete|remove|destroy)\s+[a-z0-9_.-]+\s+(from|in)\s+(my\s+|the\s+|this\s+)?(repo|repository|github)\b/i,

  // File modifications targeting repository
  /\b(edit|modify|write|overwrite|change|update)\s+([a-z0-9_.-]+\s+(in|to|on|from)\s+(my\s+|the\s+|this\s+)?(repo|repository|github)|(the\s+|my\s+|this\s+)?(readme(\.md)?|package\.json|repository\s+description|repo\s+description|repository\s+settings|repo\s+settings))\b/i,
  /\b(change|update|edit|modify)\s+(the\s+|my\s+|this\s+)?(repository|repo)\s+(description|settings|name|visibility)\b/i,

  // Git push / commit / merge operations
  /\b(commit\s+(these\s+|the\s+|my\s+|all\s+)?(changes?|code|files?)\s+to\s+(github|repo|repository|main|origin)|commit\s+to\s+(github|main|master|origin|repo|repository))\b/i,
  /\b(push\s+(this\s+|the\s+|my\s+|these\s+)?(code|branch|changes?|commits?)\s+to\s+(main|master|github|origin|remote)|push\s+to\s+(main|master|github|origin))\b/i,
  /\b(merge|close|reopen)\s+(pull\s*request|pr)(\s+#?\d+)?\b/i,

  // Creating or updating GitHub issues / PRs / secrets / files
  /\b(create|open|add|post)\s+(an?\s+|new\s+)?(issue|pull\s*request|pr|branch|github\s+secret|secret\s+to\s+github)\b/i,
  /\b(create|add|write)\s+(an?\s+|new\s+)?(file|files?)\s+(in|to|on)\s+(my\s+|the\s+|this\s+)?(repo|repository|github)\b/i,
  /\b(add\s+a\s+github\s+secret|update\s+issue(\s+#?\d+)?)\b/i,

  // Deploying repository
  /\b(deploy|publish|release)\s+(this\s+|my\s+|the\s+)?(repo|repository|branch|codebase)\b/i,
];

export function redactAssistantMessage(message: string): string {
  return sanitizeErrorMessage(message)
    .replace(
      /\b(?:GEMINI_API_KEY|GITHUB_TOKEN|TEST_DATABASE_URL)\s*[=:]\s*\S+/gi,
      "[REDACTED_SECRET]",
    )
    .replace(/ghp_[a-zA-Z0-9]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[a-zA-Z0-9_]{20,}/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/AIzaSy[a-zA-Z0-9_-]{33}/g, "[REDACTED_GEMINI_KEY]")
    .replace(/bearer\s+[a-zA-Z0-9._~+/-]+=*/gi, "Bearer [REDACTED_AUTH_HEADER]")
    .slice(0, 8000);
}

export function deterministicDenialReason(message: string): string | null {
  if (SECRET_EXFILTRATION_PATTERNS.some((p) => p.test(message))) {
    return "I can’t reveal credentials, authorization headers, or runtime authorization.";
  }
  if (
    POLICY_BYPASS_PATTERNS.some((p) => p.test(message)) ||
    MUTATION_REQUEST_PATTERNS.some((p) => p.test(message))
  ) {
    return "I can’t perform that action with the current read-only GitHub policy.";
  }
  return null;
}
