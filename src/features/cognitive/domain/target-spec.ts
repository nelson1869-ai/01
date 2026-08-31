import { z } from "zod";
import { ALLOWED_GITHUB_REPO } from "../adapters/github/github-adapter";

export const gitHubTargetSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("REPOSITORY"),
    repository: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("FILE"),
    repository: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    path: z.string().min(1).max(512),
    ref: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("ISSUE"),
    repository: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    issueNumber: z.number().int().positive().max(2147483647),
  }),
  z.strictObject({
    kind: z.literal("PULL_REQUEST"),
    repository: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    pullNumber: z.number().int().positive().max(2147483647),
  }),
  z.strictObject({
    kind: z.literal("ISSUE_LIST"),
    repository: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    state: z.enum(["open", "closed", "all"]).optional(),
    perPage: z.number().int().min(1).max(50).optional(),
  }),
  z.strictObject({
    kind: z.literal("PULL_REQUEST_LIST"),
    repository: z.string().min(1),
    owner: z.string().min(1),
    repo: z.string().min(1),
    state: z.enum(["open", "closed", "all"]).optional(),
    perPage: z.number().int().min(1).max(50).optional(),
  }),
]);

export type GitHubTargetSpec = z.infer<typeof gitHubTargetSpecSchema>;

export function parseGitHubTargetSpec(
  action: string,
  text: string,
  structuredFacts?: Readonly<Record<string, unknown>>,
): GitHubTargetSpec {
  const repository = ALLOWED_GITHUB_REPO;
  const [owner = "nelson1869-ai", repo = "01"] = repository.split("/");

  let spec: GitHubTargetSpec;

  switch (action) {
    case "github.repo.get":
      spec = { kind: "REPOSITORY", repository, owner, repo };
      break;

    case "github.contents.read": {
      let path: string | null = null;
      if (
        typeof structuredFacts?.path === "string" &&
        structuredFacts.path.trim() !== ""
      ) {
        path = structuredFacts.path.trim();
      } else if (
        typeof structuredFacts?.requestedFile === "string" &&
        structuredFacts.requestedFile.trim() !== ""
      ) {
        path = structuredFacts.requestedFile.trim();
      }

      if (!path) {
        const pathMatch =
          text.match(
            /\b(?:file|path|read|inspect|contents?|from|in)\s+([a-zA-Z0-9_./-]+\.[a-zA-Z0-9_-]+)\b/i,
          ) ?? text.match(/\b([a-zA-Z0-9_/-]+\.[a-zA-Z0-9_-]+)\b/i);

        if (pathMatch) {
          path = pathMatch[1];
        } else if (text.toLowerCase().includes("readme")) {
          path = "README.md";
        } else if (text.toLowerCase().includes("package.json")) {
          path = "package.json";
        } else if (text.toLowerCase().includes("license")) {
          path = "LICENSE";
        } else if (text.toLowerCase().includes("tsconfig")) {
          path = "tsconfig.json";
        }
      }

      if (!path || path.trim() === "") {
        throw new Error(
          `Missing or invalid path for "github.contents.read". An explicit file path is required.`,
        );
      }

      spec = { kind: "FILE", repository, owner, repo, path, ref: "main" };
      break;
    }

    case "github.issues.list": {
      const state =
        structuredFacts?.state === "closed" ||
        structuredFacts?.state === "all" ||
        structuredFacts?.state === "open"
          ? structuredFacts.state
          : "open";
      const perPage =
        typeof structuredFacts?.perPage === "number" &&
        structuredFacts.perPage > 0
          ? Math.min(Math.max(structuredFacts.perPage, 1), 50)
          : 10;
      spec = {
        kind: "ISSUE_LIST",
        repository,
        owner,
        repo,
        state,
        perPage,
      };
      break;
    }

    case "github.pull_requests.list": {
      const state =
        structuredFacts?.state === "closed" ||
        structuredFacts?.state === "all" ||
        structuredFacts?.state === "open"
          ? structuredFacts.state
          : "open";
      const perPage =
        typeof structuredFacts?.perPage === "number" &&
        structuredFacts.perPage > 0
          ? Math.min(Math.max(structuredFacts.perPage, 1), 50)
          : 10;
      spec = {
        kind: "PULL_REQUEST_LIST",
        repository,
        owner,
        repo,
        state,
        perPage,
      };
      break;
    }

    case "github.issue.get": {
      let issueNumber: number | null = null;
      if (
        typeof structuredFacts?.issueNumber === "number" &&
        Number.isInteger(structuredFacts.issueNumber) &&
        structuredFacts.issueNumber > 0
      ) {
        issueNumber = structuredFacts.issueNumber;
      }
      if (issueNumber === null) {
        const match = text.match(/\b(?:issue\s*(?:#|\s+)?|#)(\d+)\b/i);
        if (match) {
          issueNumber = parseInt(match[1], 10);
        }
      }
      if (issueNumber === null || issueNumber <= 0) {
        throw new Error(
          `Missing or invalid issueNumber for "github.issue.get". Cannot default to issue #1.`,
        );
      }
      spec = { kind: "ISSUE", repository, owner, repo, issueNumber };
      break;
    }

    case "github.pull_request.get": {
      let pullNumber: number | null = null;
      if (
        typeof structuredFacts?.pullNumber === "number" &&
        Number.isInteger(structuredFacts.pullNumber) &&
        structuredFacts.pullNumber > 0
      ) {
        pullNumber = structuredFacts.pullNumber;
      }
      if (pullNumber === null) {
        const match =
          text.match(/\b(?:pull\s*request|pr)\s*(?:#|\s+)?(\d+)\b/i) ??
          text.match(/\b#(\d+)\b/i);
        if (match) {
          pullNumber = parseInt(match[1], 10);
        }
      }
      if (pullNumber === null || pullNumber <= 0) {
        throw new Error(
          `Missing or invalid pullNumber for "github.pull_request.get". Cannot default to PR #1.`,
        );
      }
      spec = { kind: "PULL_REQUEST", repository, owner, repo, pullNumber };
      break;
    }

    default:
      throw new Error(
        `Unsupported or unknown action for target spec: "${action}". Fail-closed on undefined actions.`,
      );
  }

  return gitHubTargetSpecSchema.parse(spec);
}
