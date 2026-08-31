import { describe, expect, it } from "vitest";

import type { CognitivePhase } from "@/features/cognitive/domain/types";
import { PHASE_INDEX, PHASE_LESSONS } from "./learning-console-data";

const ALL_PHASES: readonly CognitivePhase[] = [
  "CUE",
  "PERCEIVE",
  "BUILD_CONTEXT",
  "RETRIEVE_MEMORY",
  "GENERATE_CANDIDATES",
  "SCORE",
  "GROUND_VERIFY",
  "POLICY_SAFETY",
  "PLAN",
  "DURABLE_EXECUTION",
  "ACT",
  "OBSERVE",
  "VERIFY_RESULT",
  "REWARD",
  "LEARN",
  "SAVE_MEMORY",
  "CLEAR_WORKING_MEMORY",
  "COOLDOWN",
  "HUMAN_REVIEW",
  "IDLE",
];

describe("learning console phase map", () => {
  it("teaches every server phase exactly once and in runtime order", () => {
    expect(PHASE_LESSONS.map((lesson) => lesson.phase)).toEqual(ALL_PHASES);
    expect(new Set(PHASE_LESSONS.map((lesson) => lesson.phase)).size).toBe(
      ALL_PHASES.length,
    );
  });

  it("provides inspectable learning metadata for every phase", () => {
    for (const [index, lesson] of PHASE_LESSONS.entries()) {
      expect(PHASE_INDEX.get(lesson.phase)).toBe(index);
      expect(lesson.purpose.length).toBeGreaterThan(20);
      expect(lesson.input.length).toBeGreaterThan(10);
      expect(lesson.output.length).toBeGreaterThan(10);
      expect(lesson.source).toMatch(/\.ts$/);
      expect(lesson.persistence.length).toBeGreaterThan(5);
    }
  });
});
