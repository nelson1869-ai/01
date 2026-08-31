# Flow 1 — Project Overview

This is the best starting point. AutoDo AI is a Next.js App Router application with a React UI, route-handler APIs, a durable cognitive engine, external providers, and PostgreSQL persistence.

```mermaid
flowchart TD
    USER(["User or external system"])

    subgraph NEXT["Next.js application"]
        UI["React UI<br/>src/app/page.tsx"]
        API["Route handlers<br/>src/app/api"]
    end

    subgraph ENGINE["Cognitive feature"]
        SERVICE["API services and runtime composition"]
        LOOP["Durable cognitive loop"]
        DOMAIN["Domain rules<br/>score, safety, reward, memory"]
        ORCH["Orchestrators<br/>plan, execute, verify, recover"]
    end

    subgraph OUTSIDE["External systems"]
        AI["Gemini or Ollama"]
        GITHUB["GitHub read-only API"]
        DB[("PostgreSQL")]
    end

    USER --> UI
    USER --> API
    UI --> API
    API --> SERVICE
    SERVICE --> LOOP
    LOOP --> DOMAIN
    LOOP --> ORCH
    ORCH --> AI
    ORCH --> GITHUB
    SERVICE --> DB
    LOOP --> DB
    ORCH --> DB
    API --> USER
```

## Main idea

```mermaid
flowchart LR
    NOTICE["Notice something"] --> THINK["Evaluate possible action"]
    THINK --> PROVE["Ground and authorize it"]
    PROVE --> ACT["Perform allowed operation"]
    ACT --> CHECK["Observe and verify result"]
    CHECK --> LEARN["Reward, learn, and save memory"]
```

The AI can propose or interpret work, but domain policy, grounding, authorization, durable state, and result verification control whether that work proceeds.
