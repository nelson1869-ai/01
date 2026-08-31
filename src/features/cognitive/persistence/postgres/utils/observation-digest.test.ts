import { describe, expect, it } from "vitest";

import type { PersistedObservation } from "../../contracts/persisted-observation";
import { computeObservationSetDigest } from "./observation-digest";

describe("observation set canonical digest", () => {
  const T0 = "2026-08-31T05:00:00.000Z";

  const obs1: PersistedObservation = {
    observationId: "obs-1",
    executionId: "exec-1",
    stepId: "step-1",
    source: "provider-dispatch",
    sourceEventId: "evt-1",
    summary: "Provider confirmed success",
    data: { action: "send", status: "200" },
    observedAt: T0,
    payloadExpiresAt: null,
  };

  const obs2: PersistedObservation = {
    observationId: "obs-2",
    executionId: "exec-1",
    stepId: "step-2",
    source: "provider-reconciliation",
    sourceEventId: "evt-2",
    summary: "Reconciliation confirmed applied",
    data: { verified: true },
    observedAt: T0,
    payloadExpiresAt: null,
  };

  it("produces identical digest regardless of input array ordering", () => {
    const digestForward = computeObservationSetDigest([obs1, obs2]);
    const digestReverse = computeObservationSetDigest([obs2, obs1]);

    expect(digestForward).toBe(digestReverse);
    expect(digestForward.startsWith("sha256:")).toBe(true);
  });

  it("produces different digest when observation content changes", () => {
    const obs2Modified: PersistedObservation = {
      ...obs2,
      summary: "Different summary text",
    };

    const digestOrig = computeObservationSetDigest([obs1, obs2]);
    const digestMod = computeObservationSetDigest([obs1, obs2Modified]);

    expect(digestOrig).not.toBe(digestMod);
  });

  it("rejects empty observation sets", () => {
    expect(() => computeObservationSetDigest([])).toThrow();
  });
});
