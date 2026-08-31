import { describe, expect, it } from "vitest";

import { calculateLearningConfidence } from "./learning-repository";

describe("learning projection algorithm unit tests", () => {
  it("defaults to 0.5000 when sample count is 0", () => {
    expect(calculateLearningConfidence(0, 0)).toBe(0.5);
    expect(calculateLearningConfidence(100, 0)).toBe(0.5);
  });

  it("produces strictly bounded confidence in [0.0001, 0.9999]", () => {
    expect(calculateLearningConfidence(10_000, 100)).toBeLessThanOrEqual(0.9999);
    expect(calculateLearningConfidence(10_000, 100)).toBeGreaterThanOrEqual(0.0001);

    expect(calculateLearningConfidence(-10_000, 100)).toBeLessThanOrEqual(0.9999);
    expect(calculateLearningConfidence(-10_000, 100)).toBeGreaterThanOrEqual(0.0001);
  });

  it("increases confidence for positive rewards", () => {
    const c0 = calculateLearningConfidence(0, 1);
    const cSuccess1 = calculateLearningConfidence(5, 1);
    const cSuccess2 = calculateLearningConfidence(10, 2);
    const cPerfect = calculateLearningConfidence(20, 2);

    expect(cSuccess1).toBeGreaterThan(c0);
    expect(cSuccess2).toBeGreaterThan(cSuccess1);
    expect(cPerfect).toBeGreaterThan(cSuccess2);
  });

  it("decreases confidence for negative rewards", () => {
    const c0 = calculateLearningConfidence(0, 1);
    const cCorrection = calculateLearningConfidence(-3, 1);
    const cFailure = calculateLearningConfidence(-10, 1);
    const cHallucination = calculateLearningConfidence(-20, 1);
    const cUnsafe = calculateLearningConfidence(-100, 1);

    expect(cCorrection).toBeLessThan(c0);
    expect(cFailure).toBeLessThan(cCorrection);
    expect(cHallucination).toBeLessThan(cFailure);
    expect(cUnsafe).toBeLessThan(cHallucination);
    expect(cUnsafe).toBeLessThan(0.01); // Strong negative penalty
  });
});
