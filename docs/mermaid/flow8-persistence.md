# Flow 8 — Persistence

PostgreSQL is the durable ledger for the cognitive engine. Drizzle schemas define records by responsibility, while repositories and transactions isolate database access from orchestration.

```mermaid
flowchart TD
    API["Route handlers and API services"] --> TX["Atomic transactions"]
    ENGINE["Cognitive orchestrators"] --> REPO["Repositories"]
    TX --> REPO
    REPO --> SCHEMA["Drizzle schema modules"]
    SCHEMA --> DB[("PostgreSQL")]

    subgraph RECORDS["Durable record groups"]
        INGRESS["Ingress<br/>cues and sessions"]
        COG["Cognition<br/>perception and context"]
        DECISION["Decisions<br/>candidates, evidence, grounding, policy"]
        PLANNING["Planning<br/>plans and steps"]
        EXECUTION["Execution<br/>executions, operations, attempts, observations"]
        SAFETY["Safety<br/>authorization and recovery state"]
        AUDIT["Audit<br/>verification and failure history"]
        LEARNING["Learning<br/>rewards, skills, and verified memory"]
        ASSISTANT["Assistant<br/>conversations and turns"]
        IDEMP["Idempotency<br/>stable request identity"]
    end

    DB --- INGRESS
    DB --- COG
    DB --- DECISION
    DB --- PLANNING
    DB --- EXECUTION
    DB --- SAFETY
    DB --- AUDIT
    DB --- LEARNING
    DB --- ASSISTANT
    DB --- IDEMP
```

## State consistency

```mermaid
flowchart LR
    LOAD["Load authoritative session"] --> VERSION["Check row version"]
    VERSION --> TRANSITION["Perform one valid phase transition"]
    TRANSITION --> ATOMIC["Commit related records atomically"]
    ATOMIC --> NEXT["Reload or advance next phase"]
    VERSION -->|Concurrent change| CONFLICT["Reject stale transition safely"]
```

Schema files live in `src/features/cognitive/persistence/postgres/schema`, migrations live in `drizzle`, and database documentation lives in `docs/database`.
