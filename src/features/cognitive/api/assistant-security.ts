import { sanitizeErrorMessage } from "../ai/ai-errors";

const SECRET_EXFILTRATION =
  /\b(show|reveal|display|print|expose|read|give|dump|leak|tell)\b[\s\S]{0,30}\b(me\s+)?(the|my|all|your)?\s*(gemini[_ -]?api[_ -]?key|github[_ -]?token|test[_ -]?database[_ -]?url|authorization\s+header|runtime\s+authorization|credentials?|passwords?|repository\s+secrets?|api[_ -]?key|api[_ -]?token|auth[_ -]?token)\b/i;

const POLICY_BYPASS =
  /\b(ignore|bypass|override|disable|forget)\b[\s\S]{0,40}\b(all\s+)?(rules?|policies|policy|safety|authorization|allowlists?|instructions?|system\s+prompts?)\b/i;

const MUTATION_REQUEST_PATTERNS: readonly RegExp[] = [
  // Deletions on repo / git
  /\b(delete|remove|destroy|drop)\s+(my\s+|the\s+|this\s+)?(github\s+)?(repo|repository|branch|main|file|files|readme(\.md)?|commit|issue|issues|pull\s*request|pr|prs)\b/i,
  /\b(delete|remove|destroy)\s+[a-z0-9_.-]+\s+(from|in)\s+(my\s+|the\s+|this\s+)?(repo|repository|github)\b/i,

  // File modifications targeting repository
  /\b(edit|modify|write|overwrite)\s+([a-z0-9_.-]+\s+(in|to|on)\s+(my\s+|the\s+|this\s+)?(repo|repository|github)|(the\s+|my\s+|this\s+)?(readme(\.md)?))\b/i,
  /\b(change|update|edit|modify)\s+(the\s+|my\s+|this\s+)?(repository|repo)\s+(description|settings|name|visibility)\b/i,

  // Git push / commit / merge operations
  /\b(commit\s+(these\s+|the\s+|my\s+|all\s+)?(changes?|code|files?)\s+to\s+(github|repo|repository|main|origin)|commit\s+to\s+(github|main|origin|repo))\b/i,
  /\b(push\s+(this\s+|the\s+|my\s+)?(code|branch|changes?|commits?)\s+to\s+(main|master|github|origin|remote)|push\s+to\s+(main|master|github|origin))\b/i,
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
    .slice(0, 8000);
}

export function deterministicDenialReason(message: string): string | null {
  if (SECRET_EXFILTRATION.test(message)) {
    return "I can’t reveal credentials, authorization headers, or runtime authorization.";
  }
  if (
    POLICY_BYPASS.test(message) ||
    MUTATION_REQUEST_PATTERNS.some((p) => p.test(message))
  ) {
    return "I can’t perform that action with the current read-only GitHub policy.";
  }
  return null;
}
