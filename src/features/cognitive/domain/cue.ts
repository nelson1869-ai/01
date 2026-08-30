export type CueType =
  | "email.received"
  | "calendar.upcoming"
  | "file.created"
  | "github.issue.created"
  | "browser.event"
  | "schedule"
  | "task.completed"
  | "user.action";

export type Cue = Readonly<{
  id: string;
  type: CueType;
  source: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}>;
