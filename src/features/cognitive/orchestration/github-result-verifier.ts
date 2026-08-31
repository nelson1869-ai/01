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

    const operationKind = (data.operationKind as string) || "";
    const rawResult = data.result;

    if (
      !rawResult ||
      typeof rawResult !== "object" ||
      Object.keys(rawResult).length === 0
    ) {
      if (
        (operationKind === "github.issues.list" ||
          operationKind === "github.pull_requests.list") &&
        Array.isArray(rawResult)
      ) {
        // Empty issue/PR list is valid
      } else {
        if (operationKind === "github.repo.get") {
          return {
            status: "FAILED",
            confidence: 0.0,
            reason:
              "Observation missing expected property 'name' for repository.",
            verifierVersion: this.version,
          };
        }
        if (operationKind === "github.contents.read") {
          return {
            status: "FAILED",
            confidence: 0.0,
            reason: "Observation missing expected file property 'content'.",
            verifierVersion: this.version,
          };
        }
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: `Observation result payload is empty or invalid for ${operationKind}.`,
          verifierVersion: this.version,
        };
      }
    }

    const resultObj = rawResult as Record<string, unknown>;

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
    }

    if (operationKind === "github.contents.read") {
      const content = resultObj.content;
      if (content === undefined || content === null) {
        return {
          status: "FAILED",
          confidence: 0.0,
          reason: "Observation missing expected file property 'content'.",
          verifierVersion: this.version,
        };
      }
    }

    if (data.outcome === "CONFIRMED_SUCCESS") {
      return {
        status: "VERIFIED",
        confidence: 1.0,
        reason: `GitHub read operation verified with factual observation from repository "${ALLOWED_GITHUB_REPO}".`,
        verifierVersion: this.version,
      };
    }

    return {
      status: "FAILED",
      confidence: 0.0,
      reason: `GitHub observation did not confirm successful read on target repository: ${data.errorSummary ?? "Unverified result"}`,
      verifierVersion: this.version,
    };
  }
}
