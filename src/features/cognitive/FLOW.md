# AutoDo AI — Cognitive Flow

This document explains the current cognitive decision flow of AutoDo AI.

The goal is to keep the cognitive system understandable, testable, auditable, and safe as it grows.

---

## Current Flow

```text
WORLD EVENT
    │
    ↓
┌───────────────┐
│      CUE      │
└───────┬───────┘
        │
        ↓
"Something happened"
        │
        ↓
┌───────────────────────┐
│   CANDIDATE ACTION    │
└───────────┬───────────┘
            │
            ↓
"What could AutoDo do?"
            │
            ↓
┌───────────────────────┐
│        SCORING        │
└───────────┬───────────┘
            │
            ├── confidence
            ├── utility
            ├── risk
            └── cost
            │
            ↓
    CandidateScore
            │
     ┌──────┼───────────┐
     ↓      ↓           ↓
  IGNORE  ASK_HUMAN  AUTO_CANDIDATE
                        │
                        ↓
                ┌───────────────┐
                │   GROUNDING   │
                └───────┬───────┘
                        │
                        ↓
                "Do we have
                 evidence?"
                        │
            ┌───────────┼──────────────┐
            ↓           ↓              ↓
        VERIFIED   INSUFFICIENT    CONFLICTING
                     EVIDENCE       EVIDENCE
            │           │              │
            ↓           └──────┬───────┘
      POLICY / SAFETY          │
            │                  ↓
            │                STOP
            │
            ↓
     ┌───────────────┐
     │ POLICY DECISION│
     └───────┬───────┘
             │
      ┌──────┼──────────────┐
      ↓      ↓              ↓
    ALLOW  REQUIRE        DENY
           APPROVAL
      │      │              │
      ↓      ↓              ↓
   CONTINUE HUMAN          STOP
            REVIEW
```

---

# Core Rule

A high score does **not** mean permission to execute.

```text
HIGH SCORE
    ↓
AUTO_CANDIDATE
    ↓
GROUNDING
    ↓
POLICY / SAFETY
    ↓
ALLOW?
```

The scoring system recommends.

The policy system decides whether the action may continue.

---

# 1. Cue

File:

```text
domain/cue.ts
```

A `Cue` represents something AutoDo notices.

Examples:

```text
email.received
calendar.upcoming
file.created
github.issue.created
browser.event
schedule
task.completed
user.action
```

Flow:

```text
WORLD
  ↓
EVENT
  ↓
CUE
```

Example:

```text
New invoice email arrives
        ↓
email.received
        ↓
Cue created
```

---

# 2. Candidate Action

File:

```text
domain/candidate-action.ts
```

A `CandidateAction` represents a possible action AutoDo could perform.

It is only a proposal.

It is not permission to execute.

```text
CUE
 ↓
Generate possible actions
 ↓
CandidateAction
```

Example:

```text
Cue:
Invoice email received

Possible action:
Process supplier invoice
```

Candidate information includes:

```text
goal
action
confidence
expected utility
estimated risk
estimated cost
evidence references
```

---

# 3. Candidate Scoring

File:

```text
domain/candidate-score.ts
```

The scoring system determines how useful and safe-looking a candidate appears.

Current factors:

```text
confidence
utility
low risk
low cost
```

Current conceptual formula:

```text
score =
  confidence contribution
+ utility contribution
+ low-risk contribution
+ low-cost contribution
```

The result is clamped between:

```text
0.0 → 1.0
```

Decision ranges:

```text
0.00 ────────────────────────────── 1.00

0.00 - 0.39
IGNORE

0.40 - 0.69
ASK_HUMAN

0.70 - 1.00
AUTO_CANDIDATE
```

Important:

```text
AUTO_CANDIDATE
      ≠
AUTO_EXECUTE
```

It only means the candidate is strong enough to continue through the safety pipeline.

---

# 4. Grounding

File:

```text
domain/grounding.ts
```

Grounding verifies that the candidate is supported by real evidence.

Possible evidence sources:

```text
tool
API
database
document
verified memory
human
```

Example:

```text
Candidate:
"Process invoice #123"

        ↓

Evidence

Gmail message       ✓
invoice attachment  ✓
supplier identity   ✓

        ↓

VERIFIED
```

Possible grounding outcomes:

```text
VERIFIED

INSUFFICIENT_EVIDENCE

CONFLICTING_EVIDENCE
```

If evidence is insufficient or conflicting:

```text
DO NOT ACT
```

---

# 5. Policy Decision

File:

```text
domain/policy-decision.ts
```

Policy is a hard safety boundary.

Possible outcomes:

```text
ALLOW

REQUIRE_APPROVAL

DENY
```

Example:

```text
Read public project status
        ↓
ALLOW
```

```text
Send an external email
        ↓
REQUIRE_APPROVAL
```

```text
Reveal a private secret
        ↓
DENY
```

Policy always wins over scoring.

```text
Candidate score = 1.00

        ↓

Policy = DENY

        ↓

STOP
```

---

# Current Domain Structure

```text
src/
└── features/
    └── cognitive/
        ├── FLOW.md
        │
        └── domain/
            ├── cue.ts
            ├── candidate-action.ts
            ├── candidate-score.ts
            ├── grounding.ts
            ├── policy-decision.ts
            └── types.ts
```

---

# Current Progress

```text
CUE                    ✅
 ↓
CANDIDATE ACTION       ✅
 ↓
SCORING                ✅
 ↓
GROUNDING              ✅
 ↓
POLICY DECISION        ✅
 ↓
PLAN                    ⏳
 ↓
EXECUTION               ⏳
 ↓
OBSERVE                 ⏳
 ↓
VERIFY RESULT           ⏳
 ↓
REWARD                  ⏳
 ↓
LEARN                   ⏳
 ↓
MEMORY                  ⏳
```

---

# Future Complete Cognitive Loop

```text
WORLD
  ↓
CUE
  ↓
PERCEIVE
  ↓
BUILD CONTEXT
  ↓
RETRIEVE MEMORY
  ↓
GENERATE CANDIDATES
  ↓
SCORE
  ↓
GROUND / VERIFY
  ↓
POLICY / SAFETY
  ↓
PLAN
  ↓
DURABLE EXECUTION
  ↓
ACT
  ↓
OBSERVE
  ↓
VERIFY RESULT
  ↓
REWARD
  ↓
LEARN
  ↓
SAVE VERIFIED MEMORY
  ↓
CLEAR WORKING MEMORY
  ↓
IDLE
  ↓
WAIT FOR NEXT CUE
```

---

# Failure / Hallucination Flow

```text
UNSUPPORTED CLAIM
      │
      ↓
     STOP
      │
      ↓
BLOCK TOOL ACTION
      │
      ↓
PRESERVE AUDIT EVIDENCE
      │
      ↓
CLEAR TEMPORARY ASSUMPTIONS
      │
      ↓
RELOAD TRUSTED CONTEXT
      │
      ↓
RE-GROUND
      │
      ↓
RETRY
```

Repeated failure:

```text
Failure #1
    ↓
Fresh-context retry

Failure #2
    ↓
Circuit breaker
    ↓
4-minute cooldown

Failure #3
    ↓
Disable autonomous execution
    ↓
Human review
```

The cooldown itself does not fix hallucination.

The important recovery process is:

```text
STOP
 ↓
CLEAR TEMP CONTEXT
 ↓
RELOAD TRUSTED DATA
 ↓
RE-GROUND
 ↓
RE-EVALUATE
```

---

# Memory Rule

AutoDo will eventually use two important categories of memory.

```text
LONG-TERM VERIFIED MEMORY
             │
             ↓
        trusted facts
        policies
        validated skills
        reward history

TEMPORARY WORKING MEMORY
             │
             ↓
        current task
        temporary context
        candidate reasoning
        intermediate results
```

After a task:

```text
verified useful knowledge
        ↓
SAVE

temporary assumptions
        ↓
CLEAR
```

This gives AutoDo a fresh working context without deleting trusted long-term knowledge.

---

# Reward Flow — Future

```text
ACTION
  ↓
RESULT
  ↓
VERIFY
  ↓
EVALUATE
  ↓
REWARD EVENT
  │
  ├── positive
  └── negative
  ↓
UPDATE SKILL CONFIDENCE
  ↓
UPDATE FUTURE AUTONOMY
```

Example:

```text
successful task       +10
human approval         +5
small correction       -3
failed task           -10
hallucination         -20
unsafe action        -100
```

Reward can influence future confidence.

Reward can never override safety policy.

---

# Autonomy Flow — Future

```text
NEW SKILL
   ↓
OBSERVE
   ↓
SUGGEST
   ↓
ASK HUMAN
   ↓
GOOD HISTORY
   ↓
AUTO-CANDIDATE
   ↓
POLICY / SAFETY
```

If performance becomes worse:

```text
AUTO
 ↓
mistakes increase
 ↓
confidence decreases
 ↓
ASK HUMAN
 ↓
SUGGEST ONLY
```

---

# Architecture Principle

AutoDo should never become:

```text
LLM
 ↓
random thought
 ↓
direct tool execution
```

The intended architecture is:

```text
LLM / REASONING
       ↓
CANDIDATE
       ↓
DETERMINISTIC SCORE
       ↓
GROUNDING
       ↓
POLICY
       ↓
APPROVAL
       ↓
EXECUTION
```

Every important autonomous action must be:

```text
traceable
verifiable
permission-bound
recoverable
auditable
```

---

# Documentation Rule

Create one `FLOW.md` per major AutoDo subsystem.

Future examples:

```text
features/
├── cognitive/
│   └── FLOW.md
│
├── memory/
│   └── FLOW.md
│
├── execution/
│   └── FLOW.md
│
├── rewards/
│   └── FLOW.md
│
├── approvals/
│   └── FLOW.md
│
└── tools/
    └── FLOW.md
```

Do not create `FLOW.md` inside every tiny implementation folder.

Update this document whenever the cognitive architecture changes.
