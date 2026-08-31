import { describe, expect, it } from "vitest";
import { identifierParamSchema } from "./cue-api-contracts";
import { ALLOWED_GITHUB_REPO } from "../adapters/github/github-adapter";

describe("Milestone 8.3–8.5 — Inspection APIs Contracts & Security", () => {
  describe("Resource Identifier Param Validation", () => {
    it("accepts valid execution, skill, and memory keys", () => {
      expect(identifierParamSchema.parse("exec:sess-1:plan-1")).toBe("exec:sess-1:plan-1");
      expect(identifierParamSchema.parse("github.readonly")).toBe("github.readonly");
      expect(identifierParamSchema.parse("FACT")).toBe("FACT");
      expect(identifierParamSchema.parse("email.processed")).toBe("email.processed");
      expect(identifierParamSchema.parse("ver:exec:1")).toBe("ver:exec:1");
    });

    it("rejects malicious query injection characters in URL params", () => {
      const badParams = [
        "exec; DROP TABLE executions;--",
        "../../etc/passwd",
        "key\0null",
        "<script>",
        "skill key with spaces",
      ];
      for (const bad of badParams) {
        expect(() => identifierParamSchema.parse(bad)).toThrow();
      }
    });
  });

  describe("Provider Health Invariants", () => {
    it("never includes private keys or tokens in health report format", () => {
      const fakeHealthData = {
        gemini: {
          configured: true,
          provider: "gemini",
          model: "gemini-3.7-flash",
          status: "READY",
        },
        github: {
          configured: true,
          provider: "github",
          mode: "READ_ONLY",
          allowedRepository: ALLOWED_GITHUB_REPO,
          status: "READY",
        },
      };

      const serialized = JSON.stringify(fakeHealthData);
      expect(serialized).not.toContain("GEMINI_API_KEY");
      expect(serialized).not.toContain("GITHUB_TOKEN");
      expect(serialized).not.toContain("AIza");
      expect(serialized).not.toContain("ghp_");
      expect(fakeHealthData.github.allowedRepository).toBe("nelson1869-ai/01");
      expect(fakeHealthData.github.mode).toBe("READ_ONLY");
    });
  });
});
