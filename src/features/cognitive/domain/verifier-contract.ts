import type { PersistedExecution } from "../persistence/contracts/execution";
import type { PersistedObservation } from "../persistence/contracts/persisted-observation";

export type VerificationStatus = "VERIFIED" | "FAILED" | "INCONCLUSIVE";

export interface ResultVerifierInput {
  readonly execution: PersistedExecution;
  readonly observations: readonly PersistedObservation[];
  readonly expectedResult?: Readonly<Record<string, unknown>>;
}

export interface ResultVerifierOutput {
  readonly status: VerificationStatus;
  readonly confidence: number;
  readonly reason: string;
  readonly verifierVersion: string;
}

export interface ResultVerifier {
  readonly version: string;
  verify(
    input: ResultVerifierInput,
  ): Promise<ResultVerifierOutput> | ResultVerifierOutput;
}
