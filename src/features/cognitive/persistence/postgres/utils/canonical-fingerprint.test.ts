import { describe, expect, it } from "vitest";

import {
  canonicalJsonStringify,
  computeCanonicalFingerprint,
} from "./canonical-fingerprint";

describe("canonical JSON stringification and fingerprinting", () => {
  it("ignores object key ordering when computing fingerprints", () => {
    const objA = { z: 1, a: "hello", m: { nestedB: 2, nestedA: 1 } };
    const objB = { a: "hello", m: { nestedA: 1, nestedB: 2 }, z: 1 };

    expect(canonicalJsonStringify(objA)).toBe(canonicalJsonStringify(objB));
    expect(computeCanonicalFingerprint(objA)).toBe(
      computeCanonicalFingerprint(objB),
    );
  });

  it("preserves array ordering", () => {
    const arrA = [1, 2, 3];
    const arrB = [3, 2, 1];

    expect(canonicalJsonStringify(arrA)).not.toBe(canonicalJsonStringify(arrB));
    expect(computeCanonicalFingerprint(arrA)).not.toBe(
      computeCanonicalFingerprint(arrB),
    );
  });

  it("serializes null, boolean, string, and finite numbers deterministically", () => {
    expect(canonicalJsonStringify(null)).toBe("null");
    expect(canonicalJsonStringify(true)).toBe("true");
    expect(canonicalJsonStringify(false)).toBe("false");
    expect(canonicalJsonStringify(42.5)).toBe("42.5");
    expect(canonicalJsonStringify("hello")).toBe('"hello"');
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined,
    () => "invalid",
    Symbol("invalid"),
    BigInt(10),
  ])("rejects non-finite number or unsupported type %s", (unsupported) => {
    expect(() => canonicalJsonStringify(unsupported)).toThrow();
  });

  it("rejects object containing unsupported property value", () => {
    expect(() =>
      canonicalJsonStringify({
        valid: "yes",
        invalid: () => "not allowed",
      }),
    ).toThrow();
  });
});
