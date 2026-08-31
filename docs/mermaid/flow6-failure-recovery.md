# Flow 6 — Failure and Recovery

Failures do not automatically repeat external work. The recovery path checks persisted execution and operation state before deciding what is safe.

```mermaid
flowchart TD
    FAILURE(["Grounding, policy, dispatch,<br/>observation, or verification failure"])
    FAILURE --> AUDIT["Persist failure audit"]
    AUDIT --> INSPECT["Inspect session, execution,<br/>operation, and retry state"]
    INSPECT --> EFFECT{"Could an external effect<br/>have happened?"}
    EFFECT -->|Unknown or possible| RECON(["RECONCILIATION_REQUIRED"])
    EFFECT -->|No| RETRIES{"Retries remaining?"}
    RETRIES -->|Yes| COOL["Persist cooldown deadline"]
    COOL --> COOLDOWN(["COOLDOWN boundary"])
    COOLDOWN --> TIME{"Cooldown elapsed?"}
    TIME -->|No| COOLDOWN
    TIME -->|Yes| FRESH["Increment evaluation generation<br/>and rebuild fresh context"]
    FRESH --> RETRY(["RETRY_REQUIRED then resume loop"])
    RETRIES -->|No| REVIEW{"Human can resolve?"}
    REVIEW -->|Yes| HUMAN(["HUMAN_REVIEW_REQUIRED"])
    REVIEW -->|No| BLOCKED(["BLOCKED or FAILED"])
```

## Boundary meanings

```mermaid
flowchart LR
    BOUNDARY{"Returned boundary"}
    BOUNDARY --> COMPLETE["COMPLETED<br/>verified cycle finished"]
    BOUNDARY --> NONE["NO_ACTION<br/>nothing safe/useful to do"]
    BOUNDARY --> HUMAN["HUMAN_REVIEW_REQUIRED<br/>decision needs a person"]
    BOUNDARY --> COOL["COOLDOWN / RETRY_REQUIRED<br/>controlled retry path"]
    BOUNDARY --> RECON["RECONCILIATION_REQUIRED<br/>external outcome uncertain"]
    BOUNDARY --> STOP["BLOCKED / FAILED<br/>cannot continue safely"]
```
