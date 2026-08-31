import { ALLOWED_GITHUB_REPO } from "../adapters/github/github-adapter";

export type GitHubTargetSpec =
  | {
      readonly kind: "REPOSITORY";
      readonly repository: string;
      readonly owner: string;
      readonly repo: string;
    }
  | {
      readonly kind: "FILE";
      readonly repository: string;
      readonly owner: string;
      readonly repo: string;
      readonly path: string;
      readonly ref?: string;
    }
  | {
      readonly kind: "ISSUE";
      readonly repository: string;
      readonly owner: string;
      readonly repo: string;
      readonly issueNumber: number;
    }
  | {
      readonly kind: "PULL_REQUEST";
      readonly repository: string;
      readonly owner: string;
      readonly repo: string;
      readonly pullNumber: number;
    }
  | {
      readonly kind: "ISSUE_LIST";
      readonly repository: string;
      readonly owner: string;
      readonly repo: string;
      readonly state?: "open" | "closed" | "all";
      readonly perPage?: number;
    }
  | {
      readonly kind: "PULL_REQUEST_LIST";
      readonly repository: string;
      readonly owner: string;
      readonly repo: string;
      readonly state?: "open" | "closed" | "all";
      readonly perPage?: number;
    };

export function parseGitHubTargetSpec(
  action: string,
  text: string,
  structuredFacts?: Readonly<Record<string, unknown>>,
): GitHubTargetSpec {
  const repository = ALLOWED_GITHUB_REPO;
  const [owner = "nelson1869-ai", repo = "01"] = repository.split("/");

  switch (action) {
    case "github.repo.get":
      return { kind: "REPOSITORY", repository, owner, repo };

    case "github.contents.read": {
      let path: string | null = null;
      if (
        typeof structuredFacts?.path === "string" &&
        structuredFacts.path.trim() !== ""
      ) {
        path = structuredFacts.path.trim();
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
        } else {
          path = "README.md";
        }
      }
      return { kind: "FILE", repository, owner, repo, path, ref: "main" };
    }

    case "github.issues.list":
      return {
        kind: "ISSUE_LIST",
        repository,
        owner,
        repo,
        state: "open",
        perPage: 10,
      };

    case "github.pull_requests.list":
      return {
        kind: "PULL_REQUEST_LIST",
        repository,
        owner,
        repo,
        state: "open",
        perPage: 10,
      };

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
      return { kind: "ISSUE", repository, owner, repo, issueNumber };
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
      return { kind: "PULL_REQUEST", repository, owner, repo, pullNumber };
    }

    default:
      return { kind: "REPOSITORY", repository, owner, repo };
  }
}
