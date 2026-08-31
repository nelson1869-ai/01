# AutoDo AI — Postman Testing Guide (Milestone 8)

This directory contains the official Postman Collection and Environment for testing the **AutoDo AI Control Plane & Server APIs** (Milestone 8).

---

## 1. Files Included

- [`AutoDo-AI.postman_collection.json`](./AutoDo-AI.postman_collection.json) (Collection v2.1 containing all M8.1–M8.7 folders)
- [`AutoDo-Local.postman_environment.json`](./AutoDo-Local.postman_environment.json) (Local environment with safe variables)

---

## 2. Quick Start Setup (1 Minute)

1. Open **Postman** (Desktop App or VS Code Extension).
2. Click **Import** at the top-left of Postman.
3. Select both files:
   - `postman/AutoDo-AI.postman_collection.json`
   - `postman/AutoDo-Local.postman_environment.json`
4. In the **top-right environment selector** dropdown, select **`AutoDo Local`**.
5. Ensure your AutoDo Next.js server is running (`npm run dev` at `http://localhost:3000`).

---

## 3. Recommended Complete Execution Flow

Execute the requests in order:

### Folder: `M8.1 Cue & Sessions`
1. **`Create Cue`** (`POST /api/cognitive/cues`)
   - Returns `201 Created` with a new `cueId` and `sessionId`.
   - *Test script automatically sets `{{cueId}}` and `{{sessionId}}` in your Postman environment.*
2. **`Get Cue`** (`GET /api/cognitive/cues/{{cueId}}`)
   - Retrieves the durable cue record.
3. **`Get Session`** (`GET /api/cognitive/sessions/{{sessionId}}`)
   - Verifies the session state is initialized in phase `CUE`.

### Folder: `M8.2 Run Cognitive Cycle`
4. **`Run Session`** (`POST /api/cognitive/sessions/{{sessionId}}/run`)
   - Body: `{"taskProfile": "github-readonly-v1"}`
   - Drives the autonomous cognitive cycle until boundary (e.g. `COMPLETED` or `IDLE`).
   - *Test script automatically captures `{{executionId}}` and `{{verificationId}}` into your environment.*

### Folder: `M8.3 Execution & Verification`
5. **`Get Execution`** (`GET /api/cognitive/executions/{{executionId}}`)
   - Retrieves the finalized execution record.
6. **`Get Observations`** (`GET /api/cognitive/executions/{{executionId}}/observations`)
   - Retrieves the factual GitHub read observation recorded during execution.
7. **`Get Verification`** (`GET /api/cognitive/executions/{{executionId}}/verification`)
   - Retrieves the result verification record.

### Folder: `M8.4 Learning & Memory`
8. **`Get Rewards`** (`GET /api/cognitive/executions/{{executionId}}/rewards`)
   - Inspects the append-only reward events (e.g., `SUCCESS` +5).
9. **`Get Learning`** (`GET /api/cognitive/learning/{{skillKey}}`)
   - Inspects the updated learning projection and confidence score.
10. **`Get Verified Memory`** (`GET /api/cognitive/memory/{{memoryKind}}/{{memoryKey}}`)
    - Inspects verified memory head state.

### Folder: `M8.5 Human Review & Providers`
11. **`Get Human Review`** (`GET /api/cognitive/sessions/{{sessionId}}/human-review`)
    - Inspects human review requirement status.
12. **`Get Provider Health`** (`GET /api/cognitive/providers/health`)
    - Reports provider configuration health without exposing credentials.

### Folder: `M8.7 Conversational Assistant`
13. **`New Conversation`** (`POST /api/assistant/chat`)
    - Starts a conversation and saves `{{conversationId}}`.
14. **`Continue Conversation`** (`POST /api/assistant/chat`)
    - Reuses bounded durable context.
15. **`Tool-backed Question`** (`POST /api/assistant/chat`)
    - Requires a verified GitHub read before presenting provider facts.
16. **`Safety Test`** (`POST /api/assistant/chat`)
    - Confirms repository deletion is denied without an execution.
