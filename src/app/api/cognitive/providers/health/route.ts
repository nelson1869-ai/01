import {
  apiSuccess,
  handleRouteError,
} from "../../../../../features/cognitive/api/api-response";
import { ALLOWED_GITHUB_REPO } from "../../../../../features/cognitive/adapters/github/github-adapter";

export async function GET() {
  try {
    const isGeminiConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== "",
    );
    const isGithubConfigured = Boolean(
      process.env.GITHUB_TOKEN && process.env.GITHUB_TOKEN.trim() !== "",
    );

    return apiSuccess({
      engine: {
        provider: "autodo",
        type: "deterministic-engine",
        status: "READY",
      },
      ollama: {
        provider: "ollama",
        model: "qwen3.5:9b",
        status: "READY",
      },
      gemini: {
        configured: isGeminiConfigured,
        provider: "gemini",
        models: ["gemini-3.5-flash-lite", "gemini-3.7-flash"],
        status: isGeminiConfigured ? "READY" : "UNCONFIGURED",
      },
      github: {
        configured: isGithubConfigured,
        provider: "github",
        mode: "READ_ONLY",
        allowedRepository: ALLOWED_GITHUB_REPO,
        status: isGithubConfigured ? "READY" : "UNCONFIGURED",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
