import {
  type DispatchInput,
  type DispatchResult,
  type OperationAdapter,
} from "../adapter-contract";
import { sanitizeErrorMessage } from "../../ai/ai-errors";

export const ALLOWED_GITHUB_REPO = "nelson1869-ai/01";

export interface GitHubAdapterOptions {
  readonly token?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly fetchFn?: typeof fetch;
}

export type GitHubOperationRequest = {
  readonly repository: string;
  readonly path?: string;
  readonly ref?: string;
  readonly state?: "open" | "closed" | "all";
  readonly perPage?: number;
  readonly issueNumber?: number;
  readonly pullNumber?: number;
};

export type GitHubOperationResult = Readonly<Record<string, unknown>>;

export class GitHubReadOnlyAdapter implements OperationAdapter<
  GitHubOperationRequest,
  GitHubOperationResult
> {
  readonly scope = "github-rest";
  readonly idempotencySupport = "NONE" as const;
  readonly supportsReconciliation = false;

  private readonly token: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options?: GitHubAdapterOptions) {
    this.token = options?.token ?? process.env.GITHUB_TOKEN ?? null;
    this.baseUrl = options?.baseUrl ?? "https://api.github.com";
    this.timeoutMs = options?.timeoutMs ?? 15_000;
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  async dispatch(
    input: DispatchInput<GitHubOperationRequest>,
  ): Promise<DispatchResult<GitHubOperationResult>> {
    const finishedAt = new Date().toISOString();
    const req = input.request;

    // 1. Hard repository allowlist check
    if (!req.repository || req.repository !== ALLOWED_GITHUB_REPO) {
      return {
        outcome: "CONFIRMED_FAILURE",
        providerOperationId: null,
        errorSummary: `Repository "${req.repository}" is not in the allowed target repository allowlist ("${ALLOWED_GITHUB_REPO}").`,
        isDeterministic: true,
        finishedAt,
      };
    }

    // 2. Validate token presence (server-side only)
    if (!this.token) {
      return {
        outcome: "CONFIRMED_FAILURE",
        providerOperationId: null,
        errorSummary:
          "Missing GitHub token (GITHUB_TOKEN environment variable not set).",
        isDeterministic: true,
        finishedAt,
      };
    }

    // 3. Build HTTP GET URL based on operationKind (GET ONLY)
    let url: string;
    try {
      url = this.buildRequestUrl(input.operationKind, req);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        outcome: "CONFIRMED_FAILURE",
        providerOperationId: null,
        errorSummary: sanitizeErrorMessage(`Request validation failed: ${msg}`),
        isDeterministic: true,
        finishedAt,
      };
    }

    // 4. Execute HTTP GET with bounded timeout and headers
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "AutoDo-AI-M7/1.0",
        },
        signal: controller.signal,
      });

      clearTimeout(timer);
      const responseFinishedAt = new Date().toISOString();

      if (!response.ok) {
        return this.mapHttpError(response.status, responseFinishedAt);
      }

      const rawJson: unknown = await response.json();
      const normalizedResult = this.normalizeOutput(
        input.operationKind,
        req,
        rawJson,
      );

      return {
        outcome: "CONFIRMED_SUCCESS",
        providerOperationId: `gh-${input.operationKind}-${Date.now()}`,
        result: normalizedResult,
        finishedAt: responseFinishedAt,
        metadata: {
          provider: "github-rest",
          repository: ALLOWED_GITHUB_REPO,
          operationKind: input.operationKind,
          httpStatus: response.status,
        },
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const errFinishedAt = new Date().toISOString();
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitized = sanitizeErrorMessage(rawMessage);

      if (
        sanitized.toLowerCase().includes("abort") ||
        sanitized.toLowerCase().includes("timeout")
      ) {
        return {
          outcome: "CONFIRMED_FAILURE",
          providerOperationId: null,
          errorSummary: `GitHub API request timed out after ${this.timeoutMs}ms.`,
          isDeterministic: true,
          finishedAt: errFinishedAt,
        };
      }

      return {
        outcome: "CONFIRMED_FAILURE",
        providerOperationId: null,
        errorSummary: `GitHub network request failed: ${sanitized}`,
        isDeterministic: true,
        finishedAt: errFinishedAt,
      };
    }
  }

  private buildRequestUrl(
    operationKind: string,
    req: GitHubOperationRequest,
  ): string {
    const [owner, repo] = ALLOWED_GITHUB_REPO.split("/");

    switch (operationKind) {
      case "github.repo.get":
        return `${this.baseUrl}/repos/${owner}/${repo}`;

      case "github.contents.read": {
        const path = req.path;
        if (!path || typeof path !== "string" || path.trim() === "") {
          throw new Error(
            "Missing or invalid path for github.contents.read. An explicit path is required.",
          );
        }
        this.validatePathSecurity(path);
        const encodedPath = path.split("/").map(encodeURIComponent).join("/");
        const refParam = req.ref ? `?ref=${encodeURIComponent(req.ref)}` : "";
        return `${this.baseUrl}/repos/${owner}/${repo}/contents/${encodedPath}${refParam}`;
      }

      case "github.issues.list": {
        const state = req.state ?? "open";
        const perPage = Math.min(Math.max(req.perPage ?? 10, 1), 50);
        return `${this.baseUrl}/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${perPage}`;
      }

      case "github.issue.get": {
        const issueNumber = req.issueNumber;
        if (
          typeof issueNumber !== "number" ||
          !Number.isInteger(issueNumber) ||
          issueNumber <= 0
        ) {
          throw new Error(
            `Missing or invalid issue number: ${issueNumber}. An explicit positive integer issueNumber is required.`,
          );
        }
        return `${this.baseUrl}/repos/${owner}/${repo}/issues/${issueNumber}`;
      }

      case "github.pull_requests.list": {
        const state = req.state ?? "open";
        const perPage = Math.min(Math.max(req.perPage ?? 10, 1), 50);
        return `${this.baseUrl}/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=${perPage}`;
      }

      case "github.pull_request.get": {
        const pullNumber = req.pullNumber;
        if (
          typeof pullNumber !== "number" ||
          !Number.isInteger(pullNumber) ||
          pullNumber <= 0
        ) {
          throw new Error(
            `Missing or invalid pull request number: ${pullNumber}. An explicit positive integer pullNumber is required.`,
          );
        }
        return `${this.baseUrl}/repos/${owner}/${repo}/pulls/${pullNumber}`;
      }

      default:
        throw new Error(
          `Unsupported operation kind: "${operationKind}". Only read-only GitHub actions are allowed.`,
        );
    }
  }

  private validatePathSecurity(path: string): void {
    if (!path || typeof path !== "string") {
      throw new Error("Path must be a non-empty string.");
    }
    if (path.length > 512) {
      throw new Error("Path exceeds maximum length of 512 characters.");
    }
    if (
      path.includes("\0") ||
      path.includes("..") ||
      path.includes("\\") ||
      path.startsWith("/") ||
      path.includes("%2e%2e") ||
      path.includes("%2E%2E")
    ) {
      throw new Error(`Potentially malicious or invalid path: "${path}".`);
    }
  }

  private normalizeOutput(
    operationKind: string,
    req: GitHubOperationRequest,
    rawJson: unknown,
  ): GitHubOperationResult {
    void req;
    const data = (
      rawJson && typeof rawJson === "object" ? rawJson : {}
    ) as Record<string, unknown>;

    switch (operationKind) {
      case "github.repo.get": {
        if (!rawJson || typeof rawJson !== "object" || Array.isArray(rawJson)) {
          throw new Error(
            "GitHub repository response is malformed (expected non-array object).",
          );
        }
        return {
          ...(typeof data.name === "string" ? { name: data.name } : {}),
          ...(typeof data.full_name === "string"
            ? { fullName: data.full_name }
            : {}),
          ...(typeof data.default_branch === "string"
            ? { defaultBranch: data.default_branch }
            : {}),
          description:
            typeof data.description === "string" ? data.description : null,
          ...(typeof data.private === "boolean"
            ? { isPrivate: data.private }
            : {}),
          ...(typeof data.updated_at === "string"
            ? { updatedAt: data.updated_at }
            : {}),
        };
      }

      case "github.contents.read": {
        if (!rawJson || typeof rawJson !== "object" || Array.isArray(rawJson)) {
          throw new Error(
            "GitHub file contents response is malformed (expected non-array object).",
          );
        }
        const size = typeof data.size === "number" ? data.size : 0;
        const observedPath =
          typeof data.path === "string" ? data.path : undefined;

        if (size > 256 * 1024) {
          return {
            repository: ALLOWED_GITHUB_REPO,
            ...(observedPath ? { path: observedPath } : {}),
            sha: typeof data.sha === "string" ? data.sha : null,
            size,
            isOversized: true,
            summary: `File exceeds maximum allowed size of 256 KB (size: ${size} bytes).`,
          };
        }

        let content = "";
        if (typeof data.content === "string" && data.encoding === "base64") {
          try {
            content = Buffer.from(
              data.content.replace(/\n/g, ""),
              "base64",
            ).toString("utf-8");
          } catch {
            content = "[Binary or unparseable content]";
          }
        }

        // Bound returned text content (max 64 KB characters in normalized object)
        const boundedContent =
          content.length > 65536
            ? content.slice(0, 65536) + "\n...[truncated]"
            : content;

        return {
          repository: ALLOWED_GITHUB_REPO,
          ...(observedPath ? { path: observedPath } : {}),
          sha: typeof data.sha === "string" ? data.sha : null,
          size,
          content: boundedContent,
          encoding: "utf-8",
        };
      }

      case "github.issues.list": {
        if (!Array.isArray(rawJson)) {
          throw new Error(
            "GitHub issues list response is malformed (expected array).",
          );
        }
        const issuesOnly = rawJson.filter((rawItem: unknown) => {
          const item = (
            rawItem && typeof rawItem === "object" ? rawItem : {}
          ) as Record<string, unknown>;
          return !("pull_request" in item);
        });
        const boundedItems = issuesOnly.slice(0, 50).map((rawItem: unknown) => {
          const item = (
            rawItem && typeof rawItem === "object" ? rawItem : {}
          ) as Record<string, unknown>;
          return {
            ...(typeof item.number === "number" ? { number: item.number } : {}),
            title: String(item.title ?? "").slice(0, 200),
            ...(typeof item.state === "string" ? { state: item.state } : {}),
            ...(typeof item.html_url === "string"
              ? { url: item.html_url }
              : {}),
            ...(typeof item.updated_at === "string"
              ? { updatedAt: item.updated_at }
              : {}),
          };
        });
        return {
          repository: ALLOWED_GITHUB_REPO,
          count: boundedItems.length,
          issues: boundedItems,
        };
      }

      case "github.issue.get": {
        if (!rawJson || typeof rawJson !== "object" || Array.isArray(rawJson)) {
          throw new Error(
            "GitHub issue response is malformed (expected non-array object).",
          );
        }
        return {
          repository: ALLOWED_GITHUB_REPO,
          ...(typeof data.number === "number" ? { number: data.number } : {}),
          title: String(data.title ?? "").slice(0, 200),
          ...(typeof data.state === "string" ? { state: data.state } : {}),
          body: String(data.body ?? "").slice(0, 4096),
          ...(typeof data.html_url === "string"
            ? { url: data.html_url }
            : {}),
          ...(typeof data.updated_at === "string"
            ? { updatedAt: data.updated_at }
            : {}),
        };
      }

      case "github.pull_requests.list": {
        if (!Array.isArray(rawJson)) {
          throw new Error(
            "GitHub pull requests list response is malformed (expected array).",
          );
        }
        const boundedItems = rawJson.slice(0, 50).map((rawItem: unknown) => {
          const item = (
            rawItem && typeof rawItem === "object" ? rawItem : {}
          ) as Record<string, unknown>;
          return {
            ...(typeof item.number === "number" ? { number: item.number } : {}),
            title: String(item.title ?? "").slice(0, 200),
            ...(typeof item.state === "string" ? { state: item.state } : {}),
            ...(typeof item.html_url === "string"
              ? { url: item.html_url }
              : {}),
            ...(typeof item.updated_at === "string"
              ? { updatedAt: item.updated_at }
              : {}),
          };
        });
        return {
          repository: ALLOWED_GITHUB_REPO,
          count: boundedItems.length,
          pullRequests: boundedItems,
        };
      }

      case "github.pull_request.get": {
        if (!rawJson || typeof rawJson !== "object" || Array.isArray(rawJson)) {
          throw new Error(
            "GitHub pull request response is malformed (expected non-array object).",
          );
        }
        return {
          repository: ALLOWED_GITHUB_REPO,
          ...(typeof data.number === "number" ? { number: data.number } : {}),
          title: String(data.title ?? "").slice(0, 200),
          ...(typeof data.state === "string" ? { state: data.state } : {}),
          body: String(data.body ?? "").slice(0, 4096),
          ...(typeof data.html_url === "string"
            ? { url: data.html_url }
            : {}),
          ...(typeof data.updated_at === "string"
            ? { updatedAt: data.updated_at }
            : {}),
        };
      }

      default:
        return {
          repository: ALLOWED_GITHUB_REPO,
          rawSummary: "Read operation completed.",
        };
    }
  }

  private mapHttpError(status: number, finishedAt: string): DispatchResult {
    switch (status) {
      case 401:
        return {
          outcome: "CONFIRMED_FAILURE",
          providerOperationId: null,
          errorSummary:
            "GitHub authentication failed (HTTP 401 Unauthorized): verify GITHUB_TOKEN.",
          isDeterministic: true,
          finishedAt,
        };

      case 403:
        return {
          outcome: "CONFIRMED_FAILURE",
          providerOperationId: null,
          errorSummary:
            "GitHub access forbidden or rate limit exceeded (HTTP 403 Forbidden).",
          isDeterministic: true,
          finishedAt,
        };

      case 404:
        return {
          outcome: "CONFIRMED_FAILURE",
          providerOperationId: null,
          errorSummary:
            "Requested GitHub resource or repository was not found (HTTP 404 Not Found).",
          isDeterministic: true,
          finishedAt,
        };

      case 429:
        return {
          outcome: "CONFIRMED_FAILURE",
          providerOperationId: null,
          errorSummary:
            "GitHub rate limit exceeded (HTTP 429 Too Many Requests).",
          isDeterministic: true,
          finishedAt,
        };

      default:
        return {
          outcome: "CONFIRMED_FAILURE",
          providerOperationId: null,
          errorSummary: `GitHub API returned error response (HTTP ${status}).`,
          isDeterministic: true,
          finishedAt,
        };
    }
  }
}
