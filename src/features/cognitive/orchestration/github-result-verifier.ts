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

    const resultObj = (data.result && typeof data.result === "object"
      ? data.result
      : {}) as Record<string, unknown>;
    const repoMatch =
      data.repository === ALLOWED_GITHUB_REPO ||
      resultObj.repository === ALLOWED_GITHUB_REPO ||
      resultObj.fullName === ALLOWED_GITHUB_REPO ||
      resultObj.name === "01";

    // Check if observation indicates confirmed provider success with factual target repo
    if (data.outcome === "CONFIRMED_SUCCESS" && repoMatch) {
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
