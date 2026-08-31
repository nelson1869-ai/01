# Flow 3 — Cue Ingestion

A cue is the durable starting point for cognitive work. Ingestion creates the cue and its session together and protects retries with an idempotency identity.

```mermaid
flowchart TD
    EVENT(["External event or assistant tool intent"])
    EVENT --> REQUEST["POST /api/cognitive/cues<br/>or assistant tool runner"]
    REQUEST --> VALIDATE["Validate source, type, payload,<br/>timestamps, and max retries"]
    VALIDATE --> KEY["Resolve external event ID<br/>or Idempotency-Key"]
    KEY --> TX["Begin ingestCue transaction"]
    TX --> EXISTS{"Already ingested?"}
    EXISTS -->|Yes| REPLAY["Return existing cue and session<br/>HTTP 200 for API replay"]
    EXISTS -->|No| SAVE_CUE["Insert cue"]
    SAVE_CUE --> SESSION["Create cognitive session<br/>initial phase: CUE"]
    SESSION --> COMMIT["Commit atomically"]
    COMMIT --> CREATED["Return cue and session<br/>HTTP 201 for API creation"]
```

## Why it is durable

```mermaid
flowchart LR
    IDENTITY["Stable event identity"] --> IDEMPOTENCY["Duplicate detection"]
    IDEMPOTENCY --> ATOMIC["Cue and session transaction"]
    ATOMIC --> SESSION["Persisted phase and retry state"]
    SESSION --> RESUME["Safe resume after interruption"]
```
