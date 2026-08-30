export type MemoryKind = "FACT" | "POLICY" | "SKILL" | "PROCEDURE";

export type VerifiedMemory = Readonly<{
  id: string;
  kind: MemoryKind;
  key: string;
  content: Readonly<Record<string, unknown>>;
  sourceIds: readonly string[];
  confidence: number;
  verifiedAt: string;
  createdAt: string;
}>;
