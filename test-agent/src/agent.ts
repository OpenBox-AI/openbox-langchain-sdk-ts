/**
 * OpenBox LangChain SDK — BankBot: Bank Customer Support Agent
 *
 * A multi-turn bank support agent that showcases OpenBox governance
 * in a realistic customer service scenario:
 *
 *  GUARDRAILS  — PII redaction (email, passport, account numbers)
 *  POLICIES    — REQUIRE_APPROVAL for transfers >$5k; BLOCK for >$50k
 *  HITL        — Loan applications require human approval before processing
 *  SIGNAL MON  — Background abort if governance sends a stop signal mid-run
 *
 * Tools:
 *   authenticate_customer  — Verify customer by email + passport number
 *   get_account_summary    — Fetch balance, account type, recent transactions
 *   transfer_funds         — Move money between accounts or to external recipient
 *   apply_for_loan         — Submit a loan application (HITL-gated)
 *   get_loan_status        — Check status of an existing loan application
 *
 * Try these prompts:
 *   "Hi, my email is jane.doe@example.com and passport A12345678"   ← authentication + PII redaction
 *   "What's my account balance?"                                     ← normal flow (requires auth)
 *   "Transfer $2000 to account 9876543210"                          ← normal transfer (ALLOW)
 *   "Transfer $20000 to account 9876543210"                         ← REQUIRE_APPROVAL
 *   "Transfer $60000 to account 9876543210"                         ← BLOCK (over limit)
 *   "I'd like to apply for a $15000 personal loan"                  ← HITL approval flow
 *   "What's the status of my loan application LAP-001?"             ← status check
 */

import { ChatOpenAI } from "@langchain/openai";
import { DynamicTool } from "@langchain/core/tools";
import { AgentExecutor, createReactAgent } from "langchain/agents";
import { pull } from "langchain/hub";
import { PromptTemplate } from "@langchain/core/prompts";
import * as readline from "readline";
import * as http from "http";

import {
  createOpenBoxHandler,
  wrapTools,
  setupTelemetry,
  GovernanceBlockedError,
  GovernanceHaltError,
  GuardrailsValidationError,
  ApprovalTimeoutError,
  ApprovalRejectedError,
  type OpenBoxCallbackHandler,
} from "@openbox/langchain-sdk";

// ─── Mock data store ───────────────────────────────────────────────

interface Customer {
  name: string;
  passport: string;
  accounts: Account[];
  loanApplications: LoanApplication[];
}

interface Account {
  id: string;
  type: "checking" | "savings" | "credit";
  balance: number;
  currency: string;
  recentTransactions: Transaction[];
}

interface Transaction {
  date: string;
  description: string;
  amount: number;
}

interface LoanApplication {
  id: string;
  amount: number;
  purpose: string;
  status: "pending_review" | "approved" | "rejected" | "disbursed";
  submittedAt: string;
}

const CUSTOMERS: Record<string, Customer> = {
  "jane.doe@example.com": {
    name: "Jane Doe",
    passport: "A12345678",
    accounts: [
      {
        id: "CHK-001",
        type: "checking",
        balance: 8_420_000.50,
        currency: "USD",
        recentTransactions: [
          { date: "2026-03-10", description: "Salary deposit",        amount: +4_200.00 },
          { date: "2026-03-09", description: "Grocery Store",         amount:   -187.35 },
          { date: "2026-03-07", description: "Electric bill",         amount:   -123.00 },
          { date: "2026-03-05", description: "Online purchase",       amount:    -59.99 },
        ],
      },
      {
        id: "SAV-001",
        type: "savings",
        balance: 22_150.00,
        currency: "USD",
        recentTransactions: [
          { date: "2026-03-01", description: "Monthly auto-transfer", amount: +500.00 },
          { date: "2026-02-01", description: "Monthly auto-transfer", amount: +500.00 },
        ],
      },
    ],
    loanApplications: [
      {
        id: "LAP-001",
        amount: 15_000,
        purpose: "Home renovation",
        status: "pending_review",
        submittedAt: "2026-03-08T10:30:00Z",
      },
    ],
  },
  "john.smith@example.com": {
    name: "John Smith",
    passport: "B98765432",
    accounts: [
      {
        id: "CHK-002",
        type: "checking",
        balance: 3_210_750.75,
        currency: "USD",
        recentTransactions: [
          { date: "2026-03-10", description: "Salary deposit",  amount: +3_500.00 },
          { date: "2026-03-08", description: "Rent payment",    amount: -1_800.00 },
          { date: "2026-03-06", description: "Restaurant",      amount:    -48.50 },
        ],
      },
    ],
    loanApplications: [],
  },
};

// Session-scoped auth state (one per server request, reset each turn)
let sessionAuthenticated: { email: string; customer: Customer } | null = null;

// ─── Tools ────────────────────────────────────────────────────────

const authenticateCustomerTool = new DynamicTool({
  name: "authenticate_customer",
  description:
    "Verify a customer's identity using their email address and passport number. " +
    'Input: a JSON string with fields: { "email": "jane.doe@example.com", "passport": "A12345678" }. ' +
    "Always call this tool first before accessing any account information.",
  func: async (input: string) => {
    try {
      const { email, passport } = JSON.parse(input) as { email: string; passport: string };
      const customer = CUSTOMERS[email.toLowerCase().trim()];
      if (!customer) {
        console.log(`  [authenticate_customer] unknown email: ${email}`);
        return "Authentication failed: no account found for that email address.";
      }
      if (customer.passport.toUpperCase() !== passport.toUpperCase().trim()) {
        console.log(`  [authenticate_customer] passport mismatch for ${email}`);
        return "Authentication failed: passport number does not match our records.";
      }
      sessionAuthenticated = { email: email.toLowerCase().trim(), customer };
      console.log(`  [authenticate_customer] ✓ ${customer.name} authenticated`);
      return `Authentication successful. Welcome, ${customer.name}! You have ${customer.accounts.length} account(s) on file.`;
    } catch (_) {
      return 'Error parsing input. Expected JSON like: { "email": "jane.doe@example.com", "passport": "A12345678" }';
    }
  },
});

const getAccountSummaryTool = new DynamicTool({
  name: "get_account_summary",
  description:
    "Retrieve the authenticated customer's account balances and recent transactions. " +
    'Input: account ID to fetch a specific account (e.g. "CHK-001"), or "all" / empty string for all accounts. ' +
    "Customer must be authenticated first.",
  func: async (input: string) => {
    if (!sessionAuthenticated) {
      return "You must authenticate first. Please provide your email and passport number.";
    }
    const { customer } = sessionAuthenticated;
    const query = input.trim().toUpperCase();
    const accounts = query === "" || query === "ALL"
      ? customer.accounts
      : customer.accounts.filter((a) => a.id.toUpperCase() === query);

    if (accounts.length === 0) {
      return `No account found with ID "${input}". Available accounts: ${customer.accounts.map((a) => a.id).join(", ")}.`;
    }

    const lines: string[] = [];
    for (const acct of accounts) {
      lines.push(`Account ${acct.id} (${acct.type.toUpperCase()})`);
      lines.push(`  Balance   : $${acct.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
      lines.push(`  Currency  : ${acct.currency}`);
      lines.push(`  Recent transactions:`);
      for (const tx of acct.recentTransactions.slice(0, 4)) {
        const sign = tx.amount >= 0 ? "+" : "";
        lines.push(`    ${tx.date}  ${tx.description.padEnd(28)} ${sign}$${Math.abs(tx.amount).toFixed(2)}`);
      }
      lines.push("");
    }
    console.log(`  [get_account_summary] fetched ${accounts.length} account(s) for ${customer.name}`);
    return lines.join("\n").trim();
  },
});

const transferFundsTool = new DynamicTool({
  name: "transfer_funds",
  description:
    "Transfer money from the customer's account to another account or external recipient. " +
    "Input: a JSON string with fields: " +
    '{ "from_account": "CHK-001", "to_account": "9876543210", "amount": 500, "currency": "USD", "memo": "optional note" }. ' +
    "Transfers over $5,000 require manager approval. Transfers over $50,000 are blocked by compliance policy. " +
    "Customer must be authenticated first.",
  func: async (input: string) => {
    if (!sessionAuthenticated) {
      return "You must authenticate first. Please provide your email and passport number.";
    }
    try {
      const { customer } = sessionAuthenticated;
      const req = JSON.parse(input) as {
        from_account: string;
        to_account: string;
        amount: number;
        currency?: string;
        memo?: string;
      };
      const currency = req.currency ?? "USD";
      const sourceAcct = customer.accounts.find((a) => a.id.toUpperCase() === req.from_account.toUpperCase());
      if (!sourceAcct) {
        return `Account "${req.from_account}" not found. Available: ${customer.accounts.map((a) => a.id).join(", ")}.`;
      }
      if (sourceAcct.balance < req.amount) {
        return `Insufficient funds. Account ${sourceAcct.id} balance is $${sourceAcct.balance.toFixed(2)}, but transfer amount is $${req.amount.toFixed(2)}.`;
      }

      // Deduct balance (mock)
      sourceAcct.balance -= req.amount;
      const refId = `TXN-${Date.now().toString(36).toUpperCase()}`;
      console.log(`  [transfer_funds] $${req.amount} ${currency} from ${sourceAcct.id} → ${req.to_account}`);
      return [
        `Transfer completed successfully.`,
        `  Reference   : ${refId}`,
        `  From account: ${sourceAcct.id}`,
        `  To account  : ...${req.to_account.slice(-4)}`,
        `  Amount      : ${currency} ${req.amount.toLocaleString()}`,
        `  Memo        : ${req.memo ?? "—"}`,
        `  New balance : $${sourceAcct.balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
        `  Status      : COMPLETED`,
      ].join("\n");
    } catch (_) {
      return 'Error parsing input. Expected JSON like: { "from_account": "CHK-001", "to_account": "9876543210", "amount": 500 }';
    }
  },
});

const applyForLoanTool = new DynamicTool({
  name: "apply_for_loan",
  description:
    "Submit a loan application on behalf of the authenticated customer. " +
    "Input: a JSON string with fields: " +
    '{ "amount": 15000, "purpose": "Home renovation", "term_months": 36 }. ' +
    "All loan applications require human approval before processing. " +
    "Customer must be authenticated first.",
  func: async (input: string) => {
    if (!sessionAuthenticated) {
      return "You must authenticate first. Please provide your email and passport number.";
    }
    try {
      const { customer } = sessionAuthenticated;
      const req = JSON.parse(input) as {
        amount: number;
        purpose: string;
        term_months?: number;
      };
      const termMonths = req.term_months ?? 36;
      const appId = `LAP-${Date.now().toString(36).toUpperCase()}`;
      const newApp: LoanApplication = {
        id: appId,
        amount: req.amount,
        purpose: req.purpose,
        status: "pending_review",
        submittedAt: new Date().toISOString(),
      };
      customer.loanApplications.push(newApp);
      console.log(`  [apply_for_loan] ${customer.name} applied for $${req.amount} — ${req.purpose}`);
      return [
        `Loan application submitted successfully.`,
        `  Application ID : ${appId}`,
        `  Amount         : $${req.amount.toLocaleString()}`,
        `  Purpose        : ${req.purpose}`,
        `  Term           : ${termMonths} months`,
        `  Est. monthly   : $${(req.amount / termMonths).toFixed(2)}`,
        `  Status         : PENDING REVIEW`,
        `  Note           : A loan officer will review your application within 2 business days.`,
      ].join("\n");
    } catch (_) {
      return 'Error parsing input. Expected JSON like: { "amount": 15000, "purpose": "Home renovation", "term_months": 36 }';
    }
  },
});

const getLoanStatusTool = new DynamicTool({
  name: "get_loan_status",
  description:
    "Check the status of one or all loan applications for the authenticated customer. " +
    'Input: a loan application ID like "LAP-001", or "all" to see all applications. ' +
    "Customer must be authenticated first.",
  func: async (input: string) => {
    if (!sessionAuthenticated) {
      return "You must authenticate first. Please provide your email and passport number.";
    }
    const { customer } = sessionAuthenticated;
    if (customer.loanApplications.length === 0) {
      return "No loan applications found on your account.";
    }
    const query = input.trim().toUpperCase();
    const apps = query === "" || query === "ALL"
      ? customer.loanApplications
      : customer.loanApplications.filter((a) => a.id.toUpperCase() === query);

    if (apps.length === 0) {
      return `No loan application found with ID "${input}".`;
    }

    const STATUS_LABEL: Record<string, string> = {
      pending_review: "⏳ PENDING REVIEW",
      approved:       "✅ APPROVED",
      rejected:       "❌ REJECTED",
      disbursed:      "💰 DISBURSED",
    };

    return apps.map((a) => [
      `Application ${a.id}`,
      `  Amount    : $${a.amount.toLocaleString()}`,
      `  Purpose   : ${a.purpose}`,
      `  Status    : ${STATUS_LABEL[a.status] ?? a.status.toUpperCase()}`,
      `  Submitted : ${new Date(a.submittedAt).toLocaleDateString("en-US", { dateStyle: "medium" })}`,
    ].join("\n")).join("\n\n");
  },
});

const getStockPriceTool = new DynamicTool({
  name: "get_stock_price",
  description:
    "Look up the current stock price for a publicly traded company. " +
    'Input: a ticker symbol like "AAPL", "MSFT", "TSLA", "NVDA". ' +
    "No authentication required. Use this to help customers check investment-related information.",
  func: async (input: string) => {
    const ticker = input.trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, "");
    if (!ticker) return "Please provide a valid ticker symbol (e.g. AAPL, MSFT, TSLA).";

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });

      if (!res.ok) {
        return `Could not fetch stock data for "${ticker}". HTTP ${res.status}. Check the ticker symbol and try again.`;
      }

      const data = await res.json() as {
        chart?: {
          result?: Array<{
            meta?: {
              regularMarketPrice?: number;
              previousClose?: number;
              currency?: string;
              longName?: string;
              exchangeName?: string;
            };
          }>;
          error?: { description?: string };
        };
      };

      const result = data?.chart?.result?.[0];
      if (!result) {
        const errMsg = data?.chart?.error?.description ?? "No data returned";
        return `Ticker "${ticker}" not found: ${errMsg}.`;
      }

      const meta = result.meta ?? {};
      const price = meta.regularMarketPrice;
      const prevClose = meta.previousClose;
      const currency = meta.currency ?? "USD";
      const name = meta.longName ?? ticker;
      const exchange = meta.exchangeName ?? "";

      if (price == null) return `No price data available for "${ticker}".`;

      const change = prevClose != null ? price - prevClose : null;
      const changePct = prevClose != null ? ((price - prevClose) / prevClose) * 100 : null;
      const sign = change != null && change >= 0 ? "+" : "";

      const lines = [
        `${name} (${ticker}) — ${exchange}`,
        `  Price    : ${currency} ${price.toFixed(2)}`,
      ];
      if (change != null && changePct != null) {
        lines.push(`  Change   : ${sign}${change.toFixed(2)} (${sign}${changePct.toFixed(2)}%)`);
      }
      console.log(`  [get_stock_price] ${ticker} = ${currency} ${price.toFixed(2)}`);
      return lines.join("\n");
    } catch (err) {
      return `Failed to retrieve stock price for "${ticker}": ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env["OPENAI_API_KEY"];
  const openboxUrl = process.env["OPENBOX_URL"];
  const openboxApiKey = process.env["OPENBOX_API_KEY"];

  if (!apiKey) { console.error("Error: OPENAI_API_KEY is required."); process.exit(1); }
  if (!openboxUrl) { console.error("Error: OPENBOX_URL is required."); process.exit(1); }
  if (!openboxApiKey) { console.error("Error: OPENBOX_API_KEY is required."); process.exit(1); }

  // ── Banner ──────────────────────────────────────────────────────
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║        BankBot — Customer Support Agent (OpenBox)        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`OpenBox : ${openboxUrl}`);
  console.log(`Key     : ${openboxApiKey.slice(0, 10)}...`);
  console.log("");
  console.log("Governance features active:");
  console.log("  • Guardrails  — PII redaction (email, passport, account numbers)");
  console.log("  • Policies    — REQUIRE_APPROVAL >$5k transfer / BLOCK >$50k");
  console.log("  • HITL        — Loan applications require human approval");
  console.log("  • Signal mon  — Background policy checks abort mid-run on HALT");
  console.log("");
  console.log("Test accounts:");
  console.log("  Email: jane.doe@example.com  Passport: A12345678");
  console.log("  Email: john.smith@example.com  Passport: B98765432");
  console.log("");
  console.log("Try:");
  console.log('  "Hi, my email is jane.doe@example.com and passport is A12345678"');
  console.log('  "What is my account balance?"');
  console.log('  "Transfer $2000 to account 9876543210"       ← normal, ALLOW');
  console.log('  "Transfer $20000 to account 9876543210"      ← REQUIRE_APPROVAL');
  console.log('  "Transfer $60000 to account 9876543210"      ← BLOCK');
  console.log('  "I would like a $15000 personal loan"        ← HITL approval');
  console.log('  "Check status of my loan application"');
  console.log('  "What is the price of AAPL?"                ← real HTTP GET (Behavior Rules)');
  console.log('  Type "exit" or "quit" to end the session.');
  console.log("");

  // ── Telemetry ──────────────────────────────────────────────────
  const spanCollector = setupTelemetry({ patchFetchEnabled: true });
  console.log("✓ HTTP telemetry enabled");

  // ── OpenBox handler ────────────────────────────────────────────
  let handler: OpenBoxCallbackHandler;
  try {
    handler = await createOpenBoxHandler({
      apiUrl: openboxUrl,
      apiKey: openboxApiKey,
      validate: true,
      onApiError: "fail_open",
      sendChainStartEvent: true,
      sendChainEndEvent: true,
      sendToolStartEvent: true,
      sendToolEndEvent: true,
      sendLLMStartEvent: true,
      sendLLMEndEvent: true,
      hitl: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxWaitMs: 300_000,
      },
      spanCollector,
      enableSignalMonitor: true,
      signalMonitorConfig: {
        pollIntervalMs: 5_000,
        maxDurationMs: 3_600_000,
      },
    });
    console.log("✓ OpenBox governance handler ready");
  } catch (err) {
    console.error("✗ Failed to initialise OpenBox handler:", err);
    process.exit(1);
  }

  // ── Tools ──────────────────────────────────────────────────────
  const tools = [
    authenticateCustomerTool,
    getAccountSummaryTool,
    transferFundsTool,
    applyForLoanTool,
    getLoanStatusTool,
    getStockPriceTool,
  ];
  const governedTools = wrapTools(tools, handler);
  console.log(`✓ ${governedTools.length} tools wrapped with governance`);

  // ── LLM ───────────────────────────────────────────────────────
  const llm = new ChatOpenAI({
    model: "gpt-4o-mini",
    temperature: 0,
    openAIApiKey: apiKey,
  });

  // ── Prompt ────────────────────────────────────────────────────
  const SYSTEM_PROMPT = `You are BankBot, a helpful and professional bank customer support agent for OpenBox Bank. You assist customers with account inquiries, fund transfers, and loan applications.

IMPORTANT RULES:
1. Always authenticate the customer first using their email and passport number before performing any account operations.
2. Never share or repeat passport numbers, full account numbers, or other sensitive PII in your responses.
3. For transfers, clearly confirm the amount and destination before proceeding.
4. For loan applications, collect the amount, purpose, and preferred term before submitting.
5. Be concise and professional. Use exact numbers from tool results.
6. CRITICAL: You must ALWAYS call the appropriate tool to perform an action. Never refuse or block a request yourself — the governance system will handle compliance decisions. If a customer asks to transfer funds, you MUST call transfer_funds. If a customer asks to apply for a loan, you MUST call apply_for_loan. Do not pre-emptively refuse based on conversation history.

You have access to the following tools:

{tools}

Use the following format:

Question: the input question you must answer
Thought: you should always think about what to do
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action
Observation: the result of the action
... (this Thought/Action/Action Input/Observation can repeat N times)
Thought: I now know the final answer
Final Answer: the final answer to the original input question

Begin!

Question: {input}
Thought:{agent_scratchpad}`;

  let prompt: PromptTemplate;
  try {
    prompt = await pull<PromptTemplate>("hwchase17/react");
    console.log("✓ ReAct prompt loaded from LangChain Hub");
  } catch (_) {
    prompt = PromptTemplate.fromTemplate(SYSTEM_PROMPT);
    console.log("✓ ReAct prompt loaded (local)");
  }

  // ── Agent executor ────────────────────────────────────────────
  const agent = await createReactAgent({ llm, tools: governedTools, prompt });
  const executor = new AgentExecutor({
    agent,
    tools: governedTools,
    callbacks: [handler],
    verbose: false,
    maxIterations: 10,
    returnIntermediateSteps: true,
    handleToolRuntimeErrors: (e: unknown) => {
      // Re-throw governance errors so they propagate to runTurn's catch block
      // instead of being converted to empty observations by the executor.
      if (
        e instanceof GovernanceHaltError ||
        e instanceof GovernanceBlockedError ||
        e instanceof GuardrailsValidationError
      ) {
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      return `Tool error: ${msg}`;
    },
  });

  const conversationHistory: Array<{ role: "human" | "ai"; content: string }> = [];

  // ── Shared: run one turn ───────────────────────────────────────
  async function runTurn(userInput: string): Promise<{
    output: string;
    governance?: { status: string; reason?: string };
    steps: Array<{ tool: string; input: string; output: string }>;
    stepCount: number;
  }> {
    // Inject only structured session state — NOT raw conversation turns.
    // Raw history causes the LLM to read its own prior reasoning and pre-refuse
    // tool calls (e.g. seeing a prior "$60k blocked" message and skipping the tool).
    // Structured state gives the agent the context it needs (auth status, customer
    // name) without influencing its tool-decision reasoning with prior refusals.
    const sessionContext = sessionAuthenticated
      ? `[Session context] Customer authenticated: ${sessionAuthenticated.customer.name} (${sessionAuthenticated.email})`
      : `[Session context] Customer not yet authenticated`;
    const enrichedInput = `${sessionContext}\n\n${userInput}`;

    try {
      const result = await executor.invoke(
        { input: enrichedInput },
        { callbacks: [handler], signal: handler.abortController?.signal }
      );

      const output: string = result.output ?? "(no response)";
      conversationHistory.push({ role: "human", content: userInput });
      conversationHistory.push({ role: "ai", content: output });
      // Note: conversationHistory is kept for session reset/display but is NOT
      // injected into the agent prompt — see enrichedInput above.

      const steps = (result.intermediateSteps ?? []).map((s: any) => ({
        tool: s.action?.tool ?? "unknown",
        input: typeof s.action?.toolInput === "string"
          ? s.action.toolInput
          : JSON.stringify(s.action?.toolInput ?? ""),
        output: String(s.observation ?? ""),
      }));

      return { output, governance: { status: "allow" }, steps, stepCount: steps.length };

    } catch (err) {
      if (err instanceof GovernanceHaltError) {
        return {
          output: `This session has been terminated by our compliance system: ${err.message}`,
          governance: { status: "halt", reason: err.message },
          steps: [], stepCount: 0,
        };
      }
      if (err instanceof GovernanceBlockedError) {
        return {
          output: `I'm unable to process this request: ${err.message}`,
          governance: { status: "blocked", reason: err.message },
          steps: [], stepCount: 0,
        };
      }
      if (err instanceof GuardrailsValidationError) {
        const reason = err.reasons.join("; ");
        return {
          output: reason,
          governance: { status: "guardrails", reason },
          steps: [], stepCount: 0,
        };
      }
      if (err instanceof ApprovalTimeoutError) {
        return {
          output: "This request requires approval but the approval window has expired. Please contact your branch directly.",
          governance: { status: "hitl_timeout" },
          steps: [], stepCount: 0,
        };
      }
      if (err instanceof ApprovalRejectedError) {
        return {
          output: `This request was reviewed and declined by our team. ${err.message ?? ""}`.trim(),
          governance: { status: "hitl_rejected", reason: err.message },
          steps: [], stepCount: 0,
        };
      }
      if (err instanceof Error && err.name === "AbortError") {
        const cause = (err as Error & { cause?: unknown }).cause;
        if (cause instanceof GovernanceHaltError) {
          return {
            output: `Session terminated by compliance signal: ${cause.message}`,
            governance: { status: "halt", reason: cause.message },
            steps: [], stepCount: 0,
          };
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `I encountered an error: ${msg}`, governance: { status: "error", reason: msg }, steps: [], stepCount: 0 };
    }
  }

  // ── Mode selection ─────────────────────────────────────────────
  const serverMode =
    process.env["SERVER_MODE"] === "true" ||
    process.argv.includes("--server");

  if (serverMode) {
    let sessionHalted = false;

    const server = http.createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const url = new URL(req.url ?? "/", `http://localhost`);

      if (req.method === "GET" && url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, sessionHalted }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        conversationHistory.length = 0;
        sessionAuthenticated = null;
        sessionHalted = false;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chat") {
        if (sessionHalted) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            output: "This session has been terminated. Please start a new session.",
            governance: { status: "halt" },
            steps: [], stepCount: 0,
          }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", async () => {
          try {
            const { message } = JSON.parse(body) as { message: string };
            console.log(`\n[Customer] ${message}`);
            const turn = await runTurn(message);
            if (turn.governance?.status === "halt") sessionHalted = true;
            console.log(`[BankBot] ${turn.output.slice(0, 120)}${turn.output.length > 120 ? "…" : ""}`);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(turn));
          } catch (_) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad request" }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    const PORT = parseInt(process.env["PORT"] ?? "3141", 10);
    server.listen(PORT, () => {
      console.log("\n" + "═".repeat(62));
      console.log(`BankBot HTTP server listening on http://localhost:${PORT}`);
      console.log("Open the chat UI: cd ui && npm install && npm run dev");
      console.log("═".repeat(62));
    });

    process.on("SIGINT", () => {
      handler.signalMonitor?.stop();
      server.close();
      console.log("\nServer shut down.");
      process.exit(0);
    });

  } else {
    // ── Interactive readline REPL ────────────────────────────────
    console.log("\n" + "═".repeat(62));
    console.log("Session started. How can BankBot help you today?");
    console.log("═".repeat(62) + "\n");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    const question = (p: string): Promise<string> =>
      new Promise((resolve) => rl.question(p, resolve));

    let sessionHalted = false;

    while (!sessionHalted) {
      let userInput: string;
      try {
        userInput = (await question("You: ")).trim();
      } catch {
        break;
      }

      if (!userInput) continue;
      if (["exit", "quit", "bye"].includes(userInput.toLowerCase())) {
        console.log("\nBankBot: Goodbye!\n");
        break;
      }

      console.log("\nBankBot: thinking...\n");
      const turn = await runTurn(userInput);
      console.log(`BankBot: ${turn.output}`);
      if (turn.stepCount) {
        console.log(`        (${turn.stepCount} tool call${turn.stepCount !== 1 ? "s" : ""})`);
      }
      if (turn.governance && turn.governance.status !== "allow") {
        console.log(`        [${turn.governance.status.toUpperCase()}] ${turn.governance.reason ?? ""}`);
      }
      if (turn.governance?.status === "halt") {
        sessionHalted = true;
        console.error("\nSession terminated by compliance policy. Exiting.\n");
        break;
      }
      console.log("");
    }

    handler.signalMonitor?.stop();
    rl.close();

    const status = handler.signalMonitor?.status;
    console.log("─".repeat(62));
    if (status?.aborted) {
      console.log(`Signal monitor: aborted after ${status.pollCount} poll(s) — ${status.abortVerdict}`);
    } else {
      console.log(`Signal monitor: ${status?.pollCount ?? 0} poll(s), no stop signal.`);
    }
    console.log("Session ended.");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
