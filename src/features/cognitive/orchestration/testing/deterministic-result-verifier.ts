import type {
  ResultVerifier,
  ResultVerifierInput,
  ResultVerifierOutput,
} from "../../domain/verifier-contract";

export class DeterministicResultVerifier implements ResultVerifier {
  readonly version: string;

  constructor(version: string = "deterministic-verifier-v1") {
    this.version = version;
  }

  verify(input: ResultVerifierInput): ResultVerifierOutput {
    if (input.observations.length === 0) {
      return {
        status: "INCONCLUSIVE",
        confidence: 0.0,
        reason: "No observation evidence provided to evaluate execution result.",
        verifierVersion: this.version,
      };
    }

    let hasSuccess = false;
    let hasFailure = false;
    let hasIndeterminate = false;
    let failureDetail = "";

    for (const obs of input.observations) {
      const outcome = (obs.data as Record<string, unknown>)?.outcome;

      if (
        outcome === "CONFIRMED_FAILURE" ||
        outcome === "PRE_DISPATCH_FAILURE" ||
        outcome === "CONFIRMED_FAILED"
      ) {
        hasFailure = true;
        failureDetail = obs.summary;
      } else if (outcome === "CONFIRMED_NOT_APPLIED") {
        hasFailure = true;
        failureDetail = "Provider confirmed operation was not applied.";
      } else if (
        outcome === "CONFIRMED_SUCCESS" ||
        outcome === "CONFIRMED_SUCCEEDED"
      ) {
        hasSuccess = true;
      } else if (outcome === "INDETERMINATE") {
        hasIndeterminate = true;
      }
    }

    if (hasFailure) {
      return {
        status: "FAILED",
        confidence: 1.0,
        reason: `Evidence proves intended execution failed: ${failureDetail}`,
        verifierVersion: this.version,
      };
    }

    if (hasSuccess) {
      return {
        status: "VERIFIED",
        confidence: 1.0,
        reason: "Observation evidence proves intended operation completed successfully.",
        verifierVersion: this.version,
      };
    }

    if (hasIndeterminate) {
      return {
        status: "INCONCLUSIVE",
        confidence: 0.5,
        reason: "Observation evidence is indeterminate and requires further observation or reconciliation.",
        verifierVersion: this.version,
      };
    }

    return {
      status: "INCONCLUSIVE",
      confidence: 0.5,
      reason: "Observation evidence is insufficient to verify intended execution goal.",
      verifierVersion: this.version,
    };
  }
}
