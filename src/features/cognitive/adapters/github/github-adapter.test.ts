import { describe, expect, it } from "vitest";
import { ALLOWED_GITHUB_REPO, GitHubReadOnlyAdapter } from "./github-adapter";

function createMockFetch(responseInit: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    // Assert method is strictly GET
    if (init?.method && init.method !== "GET") {
      throw new Error(`Non-GET method detected: ${init.method}`);
    }

    const status = responseInit.status ?? 200;
    const body = responseInit.body !== undefined ? responseInit.body : {};

    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        ...(responseInit.headers ?? {}),
      },
    });
  };
}

describe("GitHubReadOnlyAdapter", () => {
  const dummyInput = {
    operationId: "op-1",
    operationKind: "github.contents.read",
    operationGeneration: 1,
    attemptNumber: 1,
    idempotencyKey: "idemp-1",
    providerScope: "github-rest",
    providerIdempotencyKey: null,
    request: {
      repository: ALLOWED_GITHUB_REPO,
      path: "README.md",
    },
  };

  it("fails when GITHUB_TOKEN is not configured", async () => {
    const adapter = new GitHubReadOnlyAdapter({ token: "" });
    const result = await adapter.dispatch(dummyInput);

    expect(result.outcome).toBe("CONFIRMED_FAILURE");
    if (result.outcome === "CONFIRMED_FAILURE") {
      expect(result.errorSummary).toContain("Missing GitHub token");
    }
  });

  it("rejects non-allowlisted repositories", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({ status: 200 }),
    });

    const result = await adapter.dispatch({
      ...dummyInput,
      request: {
        repository: "attacker/malicious-repo",
      },
    });

    expect(result.outcome).toBe("CONFIRMED_FAILURE");
    if (result.outcome === "CONFIRMED_FAILURE") {
      expect(result.errorSummary).toContain(
        "not in the allowed target repository allowlist",
      );
    }
  });

  it("performs GET-only requests and never includes token in URL", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(url);
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({
          name: "01",
          full_name: "nelson1869-ai/01",
          default_branch: "main",
        }),
        { status: 200 },
      );
    };

    const adapter = new GitHubReadOnlyAdapter({
      token: "ghp_mocktoken1234567890abcdef",
      fetchFn: mockFetch,
    });

    const result = await adapter.dispatch({
      ...dummyInput,
      operationKind: "github.repo.get",
      request: { repository: ALLOWED_GITHUB_REPO },
    });

    expect(result.outcome).toBe("CONFIRMED_SUCCESS");
    expect(capturedUrl).toBe("https://api.github.com/repos/nelson1869-ai/01");
    expect(capturedUrl).not.toContain("ghp_mocktoken1234567890abcdef");
    expect(capturedHeaders.Authorization).toBe(
      "Bearer ghp_mocktoken1234567890abcdef",
    );
    expect(capturedHeaders["X-GitHub-Api-Version"]).toBe("2026-03-10");
  });

  it("rejects path traversal attempts on contents.read", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({ status: 200 }),
    });

    const maliciousPaths = [
      "../secret.txt",
      "..\\secret.txt",
      "/etc/passwd",
      "foo/../../bar",
      "test\0evil.txt",
      "%2e%2e/passwd",
    ];

    for (const path of maliciousPaths) {
      const result = await adapter.dispatch({
        ...dummyInput,
        request: {
          repository: ALLOWED_GITHUB_REPO,
          path,
        },
      });

      expect(result.outcome).toBe("CONFIRMED_FAILURE");
      if (result.outcome === "CONFIRMED_FAILURE") {
        expect(result.errorSummary).toContain("malicious or invalid path");
      }
    }
  });

  it("decodes base64 file content safely", async () => {
    const rawContent = "# AutoDo AI\nAutonomous coding agent.";
    const base64Content = Buffer.from(rawContent).toString("base64");

    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({
        status: 200,
        body: {
          name: "README.md",
          path: "README.md",
          sha: "sha-abc-123",
          size: Buffer.byteLength(rawContent),
          encoding: "base64",
          content: base64Content,
        },
      }),
    });

    const result = await adapter.dispatch(dummyInput);
    expect(result.outcome).toBe("CONFIRMED_SUCCESS");
    if (result.outcome === "CONFIRMED_SUCCESS") {
      expect(result.result.content).toBe(rawContent);
      expect(result.result.sha).toBe("sha-abc-123");
    }
  });

  it("bounds oversized file content (> 256 KB)", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({
        status: 200,
        body: {
          name: "huge.txt",
          path: "huge.txt",
          sha: "sha-huge",
          size: 300 * 1024, // 300 KB
        },
      }),
    });

    const result = await adapter.dispatch({
      ...dummyInput,
      request: {
        repository: ALLOWED_GITHUB_REPO,
        path: "huge.txt",
      },
    });

    expect(result.outcome).toBe("CONFIRMED_SUCCESS");
    if (result.outcome === "CONFIRMED_SUCCESS") {
      expect(result.result.isOversized).toBe(true);
      expect(result.result.content).toBeUndefined();
    }
  });

  it("bounds issues and pull request lists to 50 items", async () => {
    const rawIssues = Array.from({ length: 60 }, (_, i) => ({
      number: i + 1,
      title: `Issue #${i + 1}`,
      state: "open",
      html_url: `https://github.com/nelson1869-ai/01/issues/${i + 1}`,
    }));

    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({ status: 200, body: rawIssues }),
    });

    const result = await adapter.dispatch({
      ...dummyInput,
      operationKind: "github.issues.list",
      request: { repository: ALLOWED_GITHUB_REPO },
    });

    expect(result.outcome).toBe("CONFIRMED_SUCCESS");
    if (result.outcome === "CONFIRMED_SUCCESS") {
      expect(result.result.count).toBe(50);
      expect((result.result.issues as readonly unknown[]).length).toBe(50);
    }
  });

  it("maps HTTP status codes 401, 403, 404, 429 safely", async () => {
    const testCases: [number, string][] = [
      [401, "authentication failed"],
      [403, "access forbidden"],
      [404, "not found"],
      [429, "rate limit"],
    ];

    for (const [status, expectedSubstring] of testCases) {
      const adapter = new GitHubReadOnlyAdapter({
        token: "test-token",
        fetchFn: createMockFetch({ status, body: { message: "Error" } }),
      });

      const result = await adapter.dispatch(dummyInput);
      expect(result.outcome).toBe("CONFIRMED_FAILURE");
      if (result.outcome === "CONFIRMED_FAILURE") {
        expect(result.errorSummary.toLowerCase()).toContain(expectedSubstring);
      }
    }
  });

  it("rejects malformed HTTP 200 non-array object on github.issues.list", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({ status: 200, body: {} }),
    });

    const result = await adapter.dispatch({
      ...dummyInput,
      operationKind: "github.issues.list",
      request: { repository: ALLOWED_GITHUB_REPO },
    });

    expect(result.outcome).toBe("CONFIRMED_FAILURE");
    if (result.outcome === "CONFIRMED_FAILURE") {
      expect(result.errorSummary).toContain("malformed (expected array)");
    }
  });

  it("handles valid HTTP 200 empty array on github.issues.list", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({ status: 200, body: [] }),
    });

    const result = await adapter.dispatch({
      ...dummyInput,
      operationKind: "github.issues.list",
      request: { repository: ALLOWED_GITHUB_REPO },
    });

    expect(result.outcome).toBe("CONFIRMED_SUCCESS");
    if (result.outcome === "CONFIRMED_SUCCESS") {
      expect(result.result.count).toBe(0);
      expect(result.result.issues).toEqual([]);
      expect(result.result.repository).toBe(ALLOWED_GITHUB_REPO);
    }
  });

  it("rejects malformed HTTP 200 non-array object on github.pull_requests.list", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({ status: 200, body: {} }),
    });

    const result = await adapter.dispatch({
      ...dummyInput,
      operationKind: "github.pull_requests.list",
      request: { repository: ALLOWED_GITHUB_REPO },
    });

    expect(result.outcome).toBe("CONFIRMED_FAILURE");
    if (result.outcome === "CONFIRMED_FAILURE") {
      expect(result.errorSummary).toContain("malformed (expected array)");
    }
  });

  it("handles valid HTTP 200 empty array on github.pull_requests.list", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({ status: 200, body: [] }),
    });

    const result = await adapter.dispatch({
      ...dummyInput,
      operationKind: "github.pull_requests.list",
      request: { repository: ALLOWED_GITHUB_REPO },
    });

    expect(result.outcome).toBe("CONFIRMED_SUCCESS");
    if (result.outcome === "CONFIRMED_SUCCESS") {
      expect(result.result.count).toBe(0);
      expect(result.result.pullRequests).toEqual([]);
      expect(result.result.repository).toBe(ALLOWED_GITHUB_REPO);
    }
  });

  it("filters PR-backed issue records BEFORE slicing to 50 items", async () => {
    // 50 PR records followed by 10 pure issue records
    const prRecords = Array.from({ length: 50 }, (_, i) => ({
      number: 100 + i,
      title: `PR #${i + 1}`,
      state: "open",
      pull_request: {
        url: `https://api.github.com/repos/nelson1869-ai/01/pulls/${100 + i}`,
      },
    }));

    const pureIssues = Array.from({ length: 10 }, (_, i) => ({
      number: i + 1,
      title: `Issue #${i + 1}`,
      state: "open",
      html_url: `https://github.com/nelson1869-ai/01/issues/${i + 1}`,
    }));

    const rawResponse = [...prRecords, ...pureIssues];

    const adapter = new GitHubReadOnlyAdapter({
      token: "test-token",
      fetchFn: createMockFetch({ status: 200, body: rawResponse }),
    });

    const result = await adapter.dispatch({
      ...dummyInput,
      operationKind: "github.issues.list",
      request: { repository: ALLOWED_GITHUB_REPO },
    });

    expect(result.outcome).toBe("CONFIRMED_SUCCESS");
    if (result.outcome === "CONFIRMED_SUCCESS") {
      // If filtered before slice, all 10 pure issues are preserved.
      // If sliced before filter, 0 issues would be returned.
      expect(result.result.count).toBe(10);
      const issues = result.result.issues as readonly {
        number: number;
        title: string;
      }[];
      expect(issues.length).toBe(10);
      expect(issues[0].number).toBe(1);
      expect(issues[9].number).toBe(10);
    }
  });
});
