import type { PersistedObservation } from "../../contracts/persisted-observation";
import { PersistenceError } from "../errors/persistence-errors";
import { createCanonicalFingerprint } from "./canonical-fingerprint";

export function computeObservationSetDigest(
  observations: readonly PersistedObservation[],
): string {
  if (observations.length === 0) {
    throw PersistenceError.invalidPersistedState(
      "Cannot compute observation set digest for an empty observation set.",
    );
  }

  // Map each observation to a deterministic canonical fingerprint
  const observationFingerprints = observations.map((obs) => {
    return createCanonicalFingerprint({
      observationId: obs.observationId,
      executionId: obs.executionId,
      stepId: obs.stepId ?? null,
      source: obs.source,
      sourceEventId: obs.sourceEventId ?? null,
      summary: obs.summary,
      data: obs.data,
      observedAt: obs.observedAt,
    });
  });

  // Sort fingerprints so input ordering never changes the resultant digest
  const sortedFingerprints = [...observationFingerprints].sort();

  return createCanonicalFingerprint({
    observationCount: sortedFingerprints.length,
    observations: sortedFingerprints,
  });
}
