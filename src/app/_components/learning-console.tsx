"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { DashboardSnapshot } from "@/features/cognitive/api/dashboard-contracts";
import type { CognitivePhase } from "@/features/cognitive/domain/types";
import {
  ArrowIcon,
  ChatIcon,
  CheckIcon,
  ClockIcon,
  CloseIcon,
  DatabaseIcon,
  FlowIcon,
  InspectIcon,
  KnowledgeIcon,
  MenuIcon,
  OverviewIcon,
  RefreshIcon,
  SendIcon,
  ServerIcon,
  ShieldIcon,
  SparkIcon,
} from "./console-icons";
import { PHASE_INDEX, PHASE_LESSONS } from "./learning-console-data";

type View = "overview" | "flow" | "assistant" | "inspect" | "knowledge";
type LiveStatus = "connecting" | "live" | "unavailable";

interface ProviderHealth {
  readonly engine?: { readonly status?: string; readonly type?: string };
  readonly ollama?: { readonly status?: string; readonly model?: string };
  readonly gemini?: { readonly status?: string; readonly models?: readonly string[] };
  readonly github?: {
    readonly status?: string;
    readonly mode?: string;
    readonly allowedRepository?: string;
  };
}

interface ProgressEvent {
  readonly sequence: number;
  readonly stage: string;
  readonly message: string;
  readonly provider?: string;
  readonly model?: string;
  readonly fallback?: boolean;
}

interface AssistantResponse {
  readonly conversationId: string;
  readonly message: string;
  readonly status: string;
  readonly providerStatus: string | null;
  readonly modelSelection: {
    readonly provider: string;
    readonly model: string;
    readonly fallbackUsed: boolean;
    readonly taskClass: string;
    readonly reasonCode: string;
  };
  readonly sessionId: string | null;
  readonly executionId: string | null;
  readonly verification: string;
  readonly decisionSummary: readonly string[];
  readonly telemetry: {
    readonly totalDurationMs: number;
    readonly ai: readonly unknown[];
  };
}

interface ChatMessage {
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly text: string;
  readonly response?: AssistantResponse;
}

interface InspectionState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly session: unknown | null;
  readonly review: unknown | null;
  readonly execution: unknown | null;
  readonly observations: unknown | null;
  readonly verification: unknown | null;
  readonly rewards: unknown | null;
}

const EMPTY_INSPECTION: InspectionState = {
  loading: false,
  error: null,
  session: null,
  review: null,
  execution: null,
  observations: null,
  verification: null,
  rewards: null,
};

const NAV_ITEMS: readonly {
  view: View;
  label: string;
  caption: string;
  icon: typeof OverviewIcon;
}[] = [
  { view: "overview", label: "Overview", caption: "System pulse", icon: OverviewIcon },
  { view: "flow", label: "Cognitive flow", caption: "20 live phases", icon: FlowIcon },
  { view: "assistant", label: "Assistant", caption: "Learn by asking", icon: ChatIcon },
  { view: "inspect", label: "Inspector", caption: "Trace durable facts", icon: InspectIcon },
  { view: "knowledge", label: "Learning", caption: "Memory & rewards", icon: KnowledgeIcon },
];

const STARTER_PROMPTS = [
  "What can AutoDo do?",
  "Read README.md from the allowed repository",
  "List the open GitHub issues",
] as const;

function joinClass(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function formatRelative(timestamp?: string | null): string {
  if (!timestamp) return "—";
  const seconds = Math.round((Date.now() - Date.parse(timestamp)) / 1000);
  if (Math.abs(seconds) < 10) return "just now";
  if (Math.abs(seconds) < 60) return `${Math.abs(seconds)}s ago`;
  const minutes = Math.round(Math.abs(seconds) / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function formatDate(timestamp?: string | null): string {
  if (!timestamp) return "Not recorded";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function statusTone(status?: string | null): "good" | "warn" | "bad" | "neutral" {
  if (!status) return "neutral";
  if (["READY", "CONFIGURED", "COMPLETED", "SUCCEEDED", "VERIFIED", "IDLE"].includes(status)) return "good";
  if (["COOLDOWN", "HUMAN_REVIEW", "INCONCLUSIVE", "PROCESSING", "RUNNING", "NOT_PROBED"].includes(status)) return "warn";
  if (["FAILED", "BLOCKED", "DENIED", "UNCONFIGURED", "RECONCILIATION_REQUIRED"].includes(status)) return "bad";
  return "neutral";
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { data?: T; error?: { message?: string } };
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? `Request failed with HTTP ${response.status}.`);
  }
  if (payload.data === undefined) throw new Error("The server returned no data.");
  return payload.data;
}

function Badge({ value }: { readonly value: string }) {
  const tone = statusTone(value);
  return <span className={`status-badge status-${tone}`}><i />{value.replaceAll("_", " ")}</span>;
}

function EmptyState({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className="empty-state">
      <DatabaseIcon className="empty-icon" />
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly detail: string;
  readonly tone: "teal" | "violet" | "amber" | "blue";
}) {
  return (
    <article className={`metric-card metric-${tone}`}>
      <div className="metric-top"><span>{label}</span><i /></div>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

function SectionHeading({
  eyebrow,
  title,
  body,
  action,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <header className="section-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
      {action ? <div className="section-action">{action}</div> : null}
    </header>
  );
}

export default function LearningConsole({
  initialSnapshot,
}: {
  readonly initialSnapshot: DashboardSnapshot | null;
}) {
  const [view, setView] = useState<View>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(initialSnapshot);
  const [liveStatus, setLiveStatus] = useState<LiveStatus>("connecting");
  const [providers, setProviders] = useState<ProviderHealth | null>(null);
  const [selectedPhase, setSelectedPhase] = useState<CognitivePhase>(
    initialSnapshot?.sessions[0]?.phase ?? "CUE",
  );
  const [sessionId, setSessionId] = useState(initialSnapshot?.sessions[0]?.sessionId ?? "");
  const [executionId, setExecutionId] = useState(initialSnapshot?.executions[0]?.executionId ?? "");
  const [inspection, setInspection] = useState<InspectionState>(EMPTY_INSPECTION);
  const [messages, setMessages] = useState<readonly ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Ask me about AutoDo or request a safe GitHub read. I’ll show each server stage as it happens, then link the result to its durable session.",
    },
  ]);
  const [prompt, setPrompt] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [progress, setProgress] = useState<readonly ProgressEvent[]>([]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const latestSession = dashboard?.sessions[0] ?? null;
  const activeSessions = dashboard?.sessions.filter((session) => session.phase !== "IDLE").length ?? 0;
  const reviewCount = dashboard?.sessions.filter((session) => session.phase === "HUMAN_REVIEW").length ?? 0;
  const verifiedCount = dashboard?.verifications.filter((item) => item.status === "VERIFIED").length ?? 0;
  const verificationRate = dashboard?.verifications.length
    ? Math.round((verifiedCount / dashboard.verifications.length) * 100)
    : 0;

  useEffect(() => {
    const stream = new EventSource("/api/cognitive/live");
    const onSnapshot = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as DashboardSnapshot;
        setDashboard(next);
        setLiveStatus("live");
      } catch {
        setLiveStatus("unavailable");
      }
    };
    const onUnavailable = () => setLiveStatus("unavailable");
    stream.addEventListener("snapshot", onSnapshot as EventListener);
    stream.addEventListener("unavailable", onUnavailable);
    stream.onerror = () => setLiveStatus("connecting");
    return () => stream.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch("/api/cognitive/providers/health", { cache: "no-store" });
        const data = await readEnvelope<ProviderHealth>(response);
        if (!cancelled) setProviders(data);
      } catch {
        if (!cancelled) setProviders(null);
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, progress]);

  useEffect(() => {
    if (view !== "inspect" || (!sessionId.trim() && !executionId.trim())) return;
    const abort = new AbortController();
    const load = async () => {
      setInspection((current) => ({ ...current, loading: true, error: null }));
      try {
        const sessionRequests = sessionId.trim()
          ? [
              fetch(`/api/cognitive/sessions/${encodeURIComponent(sessionId.trim())}`, { signal: abort.signal }),
              fetch(`/api/cognitive/sessions/${encodeURIComponent(sessionId.trim())}/human-review`, { signal: abort.signal }),
            ]
          : [];
        const executionRequests = executionId.trim()
          ? [
              fetch(`/api/cognitive/executions/${encodeURIComponent(executionId.trim())}`, { signal: abort.signal }),
              fetch(`/api/cognitive/executions/${encodeURIComponent(executionId.trim())}/observations`, { signal: abort.signal }),
              fetch(`/api/cognitive/executions/${encodeURIComponent(executionId.trim())}/verification`, { signal: abort.signal }),
              fetch(`/api/cognitive/executions/${encodeURIComponent(executionId.trim())}/rewards`, { signal: abort.signal }),
            ]
          : [];
        const responses = await Promise.all([...sessionRequests, ...executionRequests]);
        const values = await Promise.all(
          responses.map(async (response) => {
            if (response.status === 404) return null;
            return readEnvelope<unknown>(response);
          }),
        );
        let offset = 0;
        const session = sessionRequests.length ? values[offset++] : null;
        const review = sessionRequests.length ? values[offset++] : null;
        const execution = executionRequests.length ? values[offset++] : null;
        const observations = executionRequests.length ? values[offset++] : null;
        const verification = executionRequests.length ? values[offset++] : null;
        const rewards = executionRequests.length ? values[offset++] : null;
        setInspection({ loading: false, error: null, session, review, execution, observations, verification, rewards });
      } catch (error) {
        if (!abort.signal.aborted) {
          setInspection((current) => ({
            ...current,
            loading: false,
            error: error instanceof Error ? error.message : "Inspection failed.",
          }));
        }
      }
    };
    void load();
    return () => abort.abort();
  }, [view, sessionId, executionId]);

  const activity = useMemo(() => {
    const sessions = (dashboard?.sessions ?? []).map((item) => ({
      id: item.sessionId,
      kind: "Session",
      title: item.cueType,
      detail: item.phase,
      timestamp: item.updatedAt,
      sessionId: item.sessionId,
      executionId: item.currentExecutionId,
    }));
    const executions = (dashboard?.executions ?? []).map((item) => ({
      id: item.executionId,
      kind: "Execution",
      title: item.executionId,
      detail: item.status,
      timestamp: item.updatedAt,
      sessionId: item.sessionId,
      executionId: item.executionId,
    }));
    return [...sessions, ...executions]
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 8);
  }, [dashboard]);

  const navigate = (next: View) => {
    setView(next);
    setMobileNavOpen(false);
  };

  const openInspector = (nextSessionId?: string | null, nextExecutionId?: string | null) => {
    if (nextSessionId) setSessionId(nextSessionId);
    if (nextExecutionId) setExecutionId(nextExecutionId);
    navigate("inspect");
  };

  const submitAssistant = async (event: FormEvent) => {
    event.preventDefault();
    const message = prompt.trim();
    if (!message || chatBusy) return;
    setPrompt("");
    setChatError(null);
    setProgress([]);
    setChatBusy(true);
    setMessages((current) => [
      ...current,
      { id: `user-${crypto.randomUUID()}`, role: "user", text: message },
    ]);

    try {
      const response = await fetch("/api/assistant/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, ...(conversationId ? { conversationId } : {}) }),
      });
      if (!response.ok || !response.body) {
        const failure = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(failure?.error?.message ?? `Assistant request failed with HTTP ${response.status}.`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResponse: AssistantResponse | null = null;

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const lines = block.split("\n");
          const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          const dataText = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!dataText) continue;
          const data = JSON.parse(dataText) as unknown;
          if (eventName === "progress") {
            const next = data as ProgressEvent;
            setProgress((current) => [...current.filter((item) => item.sequence !== next.sequence), next]);
          } else if (eventName === "final") {
            finalResponse = (data as { data: AssistantResponse }).data;
          }
        }
        if (done) break;
      }

      if (!finalResponse) throw new Error("The assistant stream closed without a final result.");
      setConversationId(finalResponse.conversationId);
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${crypto.randomUUID()}`,
          role: "assistant",
          text: finalResponse.message,
          response: finalResponse,
        },
      ]);
      if (finalResponse.sessionId) setSessionId(finalResponse.sessionId);
      if (finalResponse.executionId) setExecutionId(finalResponse.executionId);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "The assistant request failed.");
    } finally {
      setChatBusy(false);
    }
  };

  return (
    <div className="console-shell">
      <button
        className="mobile-menu-button"
        type="button"
        aria-label="Open navigation"
        onClick={() => setMobileNavOpen(true)}
      >
        <MenuIcon />
      </button>

      <aside className={joinClass("console-sidebar", mobileNavOpen && "sidebar-open")}>
        <div className="brand-row">
          <div className="brand-mark"><span /><span /><span /></div>
          <div><strong>AutoDo</strong><small>Learning console</small></div>
          <button type="button" className="sidebar-close" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}><CloseIcon /></button>
        </div>

        <div className={`live-pill live-${liveStatus}`}>
          <span className="live-dot" />
          <div><strong>{liveStatus === "live" ? "Server connected" : liveStatus === "connecting" ? "Connecting" : "Database unavailable"}</strong><small>{dashboard ? `Synced ${formatRelative(dashboard.generatedAt)}` : "Waiting for first snapshot"}</small></div>
        </div>

        <nav className="console-nav" aria-label="Learning console">
          <span className="nav-label">Workspace</span>
          {NAV_ITEMS.map((item) => {
            const NavIcon = item.icon;
            return (
              <button
                type="button"
                key={item.view}
                className={joinClass("nav-item", view === item.view && "nav-item-active")}
                onClick={() => navigate(item.view)}
              >
                <NavIcon />
                <span><strong>{item.label}</strong><small>{item.caption}</small></span>
                {item.view === "inspect" && reviewCount > 0 ? <em>{reviewCount}</em> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-lesson">
          <SparkIcon />
          <span className="eyebrow">Learning principle</span>
          <strong>A score recommends. Policy permits.</strong>
          <p>Every action still needs evidence, policy, and live authorization.</p>
          <button type="button" onClick={() => navigate("flow")}>Explore the flow <ArrowIcon /></button>
        </div>

        <footer className="sidebar-footer">
          <ShieldIcon />
          <div><strong>Read-only boundary</strong><small>{providers?.github?.allowedRepository ?? "GitHub repository locked"}</small></div>
        </footer>
      </aside>

      {mobileNavOpen ? <button type="button" aria-label="Close navigation overlay" className="sidebar-overlay" onClick={() => setMobileNavOpen(false)} /> : null}

      <main className="console-main">
        <div className="console-topbar">
          <div className="breadcrumb"><span>AutoDo AI</span><i>/</i><strong>{NAV_ITEMS.find((item) => item.view === view)?.label}</strong></div>
          <div className="topbar-right">
            <span className="mode-chip"><SparkIcon /> Learning mode</span>
            <span className="topbar-time"><ClockIcon /> {dashboard ? formatDate(dashboard.generatedAt) : "No database snapshot"}</span>
          </div>
        </div>

        <div className="view-container">
          {view === "overview" ? (
            <>
              <SectionHeading
                eyebrow="Live learning workspace"
                title="Understand the engine while it runs."
                body="Follow every durable decision from the first cue to verified memory. The interface is connected to the same server state that drives execution."
                action={<button type="button" className="primary-button" onClick={() => navigate("assistant")}><ChatIcon /> Ask AutoDo</button>}
              />

              <section className="metrics-grid" aria-label="System metrics">
                <MetricCard label="Active sessions" value={activeSessions} detail={`${dashboard?.sessions.length ?? 0} recent sessions loaded`} tone="teal" />
                <MetricCard label="Verification rate" value={`${verificationRate}%`} detail={`${verifiedCount} of ${dashboard?.verifications.length ?? 0} recent results verified`} tone="violet" />
                <MetricCard label="Human review" value={reviewCount} detail={reviewCount ? "Attention is required" : "No sessions waiting"} tone="amber" />
                <MetricCard label="Learning samples" value={dashboard?.learning.reduce((sum, item) => sum + item.sampleCount, 0) ?? 0} detail={`${dashboard?.learning.length ?? 0} tracked skills`} tone="blue" />
              </section>

              <section className="overview-grid">
                <article className="panel cycle-panel">
                  <div className="panel-heading">
                    <div><span className="eyebrow">Latest cognitive cycle</span><h2>{latestSession ? latestSession.cueType : "Waiting for a cue"}</h2></div>
                    {latestSession ? <Badge value={latestSession.phase} /> : <Badge value="NO DATA" />}
                  </div>
                  {latestSession ? (
                    <>
                      <div className="cycle-summary">
                        <div><small>Session</small><code>{latestSession.sessionId}</code></div>
                        <div><small>Source</small><strong>{latestSession.cueSource}</strong></div>
                        <div><small>Generation</small><strong>{latestSession.evaluationGeneration}</strong></div>
                      </div>
                      <div className="mini-flow">
                        {PHASE_LESSONS.filter((_, index) => [0, 1, 4, 6, 7, 9, 10, 12, 14, 19].includes(index)).map((lesson) => {
                          const currentIndex = PHASE_INDEX.get(latestSession.phase) ?? 0;
                          const lessonIndex = PHASE_INDEX.get(lesson.phase) ?? 0;
                          const state = latestSession.phase === "IDLE" || lessonIndex < currentIndex ? "complete" : lessonIndex === currentIndex ? "current" : "future";
                          return <button type="button" key={lesson.phase} className={`mini-phase mini-${state}`} onClick={() => { setSelectedPhase(lesson.phase); navigate("flow"); }}><span>{state === "complete" ? <CheckIcon /> : lessonIndex + 1}</span><small>{lesson.shortLabel}</small></button>;
                        })}
                      </div>
                      <div className="learning-callout">
                        <SparkIcon />
                        <div><span>What the server is doing</span><p>{PHASE_LESSONS[PHASE_INDEX.get(latestSession.phase) ?? 0]?.purpose}</p></div>
                      </div>
                      <button type="button" className="text-button" onClick={() => openInspector(latestSession.sessionId, latestSession.currentExecutionId)}>Inspect durable records <ArrowIcon /></button>
                    </>
                  ) : <EmptyState title="No cognitive sessions yet" body="Ask the assistant to read the repository or ingest a cue to start a live lesson." />}
                </article>

                <article className="panel system-panel">
                  <div className="panel-heading"><div><span className="eyebrow">Runtime connections</span><h2>System pulse</h2></div><ServerIcon className="panel-icon" /></div>
                  <div className="provider-list">
                    {[
                      ["Deterministic engine", providers?.engine?.status ?? "CHECKING", providers?.engine?.type ?? "Policy and execution core"],
                      ["Local Qwen", providers?.ollama?.status ?? "CHECKING", providers?.ollama?.model ?? "Intent and composition"],
                      ["Gemini", providers?.gemini?.status ?? "CHECKING", providers?.gemini?.models?.join(" · ") ?? "Fallback models"],
                      ["GitHub", providers?.github?.status ?? "CHECKING", providers?.github?.mode ?? "Read-only adapter"],
                    ].map(([name, status, detail]) => (
                      <div className="provider-row" key={name}><span className={`provider-symbol status-${statusTone(status)}`}><ServerIcon /></span><div><strong>{name}</strong><small>{detail}</small></div><Badge value={status} /></div>
                    ))}
                  </div>
                  <div className="safety-note"><ShieldIcon /><div><strong>Secrets stay server-side</strong><p>The UI receives health states and sanitized facts—never credentials or runtime authorization.</p></div></div>
                </article>
              </section>

              <section className="panel activity-panel">
                <div className="panel-heading"><div><span className="eyebrow">Durable timeline</span><h2>Recent server activity</h2></div><button type="button" className="icon-button" aria-label="Refresh dashboard" onClick={async () => { try { const response = await fetch("/api/cognitive/dashboard", { cache: "no-store" }); setDashboard(await readEnvelope<DashboardSnapshot>(response)); } catch { setLiveStatus("unavailable"); } }}><RefreshIcon /></button></div>
                {activity.length ? (
                  <div className="activity-table">
                    <div className="activity-head"><span>Artifact</span><span>Type</span><span>Status / phase</span><span>Updated</span><span /></div>
                    {activity.map((item) => (
                      <button type="button" className="activity-row" key={`${item.kind}-${item.id}`} onClick={() => openInspector(item.sessionId, item.executionId)}>
                        <span><i className={`activity-dot status-${statusTone(item.detail)}`} /><code>{item.title}</code></span><span>{item.kind}</span><span><Badge value={item.detail} /></span><span title={formatDate(item.timestamp)}>{formatRelative(item.timestamp)}</span><ArrowIcon />
                      </button>
                    ))}
                  </div>
                ) : <EmptyState title="The ledger is quiet" body="Recent sessions and executions will appear here in real time." />}
              </section>
            </>
          ) : null}

          {view === "flow" ? (
            <FlowView
              selectedPhase={selectedPhase}
              onSelect={setSelectedPhase}
              activePhase={latestSession?.phase ?? null}
              sessionId={latestSession?.sessionId ?? null}
              onInspect={() => openInspector(latestSession?.sessionId, latestSession?.currentExecutionId)}
            />
          ) : null}

          {view === "assistant" ? (
            <AssistantView
              messages={messages}
              prompt={prompt}
              setPrompt={setPrompt}
              busy={chatBusy}
              error={chatError}
              progress={progress}
              submit={submitAssistant}
              choosePrompt={setPrompt}
              openInspector={openInspector}
              chatEndRef={chatEndRef}
            />
          ) : null}

          {view === "inspect" ? (
            <InspectorView
              sessionId={sessionId}
              executionId={executionId}
              setSessionId={setSessionId}
              setExecutionId={setExecutionId}
              inspection={inspection}
              recentSessions={dashboard?.sessions ?? []}
              recentExecutions={dashboard?.executions ?? []}
            />
          ) : null}

          {view === "knowledge" ? <KnowledgeView dashboard={dashboard} /> : null}
        </div>
      </main>
    </div>
  );
}

function FlowView({
  selectedPhase,
  onSelect,
  activePhase,
  sessionId,
  onInspect,
}: {
  readonly selectedPhase: CognitivePhase;
  readonly onSelect: (phase: CognitivePhase) => void;
  readonly activePhase: CognitivePhase | null;
  readonly sessionId: string | null;
  readonly onInspect: () => void;
}) {
  const selected = PHASE_LESSONS[PHASE_INDEX.get(selectedPhase) ?? 0];
  const activeIndex = activePhase ? (PHASE_INDEX.get(activePhase) ?? -1) : -1;
  const selectedIndex = PHASE_INDEX.get(selectedPhase) ?? 0;
  const groups = ["Understand", "Decide", "Execute", "Improve"] as const;

  return (
    <>
      <SectionHeading
        eyebrow="Interactive server map"
        title="One transition at a time."
        body="Select any phase to learn its contract. When a session is active, this map follows its authoritative persisted phase."
        action={sessionId ? <button type="button" className="secondary-button" onClick={onInspect}><InspectIcon /> Inspect {sessionId.slice(0, 18)}…</button> : undefined}
      />
      <section className="flow-layout">
        <div className="panel full-flow-panel">
          <div className="flow-legend"><span><i className="legend-complete" />Completed</span><span><i className="legend-current" />Current server phase</span><span><i className="legend-future" />Not reached</span></div>
          {groups.map((group) => (
            <div className="phase-group" key={group}>
              <div className="phase-group-title"><span>{group}</span><i /></div>
              <div className="phase-grid">
                {PHASE_LESSONS.map((lesson, index) => lesson.group === group ? (
                  <button
                    type="button"
                    key={lesson.phase}
                    className={joinClass(
                      "phase-card",
                      selectedPhase === lesson.phase && "phase-selected",
                      activePhase === lesson.phase && "phase-active",
                      activePhase === "IDLE" || (activeIndex >= 0 && index < activeIndex) ? "phase-complete" : "phase-future",
                    )}
                    onClick={() => onSelect(lesson.phase)}
                  >
                    <span className="phase-number">{activePhase === "IDLE" || (activeIndex >= 0 && index < activeIndex) ? <CheckIcon /> : String(index + 1).padStart(2, "0")}</span>
                    <span><strong>{lesson.shortLabel}</strong><small>{lesson.phase}</small></span>
                    {activePhase === lesson.phase ? <em>LIVE</em> : null}
                  </button>
                ) : null)}
              </div>
            </div>
          ))}
        </div>

        <aside className="panel lesson-panel">
          <div className="lesson-index">Phase {String(selectedIndex + 1).padStart(2, "0")} / {PHASE_LESSONS.length}</div>
          <Badge value={selected.phase} />
          <h2>{selected.label}</h2>
          <p className="lesson-purpose">{selected.purpose}</p>
          <dl className="lesson-facts">
            <div><dt>Server input</dt><dd>{selected.input}</dd></div>
            <div><dt>Safe output</dt><dd>{selected.output}</dd></div>
            <div><dt>Source module</dt><dd><code>{selected.source}</code></dd></div>
            <div><dt>Durable record</dt><dd>{selected.persistence}</dd></div>
          </dl>
          <div className="lesson-rule"><ShieldIcon /><p><strong>Trust boundary</strong> Persisted data is evidence and audit history. It never recreates the private runtime permission required to dispatch an action.</p></div>
          <div className="lesson-nav">
            <button type="button" disabled={selectedIndex === 0} onClick={() => onSelect(PHASE_LESSONS[selectedIndex - 1].phase)}>Previous</button>
            <button type="button" disabled={selectedIndex === PHASE_LESSONS.length - 1} onClick={() => onSelect(PHASE_LESSONS[selectedIndex + 1].phase)}>Next <ArrowIcon /></button>
          </div>
        </aside>
      </section>
    </>
  );
}

function AssistantView({
  messages,
  prompt,
  setPrompt,
  busy,
  error,
  progress,
  submit,
  choosePrompt,
  openInspector,
  chatEndRef,
}: {
  readonly messages: readonly ChatMessage[];
  readonly prompt: string;
  readonly setPrompt: (value: string) => void;
  readonly busy: boolean;
  readonly error: string | null;
  readonly progress: readonly ProgressEvent[];
  readonly submit: (event: FormEvent) => void;
  readonly choosePrompt: (value: string) => void;
  readonly openInspector: (sessionId?: string | null, executionId?: string | null) => void;
  readonly chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <>
      <SectionHeading eyebrow="Learn by asking" title="Watch a request become a verified result." body="The assistant stream exposes safe progress events from routing through verification. Tool-backed answers link directly to their durable server records." />
      <section className="assistant-layout">
        <div className="panel chat-panel">
          <div className="chat-toolbar"><div className="assistant-avatar"><SparkIcon /></div><div><strong>AutoDo guide</strong><small><span /> Connected to the cognitive engine</small></div><Badge value={busy ? "PROCESSING" : "READY"} /></div>
          <div className="chat-scroll" aria-live="polite">
            {messages.map((message) => (
              <div key={message.id} className={`message message-${message.role}`}>
                {message.role === "assistant" ? <div className="message-avatar"><SparkIcon /></div> : null}
                <div className="message-content">
                  <span className="message-role">{message.role === "assistant" ? "AutoDo" : "You"}</span>
                  <p>{message.text}</p>
                  {message.response ? (
                    <div className="answer-receipt">
                      <div><span>Result</span><Badge value={message.response.status} /></div>
                      <div><span>Verification</span><Badge value={message.response.verification} /></div>
                      <div><span>Model route</span><strong>{message.response.modelSelection.provider} · {message.response.modelSelection.model}</strong></div>
                      <div><span>Duration</span><strong>{message.response.telemetry.totalDurationMs}ms</strong></div>
                      {message.response.decisionSummary.length ? <ul>{message.response.decisionSummary.map((item) => <li key={item}>{item}</li>)}</ul> : null}
                      {message.response.sessionId || message.response.executionId ? <button type="button" onClick={() => openInspector(message.response?.sessionId, message.response?.executionId)}>Open server receipt <ArrowIcon /></button> : null}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {busy ? <div className="message message-assistant"><div className="message-avatar"><SparkIcon /></div><div className="message-content"><span className="message-role">Live server stages</span><div className="typing-indicator"><i /><i /><i /></div></div></div> : null}
            {error ? <div className="chat-error"><ShieldIcon /><span><strong>Request stopped safely</strong>{error}</span></div> : null}
            <div ref={chatEndRef} />
          </div>
          <div className="prompt-suggestions">
            {STARTER_PROMPTS.map((item) => <button type="button" key={item} onClick={() => choosePrompt(item)} disabled={busy}>{item}</button>)}
          </div>
          <form className="composer" onSubmit={submit}>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Ask about AutoDo or request a safe GitHub read…" maxLength={8000} rows={2} />
            <div className="composer-footer"><span><ShieldIcon /> Read-only tools · verified facts</span><button type="submit" disabled={busy || !prompt.trim()} aria-label="Send message"><SendIcon /></button></div>
          </form>
        </div>

        <aside className="panel progress-panel">
          <div className="panel-heading"><div><span className="eyebrow">Server stream</span><h2>Request trace</h2></div><span className={joinClass("stream-indicator", busy && "stream-active")}><i />{busy ? "Streaming" : "Ready"}</span></div>
          {progress.length ? (
            <ol className="progress-list">
              {progress.map((item, index) => (
                <li key={item.sequence} className={index === progress.length - 1 && busy ? "progress-current" : "progress-done"}>
                  <span>{index === progress.length - 1 && busy ? <i className="progress-pulse" /> : <CheckIcon />}</span>
                  <div><strong>{item.stage.replaceAll("_", " ")}</strong><p>{item.message}</p>{item.provider ? <small>{item.provider}{item.model ? ` · ${item.model}` : ""}{item.fallback ? " · fallback" : ""}</small> : null}</div>
                </li>
              ))}
            </ol>
          ) : <EmptyState title="No active trace" body="Send a message to watch safe progress events arrive from the server." />}
          <div className="progress-explainer"><span className="eyebrow">What you can inspect</span><p>Routing, model fallback, safety checks, planning, tool execution, observation, verification, and composition.</p><small>Private chain-of-thought and credentials never leave the server.</small></div>
        </aside>
      </section>
    </>
  );
}

function InspectorView({
  sessionId,
  executionId,
  setSessionId,
  setExecutionId,
  inspection,
  recentSessions,
  recentExecutions,
}: {
  readonly sessionId: string;
  readonly executionId: string;
  readonly setSessionId: (value: string) => void;
  readonly setExecutionId: (value: string) => void;
  readonly inspection: InspectionState;
  readonly recentSessions: DashboardSnapshot["sessions"];
  readonly recentExecutions: DashboardSnapshot["executions"];
}) {
  const artifacts = [
    ["Session state", inspection.session],
    ["Human review", inspection.review],
    ["Execution", inspection.execution],
    ["Observations", inspection.observations],
    ["Verification", inspection.verification],
    ["Rewards", inspection.rewards],
  ] as const;

  return (
    <>
      <SectionHeading eyebrow="Durable fact inspector" title="Trace what the server actually stored." body="Look up a session or execution and compare its authoritative state, evidence, verification, and reward records. Missing optional records are shown as boundaries, not invented." />
      <section className="panel lookup-panel">
        <label><span>Session ID</span><input value={sessionId} onChange={(event) => setSessionId(event.target.value)} list="recent-session-ids" placeholder="sess-…" /></label>
        <label><span>Execution ID</span><input value={executionId} onChange={(event) => setExecutionId(event.target.value)} list="recent-execution-ids" placeholder="exec:…" /></label>
        <div className="lookup-status">{inspection.loading ? <><RefreshIcon className="spin" /> Loading records…</> : <><DatabaseIcon /> Updates when an ID changes</>}</div>
        <datalist id="recent-session-ids">{recentSessions.map((item) => <option value={item.sessionId} key={item.sessionId} />)}</datalist>
        <datalist id="recent-execution-ids">{recentExecutions.map((item) => <option value={item.executionId} key={item.executionId} />)}</datalist>
      </section>
      {inspection.error ? <div className="inspection-error"><ShieldIcon /><div><strong>Could not load this receipt</strong><p>{inspection.error}</p></div></div> : null}
      <section className="artifact-grid">
        {artifacts.map(([title, value]) => (
          <article className="panel artifact-card" key={title}>
            <div className="artifact-title"><div><span>{title}</span><small>{value ? "Server response" : "Not available"}</small></div>{value ? <CheckIcon /> : <i />}</div>
            {value ? <pre>{JSON.stringify(value, null, 2)}</pre> : <div className="artifact-empty">No linked record returned.</div>}
          </article>
        ))}
      </section>
    </>
  );
}

function KnowledgeView({ dashboard }: { readonly dashboard: DashboardSnapshot | null }) {
  return (
    <>
      <SectionHeading eyebrow="Verified improvement" title="Learning has receipts." body="Rewards remain an append-only source of truth. Skill confidence and long-term memory are projections admitted only after verification." />
      <section className="knowledge-grid">
        <article className="panel learning-panel">
          <div className="panel-heading"><div><span className="eyebrow">Skill projections</span><h2>Learning state</h2></div><KnowledgeIcon className="panel-icon" /></div>
          {dashboard?.learning.length ? <div className="skill-list">{dashboard.learning.map((skill) => (
            <div className="skill-row" key={skill.skillKey}>
              <div className="skill-top"><div><strong>{skill.skillKey}</strong><small>{skill.sampleCount} samples · reward {skill.totalReward.toFixed(1)}</small></div><b>{Math.round(skill.confidence * 100)}%</b></div>
              <div className="confidence-track"><i style={{ width: `${Math.round(skill.confidence * 100)}%` }} /></div>
              <span>Updated {formatRelative(skill.updatedAt)}</span>
            </div>
          ))}</div> : <EmptyState title="No learning projections yet" body="A verified execution and reward event will create the first skill projection." />}
        </article>

        <article className="panel memory-panel">
          <div className="panel-heading"><div><span className="eyebrow">Long-term knowledge</span><h2>Verified memory</h2></div><DatabaseIcon className="panel-icon" /></div>
          {dashboard?.memories.length ? <div className="memory-list">{dashboard.memories.map((memory) => (
            <div className="memory-row" key={memory.memoryId}>
              <span className="memory-kind">{memory.kind}</span>
              <div><strong>{memory.key}</strong><small>Version {memory.version} · verified {formatRelative(memory.verifiedAt)}</small></div>
              <b>{Math.round(memory.confidence * 100)}%</b>
            </div>
          ))}</div> : <EmptyState title="No verified memory yet" body="Unverified model output cannot appear here. Complete a verified tool cycle first." />}
        </article>
      </section>

      <section className="panel verification-panel">
        <div className="panel-heading"><div><span className="eyebrow">Evidence boundary</span><h2>Recent verification decisions</h2></div><ShieldIcon className="panel-icon" /></div>
        {dashboard?.verifications.length ? <div className="verification-list">{dashboard.verifications.map((item) => (
          <div className="verification-row" key={item.verificationId}><Badge value={item.status} /><div><strong>{item.reason}</strong><code>{item.executionId}</code></div><span>{Math.round(item.confidence * 100)}% confidence<small>{formatRelative(item.verifiedAt)}</small></span></div>
        ))}</div> : <EmptyState title="No verification decisions yet" body="Verifier results will stream into this view after executions produce observations." />}
      </section>
    </>
  );
}
