# AutoDo AI

Production-grade autonomous AI SaaS platform engineered for deterministic grounding, policy-bound planning, durable execution, and self-verifying feedback loops.

---

## 🏗️ Architecture Baseline

- **Runtime:** Node.js 24 LTS
- **Framework:** Next.js 16 (Active LTS, App Router)
- **UI Library:** React 19 (Server Components by default)
- **Compiler:** React Compiler enabled (`next.config.ts`)
- **Styling:** Tailwind CSS v4
- **Language:** Strict TypeScript 5+ (`@/*` alias)
- **Linter:** ESLint 9 + `eslint-config-next`
- **Bundler:** Turbopack

---

## 🧠 Cognitive Engine Workflow

```text
CUE
→ PERCEIVE
→ BUILD CONTEXT
→ RETRIEVE MEMORY
→ GENERATE CANDIDATE ACTIONS
→ SCORE
→ GROUND / VERIFY
→ POLICY + SAFETY
→ PLAN
→ DURABLE EXECUTION
→ ACT
→ OBSERVE
→ VERIFY RESULT
→ REWARD
→ LEARN
→ SAVE VERIFIED MEMORY
→ CLEAR TEMPORARY WORKING MEMORY
→ IDLE
```
