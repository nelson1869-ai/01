# Flow 4 — Cognitive Loop

The driver advances exactly one persisted phase at a time. `runCognitiveCycleUntilBoundary` repeatedly calls that transition until it reaches a result that must be returned to the caller.

```mermaid
flowchart TD
    START(["Persisted session in CUE phase"])
    START --> PERCEIVE["1. PERCEIVE<br/>create authoritative perception snapshot"]
    PERCEIVE --> CONTEXT["2. BUILD_CONTEXT<br/>assemble cue and perceived facts"]
    CONTEXT --> MEMORY["3. RETRIEVE_MEMORY<br/>load verified relevant memory"]
    MEMORY --> GENERATE["4. GENERATE_CANDIDATES<br/>propose possible actions"]
    GENERATE --> ANY{"Any valid candidates?"}
    ANY -->|No| NO_ACTION(["NO_ACTION"])
    ANY -->|Yes| SCORE["5. SCORE<br/>rank confidence, utility, risk, cost"]
    SCORE --> RANK{"Top candidate outcome"}
    RANK -->|Ignore| NO_ACTION
    RANK -->|Ask human| HUMAN(["HUMAN_REVIEW_REQUIRED"])
    RANK -->|Auto candidate| GROUND["6. GROUND_VERIFY<br/>require real evidence"]
    GROUND --> GROUNDED{"Evidence sufficient?"}
    GROUNDED -->|No| FAILURE["Failure recovery path"]
    GROUNDED -->|Yes| POLICY["7. POLICY_SAFETY<br/>evaluate permission and safety"]
    POLICY --> POLICY_RESULT{"Policy decision"}
    POLICY_RESULT -->|Deny| BLOCKED(["BLOCKED"])
    POLICY_RESULT -->|Require approval| HUMAN
    POLICY_RESULT -->|Allow| PLAN["8. PLAN<br/>persist an action plan"]
    PLAN --> EXEC["9. DURABLE_EXECUTION<br/>authorize and reserve operation"]
    EXEC --> ACT["10. ACT<br/>dispatch through adapter"]
    ACT --> OBSERVE["11. OBSERVE<br/>persist bounded result evidence"]
    OBSERVE --> VERIFY["12. VERIFY_RESULT<br/>check expected vs observed"]
    VERIFY --> REWARD["13. REWARD<br/>record outcome value"]
    REWARD --> LEARN["14. LEARN<br/>update skill statistics"]
    LEARN --> SAVE["15. SAVE_MEMORY<br/>admit verified memory only"]
    SAVE --> CLEAR["16. CLEAR_WORKING_MEMORY"]
    CLEAR --> IDLE(["COMPLETED and IDLE"])
```

## Core safety rule

```mermaid
flowchart LR
    HIGH["High candidate score"] --> CANDIDATE["Good candidate"]
    CANDIDATE -. "does not mean" .-> PERMISSION["Permission to execute"]
    CANDIDATE --> GROUND["Grounding"] --> POLICY["Policy and safety"] --> AUTH["Runtime authorization"] --> PERMISSION
```
