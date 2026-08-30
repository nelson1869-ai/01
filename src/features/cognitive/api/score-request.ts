import { z } from "zod";

export const scoreCandidateRequestSchema = z.object({
  id: z.string().min(1),
  cueId: z.string().min(1),
  goal: z.string().min(1),
  action: z.string().min(1),

  confidence: z.number().min(0).max(1),
  expectedUtility: z.number().min(0).max(1),
  estimatedRisk: z.number().min(0).max(1),
  estimatedCost: z.number().min(0).max(1),

  evidence: z.array(z.string()),
});
