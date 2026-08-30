export type LearningState = Readonly<{
  skillKey: string;
  confidence: number;
  totalReward: number;
  sampleCount: number;
  updatedAt: string;
}>;
