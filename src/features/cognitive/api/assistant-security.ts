import { sanitizeErrorMessage } from "../ai/ai-errors";

const SECRET_REQUEST = /\b(show|reveal|print|give|display|return|tell)\b[\s\S]{0,80}\b(gemini[_ -]?api[_ -]?key|github[_ -]?token|test[_ -]?database[_ -]?url|authorization header|runtime authorization|credentials?|secrets?)\b/i;
const POLICY_BYPASS = /\b(ignore|bypass|override|disable|forget)\b[\s\S]{0,80}\b(rule|policy|safety|authorization|allowlist|instruction)\b/i;
const MUTATION_REQUEST = /\b(delete|remove|push|commit|merge|write|modify|update|rename|create)\b[\s\S]{0,100}\b(repository|repo|branch|main|file|issue|pull request|pr)\b|\b(repository|repo|branch|main|file|issue|pull request|pr)\b[\s\S]{0,100}\b(delete|remove|push|commit|merge|write|modify|update|rename|create)\b/i;

export function redactAssistantMessage(message: string): string {
  return sanitizeErrorMessage(message)
    .replace(/\b(?:GEMINI_API_KEY|GITHUB_TOKEN|TEST_DATABASE_URL)\s*[=:]\s*\S+/gi, "[REDACTED_SECRET]")
    .slice(0, 8000);
}

export function deterministicDenialReason(message: string): string | null {
  if (SECRET_REQUEST.test(message)) {
    return "I can’t reveal credentials, authorization headers, or runtime authorization.";
  }
  if (MUTATION_REQUEST.test(message) || POLICY_BYPASS.test(message)) {
    return "I can’t perform that action with the current read-only GitHub policy.";
  }
  return null;
}
