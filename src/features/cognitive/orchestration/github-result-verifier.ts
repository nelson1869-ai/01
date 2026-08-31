import type {
  ResultVerifier,
  ResultVerifierInput,
  ResultVerifierOutput,
} from "../domain/verifier-contract";
import { ALLOWED_GITHUB_REPO } from "../adapters/github/github-adapter";

export class GitHubResultVerifier implements ResultVerifier {
  readonly version = "github-result-verifier-v1";

  async verify(input: ResultVerifierInput): Promise<ResultVerifierOutput> {
    const observations = input.observations;

    if (observations.length === 0) {
      return {
        status: "FAILED",
        confidence: 0.0,
        reason: "No observations recorded for GitHub execution.",
        verifierVersion: this.version,
      };
    }

    const observation = observations[0];
    const data = observation.data as Record<string, unknown> | null;

    if (!data) {
      return {
        status: "FAILED",
        confidence: 0.0,
        reason: "Observation data is missing or empty.",
        verifierVersion: this.version,
      };
    }

    if (data.outcome !== "CONFIRMED_SUCCESS") {
      return {
        status: "FAILED",
        confidence: 0.0,
        reason: `GitHub observation did not confirm successful read on target repository: ${data.errorSummary ?? "Unverified result"}`,
        verifierVersion: this.version,
      };
    }

    const operationKind = (data.operationKind as string) || "";
    const rawResult = data.result;

    if (!rawResult || typeof rawResult !== "object") {
      return {
        status: "FAILED",
        confidence: 0.0,
        reason: `Observation result payload is empty or invalid for ${operationKind}.`,
        verifierVersion: this.version,
      };
    }

    const resultObj = rawResult as Record<string, unknown>;
    const expected = input.expectedResult;

    if (operationKind === "github.repo.get") {
      const name = (resultObj.name as string) || "";
      const fullName =
        (resultObj.full_name as string) || (resultObj.fullName as string) || "";
      if (!name && !fullName) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason:
            "Observation missing expected property 'name' or 'full_name' for repository.",
          verifierVersion: this.version,
        };
      }
      if (
        (fullName && fullName !== ALLOWED_GITHUB_REPO) ||
        (name && name !== "01" && fullName !== ALLOWED_GITHUB_REPO)
      ) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: `Result repository "${fullName || name}" does not match allowed repository "${ALLOWED_GITHUB_REPO}".`,
          verifierVersion: this.version,
        };
      }
    } else if (operationKind === "github.contents.read") {
      const content = resultObj.content;
      const isOversized = Boolean(resultObj.isOversized);
      if (content === undefined && !isOversized) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: "Observation missing expected file property 'content'.",
          verifierVersion: this.version,
        };
      }

      if (expected && typeof expected.path === "string") {
        const actualPath = resultObj.path;
        if (typeof actualPath !== "string" || actualPath !== expected.path) {
          return {
            status: "FAILED",
            confidence: 0.0,
            reason: `Result file path "${actualPath ?? "unknown"}" does not match expected target path "${expected.path}".`,
            verifierVersion: this.version,
          };
        }
      }
    } else if (operationKind === "github.issue.get") {
      const actualNumber = resultObj.number;
      if (typeof actualNumber !== "number" || actualNumber <= 0) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: "Observation missing valid 'number' for issue.",
          verifierVersion: this.version,
        };
      }

      if (expected && typeof expected.issueNumber === "number") {
        if (actualNumber !== expected.issueNumber) {
          return {
            status: "FAILED",
            confidence: 0.0,
            reason: `Result issue #${actualNumber} does not match expected target issue #${expected.issueNumber}.`,
            verifierVersion: this.version,
          };
        }
      }
    } else if (operationKind === "github.pull_request.get") {
      const actualNumber = resultObj.number;
      if (typeof actualNumber !== "number" || actualNumber <= 0) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: "Observation missing valid 'number' for pull request.",
          verifierVersion: this.version,
        };
      }

      if (expected && typeof expected.pullNumber === "number") {
        if (actualNumber !== expected.pullNumber) {
          return {
            status: "FAILED",
            confidence: 0.0,
            reason: `Result PR #${actualNumber} does not match expected target PR #${expected.pullNumber}.`,
            verifierVersion: this.version,
          };
        }
      }
    } else if (operationKind === "github.issues.list") {
      if (expected && expected.kind !== "ISSUE_LIST") {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: `Expected target kind "${expected.kind}" does not match operation kind "${operationKind}".`,
          verifierVersion: this.version,
        };
      }
      if (resultObj.repository !== ALLOWED_GITHUB_REPO) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: `Result repository "${resultObj.repository ?? "unknown"}" does not match allowed repository "${ALLOWED_GITHUB_REPO}".`,
          verifierVersion: this.version,
        };
      }
      if (!Array.isArray(resultObj.issues)) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: "Observation missing valid 'issues' list.",
          verifierVersion: this.version,
        };
      }
    } else if (operationKind === "github.pull_requests.list") {
      if (expected && expected.kind !== "PULL_REQUEST_LIST") {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: `Expected target kind "${expected.kind}" does not match operation kind "${operationKind}".`,
          verifierVersion: this.version,
        };
      }
      if (resultObj.repository !== ALLOWED_GITHUB_REPO) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: `Result repository "${resultObj.repository ?? "unknown"}" does not match allowed repository "${ALLOWED_GITHUB_REPO}".`,
          verifierVersion: this.version,
        };
      }
      if (!Array.isArray(resultObj.pullRequests)) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: "Observation missing valid 'pullRequests' list.",
          verifierVersion: this.version,
        };
      }
    }

    return {
      status: "VERIFIED",
      confidence: 1.0,
      reason: `GitHub read operation verified with factual observation from repository "${ALLOWED_GITHUB_REPO}".`,
      verifierVersion: this.version,
    };
  }
}
