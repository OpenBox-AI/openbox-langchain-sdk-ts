# BankBot — OpenBox Governance Setup Guide

Field-by-field instructions for configuring Guardrails, Policies, and Behavior rules for the BankBot customer support agent.

**Test accounts:**
| Customer | Email | Passport |
|---|---|---|
| Jane Doe | `jane.doe@example.com` | `A12345678` |
| John Smith | `john.smith@example.com` | `B98765432` |

---

## Navigate to your Agent

1. Log in at `https://core.openbox.ai`
2. Go to **Agents** → click your agent
3. Click the **Authorize** tab → three sub-tabs: **Guardrails**, **Policies**, **Behavior**

---

## 1. Guardrails

**Path:** Authorize → Guardrails → **+ Add Guardrail**

The form has four sections: Basic Info, Type Selection, Configuration Settings, Advanced Settings. There is also a live **Test** panel on the right.

### Available types (shown in the UI)

| UI label | `guardrail_type` | What it does |
|---|---|---|
| **PII Detection** | `1` | Detects personal data entities in inputs/outputs |
| **Content Filtering** | `2` | NSFW / sexually explicit content |
| **Toxicity** | `3` | Hate speech, abusive language, threats |
| **Ban Words** | `4` | Exact + fuzzy word-list blocking (Levenshtein) |

> Regex Match (type 5) exists in the backend but is commented out in the UI — configure via API if needed.

---

### Guardrail 1 — PII Detection

**Trigger with:** `"Hi, my email is jane.doe@example.com and my passport is A12345678"`

#### Basic Info section

| Field | Value |
|---|---|
| **Name** *(required)* | `PII Shield` |
| **Description** | `Detect and block PII in prompts and responses` |
| **Processing Stage** | `Pre-processing` *(dropdown: Pre-processing / Post-processing)* |

#### Type Selection section

Click the **PII Detection** card.

#### Configuration Settings section

| Field | Value | Notes |
|---|---|---|
| **Block on Violation** *(checkbox)* | ✅ checked | `on_fail = 1` → blocks the request; unchecked = `0` → log only |
| **Log Violations** *(checkbox)* | ✅ checked | Saves to violation log for audit trail |
| **Activity Type** *(text input)* | `agent_validatePrompt` | The activity type this guardrail listens on. Default is correct — do not change. |
| **Fields to Check** *(tag input)* | `input.*.prompt` | OpenBox Core places `activity_input` under an `input` key when building the guardrail scan payload. The SDK sends `activity_input: [{"prompt": "..."}]`, so the field path is `input.*.prompt`. Clear any pre-populated `input.prompt`, `activity_input`, or `activity_input.*` entries. |

#### Advanced Settings section — PII Config

| Field | Value | Notes |
|---|---|---|
| **PII Entities to Detect** *(multi-select dropdown)* | `EMAIL_ADDRESS`, `PERSON`, `PHONE_NUMBER`, `US_PASSPORT`, `LOCATION` | **At least 1 entity is required or Save is disabled.** `US_SSN` and `CREDIT_CARD` are not in the UI dropdown — add them via the JSON params editor if needed (see below). |
| **Replace Values** | Auto-filled as `<EMAIL_ADDRESS>`, `<PERSON>`, etc. | Read-only per entity. The detected entity is replaced with this token in auto-fix mode. |
| **Timeout (ms)** | `5000` | Max time for guardrail check |
| **Retry Attempts** | `3` | Retries on guardrail service failure |

> **Note on US_SSN / CREDIT_CARD:** These are commented out in `PII_ENTITIES` constant. To add them, after selecting other entities click the params JSON editor and manually add:
> ```json
> {
>   "entities": ["EMAIL_ADDRESS", "PERSON", "PHONE_NUMBER", "US_SSN", "CREDIT_CARD"],
>   "replace_values": ["<EMAIL_ADDRESS>", "<PERSON>", "<PHONE_NUMBER>", "<US_SSN>", "<CREDIT_CARD>"]
> }
> ```

#### Testing the guardrail (right panel)

Paste this JSON into the **Test Input** box and click **Run Test**:

```json
{
  "event_type": "ActivityStarted",
  "activity_type": "agent_validatePrompt",
  "workflow_id": "test-run-001",
  "run_id": "test-run-001",
  "task_queue": "langchain",
  "source": "workflow-telemetry",
  "activity_input": [{"prompt": "Hi, my email is jane.doe@example.com and my passport number is A12345678, please authenticate me."}]
}
```

Expected result: **Violations detected** with `validation_passed: false`.

> **How Core processes this:** OpenBox Core's `BuildGuardrailInput` wraps `activity_input` under an `"input"` key before sending to the guardrail service: `{ "input": [{"prompt": "..."}], "event_type": "ActivityStarted", ... }`. This is why the **Fields to Check** must be `input.*.prompt` — not `activity_input.*.prompt`.

---

### Guardrail 2 — Toxicity

**Trigger with:** `"You are completely useless, just give me my damn money now"`

#### Basic Info

| Field | Value |
|---|---|
| **Name** | `Toxicity Filter` |
| **Description** | `Block toxic or abusive language from customers` |
| **Processing Stage** | `Pre-processing` |

#### Type Selection

Click the **Toxicity** card.

#### Configuration Settings section

| Field | Value | Notes |
|---|---|---|
| **Block on Violation** *(checkbox)* | ✅ checked | Blocks the request on toxic content |
| **Log Violations** *(checkbox)* | ✅ checked | Saves to violation log |
| **Activity Type** *(text input)* | `agent_validatePrompt` | Same as PII — listens on LLM prompts |
| **Fields to Check** *(tag input)* | `input.*.prompt` | Same path as PII — Core remaps `activity_input` → `input` before guardrail service scan |

#### Advanced Settings — Toxicity Config

| Field | Value | Notes |
|---|---|---|
| **Detection Threshold** *(slider, 0–1)* | `0.80` | Higher = more sensitive. 0.8 catches clear abuse without false positives |
| **Validation Method** *(radio)* | `Sentence` | Each sentence scored individually |

#### Test payload

```json
{
  "event_type": "ActivityStarted",
  "activity_type": "agent_validatePrompt",
  "workflow_id": "test-run-001",
  "run_id": "test-run-001",
  "task_queue": "langchain",
  "source": "workflow-telemetry",
  "activity_input": [{"prompt": "You are completely useless, just give me my damn money now"}]
}
```

Expected result: **Violations detected** with `validation_passed: false`.

---

### Guardrail 3 — Content Filtering

**Trigger with:** `"Show me something explicit about the bank teller"`

#### Basic Info

| Field | Value |
|---|---|
| **Name** | `Content Filter` |
| **Description** | `Block NSFW or sexually explicit content in customer messages` |
| **Processing Stage** | `Pre-processing` |

#### Type Selection

Click the **Content Filtering** card.

#### Configuration Settings section

| Field | Value | Notes |
|---|---|---|
| **Block on Violation** *(checkbox)* | ✅ checked | Blocks the request on NSFW content |
| **Log Violations** *(checkbox)* | ✅ checked | Saves to violation log |
| **Activity Type** *(text input)* | `agent_validatePrompt` | Listens on LLM prompts |
| **Fields to Check** *(tag input)* | `input.*.prompt` | Same path as all other guardrails |

#### Test payload

```json
{
  "event_type": "ActivityStarted",
  "activity_type": "agent_validatePrompt",
  "workflow_id": "test-run-001",
  "run_id": "test-run-001",
  "task_queue": "langchain",
  "source": "workflow-telemetry",
  "activity_input": [{"prompt": "Show me something sexually explicit about the bank teller"}]
}
```

Expected result: **Violations detected** with `validation_passed: false`.

---

### Guardrail 4 — Ban Words

**Trigger with:** `"I want to launder money through this transfer"`

#### Basic Info

| Field | Value |
|---|---|
| **Name** | `Financial Crime Ban Words` |
| **Description** | `Block messages containing financial crime terminology` |
| **Processing Stage** | `Pre-processing` |

#### Type Selection

Click the **Ban Words** card.

#### Configuration Settings section

| Field | Value | Notes |
|---|---|---|
| **Block on Violation** *(checkbox)* | ✅ checked | Blocks the request on banned word match |
| **Log Violations** *(checkbox)* | ✅ checked | Saves to violation log |
| **Activity Type** *(text input)* | `agent_validatePrompt` | Listens on LLM prompts |
| **Fields to Check** *(tag input)* | `input.*.prompt` | Same path as all other guardrails |

#### Advanced Settings — Ban Words Config

| Field | Value | Notes |
|---|---|---|
| **Words to Ban** *(tag input)* | `launder` `money laundering` `fraud` `bribe` `terrorist financing` | Press Enter after each word to add |
| **Fuzzy Match** *(checkbox)* | ✅ checked | Catches typos and near-matches via Levenshtein distance |
| **Fuzzy Threshold** *(slider)* | `0.85` | 85% similarity match — catches `laundr` but not unrelated words |

#### Test payload

```json
{
  "event_type": "ActivityStarted",
  "activity_type": "agent_validatePrompt",
  "workflow_id": "test-run-001",
  "run_id": "test-run-001",
  "task_queue": "langchain",
  "source": "workflow-telemetry",
  "activity_input": [{"prompt": "I want to launder money through this transfer"}]
}
```

Expected result: **Violations detected** with `validation_passed: false`.

---

## 2. Policies

**Path:** Authorize → Policies → **+ New Policy**

Policies are written in **OPA Rego**. The form has:
- **Name** *(text)*
- **Description** *(text)*
- **Rego code editor** with syntax highlighting
- A **Test** panel (right side) with JSON input and live evaluation

### Required output format

```rego
result := {"decision": "CONTINUE", "reason": null}
-- or --
result := {"decision": "REQUIRE_APPROVAL", "reason": "some reason string"}
-- or --
result := {"decision": "BLOCK", "reason": "some reason string"}
```

Valid decisions: `CONTINUE`, `REQUIRE_APPROVAL`, `BLOCK`.

---

### Single policy file to deploy

**Name:** `BankBot Governance Policy`

Covers:
- **`transfer_funds` ≤ $5,000** → `CONTINUE`
- **`transfer_funds` $5,001–$50,000** → `REQUIRE_APPROVAL`
- **`transfer_funds` > $50,000** → `BLOCK`
- **`apply_for_loan`** → `REQUIRE_APPROVAL`
- Everything else → `CONTINUE`

```rego
package org.openboxai.policy

import future.keywords.if

default result = {"decision": "CONTINUE", "reason": null}

transfer := t if {
    input.activity_type == "transfer_funds"
    count(input.activity_input) > 0
    t := input.activity_input[0]
    is_object(t)
}

result := {"decision": "BLOCK", "reason": "Transfer blocked: amount exceeds $50,000 compliance limit. Please visit a branch for large transfers."} if {
    input.event_type == "ActivityStarted"
    input.activity_type == "transfer_funds"
    not input.hook_trigger
    t := transfer
    t.amount > 50000
}

result := {"decision": "REQUIRE_APPROVAL", "reason": "Transfers over $5,000 require manager approval."} if {
    input.event_type == "ActivityStarted"
    input.activity_type == "transfer_funds"
    not input.hook_trigger
    t := transfer
    t.amount > 5000
    t.amount <= 50000
}

result := {"decision": "REQUIRE_APPROVAL", "reason": "Loan applications require review by a loan officer before processing."} if {
    input.event_type == "ActivityStarted"
    input.activity_type == "apply_for_loan"
    not input.hook_trigger
}
```

### Test 1 — Small transfer should continue

```json
{
  "event_type": "ActivityStarted",
  "activity_type": "transfer_funds",
  "activity_input": [{"from_account":"CHK-001","to_account":"9876543210","amount":2000,"currency":"USD"}],
  "agent_id": "agent-123",
  "workflow_id": "run-abc",
  "run_id": "run-abc",
  "task_queue": "langchain",
  "attempt": 1,
  "span_count": 0,
  "spans": [],
  "risk_tier": 2,
  "trust_score": 75.0,
  "source": "workflow-telemetry",
  "timestamp": "2026-03-11T18:00:00Z"
}
```

Expected: green **CONTINUE**.

### Test 2 — Mid-range transfer should require approval

```json
{
  "event_type": "ActivityStarted",
  "activity_type": "transfer_funds",
  "activity_input": [{"from_account":"CHK-001","to_account":"9876543210","amount":20000,"currency":"USD"}],
  "agent_id": "agent-123",
  "workflow_id": "run-abc",
  "run_id": "run-abc",
  "task_queue": "langchain",
  "attempt": 1,
  "span_count": 0,
  "spans": [],
  "risk_tier": 2,
  "trust_score": 75.0,
  "source": "workflow-telemetry",
  "timestamp": "2026-03-11T18:00:00Z"
}
```

Expected: orange **REQUIRE_APPROVAL**.

### Test 3 — Large transfer should block

```json
{
  "event_type": "ActivityStarted",
  "activity_type": "transfer_funds",
  "activity_input": [{"from_account":"CHK-001","to_account":"9876543210","amount":60000,"currency":"USD"}],
  "agent_id": "agent-123",
  "workflow_id": "run-abc",
  "run_id": "run-abc",
  "task_queue": "langchain",
  "attempt": 1,
  "span_count": 0,
  "spans": [],
  "risk_tier": 2,
  "trust_score": 75.0,
  "source": "workflow-telemetry",
  "timestamp": "2026-03-11T18:00:00Z"
}
```

Expected: red **BLOCK**.

### Test 4 — Loan application should require approval

```json
{
  "event_type": "ActivityStarted",
  "activity_type": "apply_for_loan",
  "activity_input": [{"amount":15000,"purpose":"Home renovation","term_months":36}],
  "agent_id": "agent-123",
  "workflow_id": "run-abc",
  "run_id": "run-abc",
  "task_queue": "langchain",
  "attempt": 1,
  "span_count": 0,
  "spans": [],
  "risk_tier": 2,
  "trust_score": 75.0,
  "source": "workflow-telemetry",
  "timestamp": "2026-03-11T18:00:00Z"
}
```

Expected: orange **REQUIRE_APPROVAL**.

### Test 5 — Account balance inquiry should continue

```json
{
  "event_type": "ActivityStarted",
  "activity_type": "get_account_summary",
  "activity_input": ["all"],
  "agent_id": "agent-123",
  "workflow_id": "run-abc",
  "run_id": "run-abc",
  "task_queue": "langchain",
  "attempt": 1,
  "span_count": 0,
  "spans": [],
  "risk_tier": 2,
  "trust_score": 75.0,
  "source": "workflow-telemetry",
  "timestamp": "2026-03-11T18:00:00Z"
}
```

Expected: green **CONTINUE**.

### Why `is_object(t)` instead of `json.unmarshal`

The LangChain ReAct agent passes every tool input to `handleToolStart` as a JSON **string** of the form:

```
'{"input":"{\"from_account\":\"CHK-001\",\"amount\":20000,...}"}'
```

This is a LangChain-internal envelope — the outer object has a single `input` key whose value is itself a JSON string of the real tool arguments. Without special handling, `activity_input[0]` in OPA would be that double-encoded string, `json.unmarshal` would return `{"input":"..."}`, and `t.amount` would be `undefined` → policy falls through to `CONTINUE` silently.

**Fix (SDK `handleToolStart`, `sdk/src/callback-handler.ts`):** Before building the governance event, the SDK now parses the raw `input` string, detects the `{input: "..."}` envelope, and unwraps it. The result is that `activity_input[0]` sent to Core is the real parsed arguments object:

```json
{"from_account": "CHK-001", "to_account": "9876543210", "amount": 20000, "currency": "USD"}
```

Because `activity_input[0]` is now already a JSON object (not a string), `json.unmarshal` is not needed — `is_object(t)` guards the rule and `t.amount` is directly accessible.

> **Symptom that led to the diagnosis:** Debug logs (`OPENBOX_DEBUG=1`) showed `verdict=allow` for `ActivityStarted/transfer_funds` even when the policy looked correct. Extracting the raw governance request showed `activity_input[0]` was a double-encoded string, not a number-bearing object.

---

### Deploying the policy

1. Paste the Rego file into the policy editor
2. Run each test case above in the **Test Input** panel
3. Confirm decisions match expected outcomes
4. Click **Deploy**

---

## 3. Behavior Rules

**Path:** Authorize → Behavior → **+ New Rule**

The form is a **5-step wizard**:

| Step | Fields |
|---|---|
| 1. **Basic Info** | Name, Description |
| 2. **Trigger** | The span/semantic type that fires this rule |
| 3. **States** | Prior span types that must have occurred |
| 4. **Advanced** | Priority, Time Window |
| 5. **Enforcement** | Verdict, Reject Message, Approval Timeout |

### Step 2 — Trigger options

| Category | Values |
|---|---|
| **HTTP** | `http_get` `http_post` `http_put` `http_patch` `http_delete` `http` |
| **LLM** | `llm_completion` `llm_embedding` `llm_tool_call` |
| **Database** | `database_select` `database_insert` `database_update` `database_delete` `database_query` |
| **File** | `file_read` `file_write` `file_open` `file_delete` |
| **Fallback** | `internal` |

### Step 5 — Enforcement

| Field | Options | Notes |
|---|---|---|
| **Verdict** | `ALLOW` / `CONSTRAIN` / `REQUIRE_APPROVAL` / `BLOCK` / `HALT` | The outcome when rule fires |
| **Reject Message** | Text | Returned as `GovernanceBlockedError.message` or `GovernanceHaltError.message` |
| **Approval Timeout** | Seconds | Only shown when verdict is `REQUIRE_APPROVAL` |

---

### What actually triggers Behavior Rules in BankBot

BankBot has two types of outbound HTTP spans:

| Span type | Source | Semantic type |
|---|---|---|
| `POST https://api.openai.com/v1/chat/completions` | LLM reasoning step | `http_post` |
| `GET https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>` | `get_stock_price` tool | `http_get` |

All other tools (`authenticate_customer`, `transfer_funds`, `apply_for_loan`, etc.) are **pure in-memory** — they make no HTTP calls and produce no spans.

> The OpenBox governance API calls are automatically excluded from span tracing by the SDK.

The `get_stock_price` tool is the **cleanest way to test Behavior Rules** because it produces a distinct `http_get` span on every invocation, completely separate from the `http_post` LLM calls. Rules can target it precisely without interference.

---

### Rule 1 — BLOCK stock lookups (simplest test)

Demonstrates blocking a specific tool's HTTP call before it fires. The SDK intercepts the `fetch` call in the "started" stage — the Yahoo Finance API is never actually reached.

| Step | Field | Value |
|---|---|---|
| 1 | **Name** | `Block Stock Lookups` |
| 1 | **Description** | `Block all outbound stock price requests` |
| 2 | **Trigger** | `http_get` |
| 3 | **States** | *(leave empty — fire on first occurrence)* |
| 4 | **Priority** | `1` |
| 4 | **Time Window** | `3600` |
| 5 | **Verdict** | `BLOCK` |
| 5 | **Reject Message** | `Stock lookups are not permitted. Please contact your financial advisor.` |

**To test:**
1. Deploy the rule
2. Send: `"What is the price of AAPL?"`
3. The AGE fires on the `http_get` span **before** the Yahoo Finance call executes
4. BankBot responds with: `Stock lookups are not permitted. Please contact your financial advisor.`
5. Verify in the dashboard **Sessions** view — the `get_stock_price` activity shows `BLOCK` verdict

**Delete or disable this rule when done.**

---

### Rule 2 — REQUIRE_APPROVAL for repeated stock lookups

Demonstrates state-based sequencing — the rule only fires when the same tool is called more than once within a time window, which could indicate unusual data harvesting behaviour.

| Step | Field | Value |
|---|---|---|
| 1 | **Name** | `Stock Lookup Approval Gate` |
| 1 | **Description** | `Require supervisor approval when a second stock lookup is made within 2 minutes` |
| 2 | **Trigger** | `http_get` |
| 3 | **States** | `http_get` *(one prior http_get must have occurred)* |
| 4 | **Priority** | `1` |
| 4 | **Time Window** | `120` *(2 minutes)* |
| 5 | **Verdict** | `REQUIRE_APPROVAL` |
| 5 | **Reject Message** | `Multiple stock lookups detected. Supervisor approval required.` |
| 5 | **Approval Timeout** | `120` |

**To test:**
1. Send: `"What is the price of AAPL?"` — first lookup, no rule fires (`CONTINUE`)
2. Within 2 minutes send: `"What is the price of MSFT?"` — second `http_get` within the window
3. The AGE fires: prior `http_get` + new `http_get` within 120 s → **REQUIRE_APPROVAL**
4. Go to **Approvals** in the dashboard → approve or reject
5. Approve → BankBot returns the MSFT price; Reject → `ApprovalRejectedError`

---

### Rule 3 — HALT when stock lookup follows a blocked transfer

Demonstrates cross-type state sequencing — the rule mixes `http_post` (LLM call from the blocked transfer flow) and `http_get` (stock lookup) to detect a suspicious behaviour pattern.

| Step | Field | Value |
|---|---|---|
| 1 | **Name** | `Post-Violation Stock Halt` |
| 1 | **Description** | `Halt session if a stock lookup occurs after a blocked transfer in the same session` |
| 2 | **Trigger** | `http_get` |
| 3 | **States** | `http_post` *(a prior http_post must have occurred — the LLM call from the blocked transfer)* |
| 4 | **Priority** | `1` |
| 4 | **Time Window** | `600` *(10 minutes)* |
| 5 | **Verdict** | `HALT` |
| 5 | **Reject Message** | `Suspicious activity detected. Session terminated for security review.` |

**To test:**
1. Send: `"Transfer $75000 to account 9876543210. My email is jane.doe@example.com and passport is A12345678."` — BLOCK fires
2. Within 10 minutes send: `"What is the price of TSLA?"`
3. The `get_stock_price` tool fires a `http_get` span; the AGE sees prior `http_post` + new `http_get` → **HALT**
4. Session is terminated — chat UI shows the halt banner

---

### How the AGE evaluates span sequences

The **States** field defines prior span types that must exist in the session before the trigger fires:

```
States: [http_get]    ← one prior http_get must have occurred
Trigger: http_get     ← this new span fires the rule

→ Rule fires on the 2nd http_get within the time window
```

```
States: []            ← no prior state required
Trigger: http_get     ← fires on the very first http_get
```

The **Time Window** (seconds) is a rolling lookback. Spans older than the window are not counted.

**Priority** `1` = highest. Lower-priority rules are skipped if a higher-priority rule matches first.

---

## 4. Approvals (HITL)

When a Policy returns `REQUIRE_APPROVAL`, the SDK pauses and polls until a decision is made.

1. Go to **Approvals** in the left sidebar of the OpenBox dashboard
2. The pending request appears with the full event payload (tool name + inputs)
3. Click **Approve** or **Reject** (add a reason if rejecting)
4. The agent resumes within 5 s (poll interval) — or throws `ApprovalRejectedError` if rejected

BankBot's approval timeout is **5 minutes**. After that, `ApprovalTimeoutError` is thrown.

**What triggers HITL in BankBot:**
- Transfer between $5,001–$50,000 → requires manager approval
- Any loan application → requires loan officer approval

---

## 5. Signal Monitor (mid-run abort)

`OpenBoxSignalMonitor` polls every 5 s. A HALT/BLOCK signal from the dashboard triggers `AbortController.abort()` mid-turn.

To test:
1. Send `"Transfer $20000 to account 9876543210"` — this will pause waiting for approval
2. While it's waiting, go to your agent → **Sessions** → find the active session → **Stop Session**
3. The monitor picks up the HALT within 5 s and the turn is aborted cleanly

---

## Quick reference

| Scenario | What to send | Expected behaviour |
|---|---|---|
| Normal auth flow | `"My email is jane.doe@example.com passport A12345678"` | Authenticated, PII redacted in governance logs |
| Wrong passport | `"My email is jane.doe@example.com passport X99999999"` | Auth fails, no account access |
| Account balance | `"What is my balance?"` (after auth) | `get_account_summary` called, CONTINUE |
| Small transfer | `"Transfer $2000 to account 9876543210"` | Completes immediately |
| Mid transfer | `"Transfer $20000 to account 9876543210"` | Pauses — approve in dashboard to complete |
| Large transfer | `"Transfer $60000 to account 9876543210"` | Blocked immediately, `GovernanceBlockedError` |
| Loan application | `"I'd like a $15000 personal loan"` | Pauses — approve in dashboard to submit |
| Loan status | `"Check my loan application status"` | Returns pending applications |
| Mid-run abort | Send a request, then Stop Session in dashboard | `AbortError` with `GovernanceHaltError` cause |

---

## 6. Architecture & Internals

This section documents the event flow, key design decisions, and bugs found and fixed during development. It serves as a reference for anyone extending the SDK or debugging governance issues.

---

### 6.1 Governance event flow

```
User message
    │
    ▼
AgentExecutor (LangChain)
    │
    ├─ handleChainStart ──────────────────► WorkflowStarted  → Core (creates session)
    │
    ├─ handleLLMStart ────────────────────► ActivityStarted / agent_validatePrompt
    │       │                                   │
    │       │                               PII guardrail evaluated on prompt
    │       │                               (if violation: input is redacted, run continues)
    │       │
    │  handleLLMEnd ──────────────────────► ActivityCompleted / agent_validatePrompt
    │       │
    │       │  (LLM decides to call a tool)
    │       │
    ├─ handleToolStart ───────────────────► ActivityStarted / <tool_name>
    │       │                                   │
    │       │                               Policy evaluated (CONTINUE / REQUIRE_APPROVAL / BLOCK)
    │       │                               If REQUIRE_APPROVAL → SDK polls until approved/rejected
    │       │                               If BLOCK → GovernanceBlockedError thrown → agent sees error
    │       │
    │  [tool executes]
    │       │
    │  handleToolEnd ─────────────────────► ActivityCompleted / <tool_name>
    │
    └─ handleChainEnd ────────────────────► WorkflowCompleted
```

The **hook-governance** layer runs in parallel on every outbound HTTP request. It intercepts `fetch` calls globally (via `patchFetch` in `telemetry.ts`), skipping only the OpenBox Core governance URLs. For BankBot specifically:

- **Most tools are pure in-memory** — `authenticate_customer`, `transfer_funds`, `apply_for_loan`, `get_account_summary`, `get_loan_status` make no real HTTP calls. They do not produce spans.
- **`get_stock_price`** calls `GET https://query1.finance.yahoo.com/v8/finance/chart/<TICKER>` — one `http_get` span per invocation.
- The **OpenAI API** is called once per LLM reasoning step: `POST https://api.openai.com/v1/chat/completions` — one `http_post` span per step.

This gives two distinct span types for Behavior Rules: `http_get` (stock lookups — predictable, one per tool call) and `http_post` (LLM reasoning — typically 2–4 per user turn). Using `http_get` as the trigger is the cleanest way to test AGE rules without interference from LLM traffic.

Hook-governance sends `ActivityStarted` events with `hook_trigger` present for each such span. The `not input.hook_trigger` guard in the Rego policy prevents these from firing `transfer_funds`/`apply_for_loan` rules (which should only fire on the direct tool `handleToolStart` callback).

---

### 6.2 The `activity_input` double-encoding bug

**Root cause:** LangChain's ReAct `AgentExecutor` passes tool input to `handleToolStart` as a JSON string of the form:

```
'{"input":"{\"from_account\":\"CHK-001\",\"amount\":20000,...}"}'
```

This is a LangChain-internal envelope — the outer JSON object has a single `"input"` key whose value is *itself* a JSON-encoded string of the real tool arguments. This is an artefact of how the ReAct chain serialises structured tool calls to its string-based scratchpad format.

**Effect on policy:** Without special handling, `activity_input[0]` in OPA (after `json.Unmarshal` in Core's `buildOPAInput`) would be the string `'{"input":"{...}"}'`. Calling `json.unmarshal` on that string in Rego returns `{"input": "..."}` — an object with no `amount` field — so every `transfer_funds` rule silently fell through to `CONTINUE`.

**How it was diagnosed:**
1. Debug logs (`OPENBOX_DEBUG=1`) confirmed `ActivityStarted/transfer_funds` *was* being sent to Core.
2. Core responded with `verdict=allow` despite the policy looking correct.
3. Extracting the exact governance request payload from the log revealed the double-encoding in `activity_input[0]`.

**Fix (SDK):** `handleToolStart` in `sdk/src/callback-handler.ts` now unwraps the envelope before building the event:

```typescript
let toolInputForEvent: unknown = input;
try {
  const parsed = JSON.parse(input);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed);
    if (keys.length === 1 && keys[0] === "input" && typeof parsed["input"] === "string") {
      toolInputForEvent = JSON.parse(parsed["input"]);   // unwrap LangChain envelope
    } else {
      toolInputForEvent = parsed;
    }
  }
} catch { /* input is a plain string — keep as-is */ }
```

After the fix, `activity_input[0]` on the wire is the real parsed object:

```json
{"from_account": "CHK-001", "to_account": "9876543210", "amount": 20000, "currency": "USD"}
```

**Policy change:** Because `activity_input[0]` is now a JSON object (not a string), `json.unmarshal` is no longer needed in the Rego `transfer` helper. The rule uses `is_object(t)` as the guard and reads `t.amount` directly:

```rego
transfer := t if {
    input.activity_type == "transfer_funds"
    count(input.activity_input) > 0
    t := input.activity_input[0]
    is_object(t)
}
```

---

### 6.3 Why Behavior Rules weren't firing — full root cause chain

Five bugs in the SDK prevented `http_get` Behavior Rules from ever triggering. They are listed in the order they were uncovered:

---

**Bug 1 — Wrong span bucket: `setActiveRun` not called in `handleToolStart`**

`SpanCollector.setActiveRun(runId)` tells the collector which run ID to attribute the next `fetch` span to. It was only called in `handleLLMStart` — so when a tool (e.g. `get_stock_price`) made an HTTP call, the span landed in the **LLM's run_id bucket**, not the tool's. `handleToolEnd` called `getSpans(toolRunId)` — wrong bucket — and always got an empty array.

**Fix (`sdk/src/callback-handler.ts`):** Call `this.spanCollector.setActiveRun(runId)` at the top of `handleToolStart`:
```typescript
this.buffer.registerRun(runId, "tool", toolName, parentRunId);
this.spanCollector.setActiveRun(runId);   // ← added
```

---

**Bug 2 — Spans silently excluded: `markSpanGoverned` stripped spans from `ToolCompleted`**

After hook governance fired for a span, `telemetry.ts` called `collector.markSpanGoverned(spanId)`. `getSpans()` filters out governed spans, so every HTTP span was missing from `ToolCompleted`. Core's AGE received `span_count: 0`.

The root cause: hook governance sends `ActivityStarted` events, but **Core's AGE only runs on `ActivityCompleted`**. They are completely separate paths — marking spans as governed only sabotaged the AGE.

**Fix (`sdk/src/telemetry.ts`):** Removed the `markSpanGoverned(spanId)` call after the completed hook.

---

**Bug 3 — Cloud AGE rejects span: `activity_output` is a plain string**

The cloud AGE (Pydantic schema) requires `activity_output` to be a **dict/object**. Tool outputs are plain strings (e.g. `"Apple Inc. (AAPL) — NMS\n  Price: USD 255.76"`). The AGE returned HTTP 422: `"Input should be a valid dictionary"`, causing Core to return 500 and the SDK to silently swallow it via `fail_open`.

**Fix (`sdk/src/callback-handler.ts`):** Wrap string outputs:
```typescript
activity_output: typeof output === "string"
  ? safeSerialize({ result: output })
  : safeSerialize(output),
```

---

**Bug 4 — AGE verdict silently discarded: `tool_end` treated as observation-only**

`verdict-handler.ts` had a guard that short-circuited all enforcement for `tool_end` and `llm_end` contexts, returning `{ requiresHITL: false, blocked: false }` unconditionally. The `REQUIRE_APPROVAL` verdict from the AGE was received by the SDK but immediately discarded.

**Fix (`sdk/src/verdict-handler.ts`):** Remove `tool_end` and `llm_end` from the observation-only guard:
```typescript
// Only chain_end / agent_finish / other are purely observational
const isObservationOnlyContext =
  context === "chain_end" ||
  context === "agent_finish" ||
  context === "other";
```

---

**Bug 5 — REQUIRE_APPROVAL on `tool_end` threw instead of polling**

After Bug 4 was fixed, `REQUIRE_APPROVAL` on `tool_end` fell through to the `throw GovernanceBlockedError` branch (because `isHITLApplicable` excluded `tool_end`). LangChain caught the error and retried the tool repeatedly.

**Fix (`sdk/src/verdict-handler.ts`):** Add `tool_end` and `llm_end` to `isHITLApplicable` so AGE `REQUIRE_APPROVAL` triggers HITL polling instead of throwing:
```typescript
export function isHITLApplicable(context: VerdictContext): boolean {
  return (
    context === "tool_start" ||
    context === "tool_end" ||    // ← AGE REQUIRE_APPROVAL on completed events
    context === "llm_start" ||
    context === "llm_end" ||
    context === "agent_action"
  );
}
```

---

**End result:** After all five fixes, asking "price of AAPL" with a `Block Stock Lookups` Behavior Rule configured triggers an approval dialog on the dashboard. The AGE returns `verdict: require_approval`, Core stores it with `approval_expiration_time`, and the SDK polls until a human approves or rejects.

---

### 6.4 Single handler — eliminating the duplicate send problem

**Original setup:** The agent initialised two callback handlers — a primary `handler` and a secondary `monitoredHandler` — and passed both to `AgentExecutor`. Both sent `ActivityStarted` events for every tool call, doubling the policy evaluations. Core's idempotency check meant only the *first* event was fully evaluated; the second was a no-op, but it caused confusion when debugging (two entries per event in the dashboard).

Additionally, `monitoredHandler` called `configureHookGovernance()`, which is a **module-level singleton**. Creating it second overwrote the primary handler's hook config, meaning hook-level governance was silently running on the wrong handler context.

**Fix:** The `monitoredHandler` was eliminated entirely. Signal monitoring and abort control are now configured directly on the primary handler via `createOpenBoxHandler({ enableSignalMonitor: true })`. The SDK factory handles wiring the `OpenBoxSignalMonitor` and `AbortController` internally.

References after the change:
- `handler.abortController?.signal` — passed to `executor.invoke` as the cancellation signal
- `handler.signalMonitor?.stop()` — called on SIGINT / session end
- `handler.signalMonitor?.status` — inspected for post-run diagnostics

---

### 6.4 LLM pre-refusing tools due to conversation history bias

#### The problem

When the agent's full `Human / AI` conversation history was injected into every LangChain `input` string, the LLM would read its own prior reasoning during the ReAct thought loop. A common failure mode:

1. Turn N: customer asks to `transfer $60,000`. Governance `BLOCK`s it. The LLM's `Final Answer` says *"this transfer exceeds the $50,000 compliance limit"*.
2. Turn N+1: customer asks to `transfer $60,000` again (e.g. in a fresh test run after `/api/reset`). The LLM reads the prior turn and reasons *"I already told the customer this is blocked — I won't call `transfer_funds`"* — and returns a refusal **without calling the tool at all**.

Because no tool call was made, no `ActivityStarted` event was ever sent to Core, and **the policy was never evaluated**. The governance system was bypassed entirely by the LLM's own memory.

The same issue affected the tool description itself: `transfer_funds` includes the text `"Transfers over $50,000 are blocked by compliance policy"`. Combined with history showing a prior refusal, the LLM consistently short-circuited tool execution.

#### Why the system prompt rule alone was insufficient

A `CRITICAL: You must ALWAYS call the appropriate tool` instruction was added to the system prompt. This helped in isolation but was overridden by the LLM's reasoning over raw history. The model would see the instruction *and* the prior refusal in the same context window, weight the concrete historical evidence more heavily, and still skip the tool.

#### Root cause: raw conversation turns injected into agent input

The original `runTurn` implementation in `test-agent/src/agent.ts` concatenated the full `Human / AI` turn log into the `input` field passed to `executor.invoke`:

```typescript
// BEFORE — raw history biases tool-decision reasoning
const historyText = conversationHistory
  .map((m) => `${m.role === "human" ? "Human" : "AI"}: ${m.content}`)
  .join("\n");
const enrichedInput = historyText
  ? `[Conversation so far]\n${historyText}\n\n[Customer]\n${userInput}`
  : userInput;
```

The LangChain ReAct agent uses `input` as part of the `Question:` field in its reasoning prompt. The model reads everything in `input` before deciding which tool to call. Injecting raw `AI:` turns from prior rounds — which can contain refusal text like *"this exceeds the $50,000 limit"* — directly influenced those tool-calling decisions.

#### The fix: structured session state only

Raw history was replaced with a minimal structured context object containing only the facts the agent *must* know (authentication status and customer name), with no prior AI reasoning turns:

```typescript
// AFTER — structured state, no raw history in the reasoning loop
const sessionContext = sessionAuthenticated
  ? `[Session context] Customer authenticated: ${sessionAuthenticated.customer.name} (${sessionAuthenticated.email})`
  : `[Session context] Customer not yet authenticated`;
const enrichedInput = `${sessionContext}\n\n${userInput}`;
```

The `conversationHistory` array is still maintained and reset via `POST /api/reset`, but it is **not injected into the agent prompt**. It exists purely for server-side bookkeeping.

#### What the agent retains vs. loses

| Context | Before | After |
|---|---|---|
| Knows customer is authenticated | ✅ (from history) | ✅ (from `sessionAuthenticated` state) |
| Knows customer's name | ✅ (from history) | ✅ (from `sessionAuthenticated.customer.name`) |
| Reads prior AI refusals / reasoning | ✅ — **causes pre-refusal** | ❌ — never injected |
| Multi-turn conversational continuity | ✅ | ❌ — each turn is stateless beyond auth |

The tradeoff is intentional. A banking agent does not need the LLM to remember "you asked about a loan two turns ago." It needs to know **who you are** and then act cleanly on the current request. All compliance decisions are delegated to the governance system — the LLM's job is to call tools correctly, not to pre-filter based on its own reasoning history.

#### Effect on governance test reliability

Before this fix, test 2 (transfer over $50k) would non-deterministically:
- Return `status: halt` when the LLM happened to call the tool (governance fired correctly)
- Return `status: allow` with a refusal message when the LLM skipped the tool (governance bypassed)
- Return `status: error` when the LLM's reasoning loop hit a state it couldn't resolve

After the fix, the LLM consistently calls `transfer_funds` and governance fires deterministically every time.

#### Debugging tip

If you observe the LLM skipping tool calls on known-blocked amounts, check `OPENBOX_DEBUG=1` logs for the absence of `ActivityStarted / transfer_funds` events. If the governance request is missing entirely, the LLM is pre-refusing before the tool is invoked — a history bias issue, not a governance configuration issue.

---

### 6.5 Double approval dialog for `apply_for_loan`

**Problem:** When `apply_for_loan` was invoked, two HITL approval dialogs appeared in the dashboard. This was caused by the hook-governance system sending a second `ActivityStarted` event (with `hook_trigger` present) for the same tool execution — one from the SDK's `handleToolStart` callback and one from the HTTP hook interceptor on the outbound LLM call.

**Fix:** The policy now guards all `REQUIRE_APPROVAL` and `BLOCK` rules with `not input.hook_trigger`. Hook events carry `hook_trigger` in their payload; direct SDK events do not. The guard ensures policy rules only fire on the real tool invocation, not the HTTP-level observation:

```rego
result := {"decision": "REQUIRE_APPROVAL", ...} if {
    input.event_type == "ActivityStarted"
    input.activity_type == "apply_for_loan"
    not input.hook_trigger          ← prevents hook events from triggering a second approval
}
```

---

### 6.6 Guardrail error messages

The SDK passes guardrail failure reasons through from OpenBox Core without modification. When Core's guardrail service returns a reason string (e.g., `"The following text contains PII: ..."`) the SDK surfaces it directly as `GuardrailsValidationError.message`. The agent does not add custom wrapping or truncation — the raw Core reason is what the user sees.

Guardrail types as sent by Core:

| Type string | Guardrail |
|---|---|
| `"1"` | PII Detection |
| `"2"` | Content Filtering |
| `"3"` | Toxicity |
| `"4"` | Ban Words |
| `"5"` | Regex Match (backend only) |

---

### 6.8 Double tool call on HITL rejection

#### The problem

When a policy returns `REQUIRE_APPROVAL` for `transfer_funds` and the operator **rejects** the approval on the dashboard, the tool would be called a **second time** with identical input, producing the same rejection and a confusing duplicate entry in the UI (as seen in the screenshot below).

```
3 tool calls
  authenticate_customer
  transfer_funds  → Tool error: Transfers over $5,000 require manager approval.
  transfer_funds  → Tool error: Transfers over $5,000 require manager approval.
```

The session was not halted — the LLM saw the error observation, reasoned about it, and tried the same tool again.

#### Root cause

The HITL polling for `REQUIRE_APPROVAL` on `ToolStarted` events is handled in `handleToolStart` in `sdk/src/callback-handler.ts`. When `pollUntilDecision` throws `ApprovalRejectedError` on rejection, that error propagated **uncaught** out of `handleToolStart`.

LangChain's `AgentExecutor` has a `handleToolRuntimeErrors` callback. The agent configures it to re-throw governance errors (`GovernanceHaltError`, `GovernanceBlockedError`, `GuardrailsValidationError`) — but `ApprovalRejectedError` was **not** in that list. So the executor caught it, converted it to an observation string:

```
Observation: "Tool error: Transfers over $5,000 require manager approval."
```

The LLM read that observation, concluded the transfer was blocked, and tried calling `transfer_funds` again — triggering a second HITL cycle.

The same catch-and-convert pattern was already correctly implemented in `_evaluateToolCompleted` (for `ToolCompleted` HITL) but was missing from `handleToolStart` (for `ToolStarted` HITL).

#### The fix

Wrap the `pollUntilDecision` call in `handleToolStart` with the same `try/catch` pattern used in `_evaluateToolCompleted`, converting rejection/expiry/timeout into `GovernanceHaltError`:

```typescript
// sdk/src/callback-handler.ts — handleToolStart
if (result.requiresHITL) {
  this.buffer.setPendingApproval(runId, true);
  try {
    await pollUntilDecision(
      this.client,
      { workflowId: rootRunId, runId: rootRunId, activityId: runId, activityType: toolName },
      this.config.hitl
    );
  } catch (pollErr) {
    this.buffer.setPendingApproval(runId, false);
    if (
      pollErr instanceof ApprovalRejectedError ||
      pollErr instanceof ApprovalExpiredError ||
      pollErr instanceof ApprovalTimeoutError
    ) {
      throw new GovernanceHaltError(
        (pollErr as Error).message ?? `Approval rejected for ${toolName}`
      );
    }
    throw pollErr;
  }
  this.buffer.setPendingApproval(runId, false);
}
```

`GovernanceHaltError` **is** in the `handleToolRuntimeErrors` re-throw list, so the executor propagates it up to `runTurn`'s catch block, which maps it to `{ governance: { status: "halt" } }` and halts the session. No retry, no second tool call.

#### Why `_evaluateToolCompleted` was already correct

The `ToolCompleted` path in `_evaluateToolCompleted` had this fix applied earlier (Bug 6 in §6.3). The `ToolStarted` path was missed because the two paths look similar but are handled in different methods. Both now use the identical catch pattern.

---

### 6.7 Debugging tips

| Goal | How |
|---|---|
| See every governance request/response | Set `OPENBOX_DEBUG=1` in `.env` before starting the server |
| Check exact `activity_input` wire format | `grep "activity_type.*transfer_funds" /tmp/bankbot.log` after a test call |
| Verify policy matches locally before deploying | Use the **Test** panel in the dashboard policy editor with the payloads in §2 above |
| Clear stale idempotency cache in Core | Use a fresh `workflow_id` (happens automatically each new session) |
| Reset conversation history without restarting server | Click **Reset chat** in the UI, or `POST /api/reset` |
