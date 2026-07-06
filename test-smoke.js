/**
 * Span test — run with: node test-smoke.js
 *
 * Makes a REAL LLM call via OpenRouter so the HTTP span interceptor fires,
 * generating LLMStarted + http_request spans + LLMCompleted on the dashboard.
 * Also runs a simulated tool call to produce ToolStarted + ToolCompleted spans.
 */

require('dotenv').config();
const { OpenBoxLangChainMiddleware } = require('./dist/index');
const https = require('https');

// ── Minimal OpenRouter call (no LangChain dependency needed) ──────────────────

function callOpenRouter(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: process.env.OPENROUTER_MODEL ?? 'liquid/lfm-2.5-1.2b-instruct:free',
      messages: [
        { role: 'system', content: 'You are a concise assistant.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 80,
    });

    const req = https.request(
      {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed?.choices?.[0]?.message?.content ?? data);
          } catch {
            resolve(data);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.OPENBOX_API_KEY;
  const openboxUrl = process.env.OPENBOX_API_URL ?? 'https://core.openbox.ai';
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    console.error('❌  OPENBOX_API_KEY is not set in .env');
    process.exit(1);
  }
  if (!openrouterKey) {
    console.error('❌  OPENROUTER_API_KEY is not set in .env — needed for real LLM spans');
    process.exit(1);
  }

  const agentDid = process.env.OPENBOX_AGENT_DID;
  const agentPrivateKey = process.env.OPENBOX_AGENT_PRIVATE_KEY;

  console.log(`OpenBox:    ${openboxUrl}`);
  console.log(`Agent DID:  ${agentDid ?? '(none)'}`);
  console.log(`LLM model:  ${process.env.OPENROUTER_MODEL ?? 'liquid/lfm-2.5-1.2b-instruct:free'}`);

  const mw = new OpenBoxLangChainMiddleware({
    apiKey,
    openboxUrl,
    agentName: 'SpanTestAgent',
    onApiError: 'fail_open',
    agentDid,
    agentPrivateKey,
  });

  const userPrompt = 'Summarize the benefits of cloud computing in 2 sentences.';
  const messages = [
    { role: 'system', content: 'You are a concise assistant.' },
    { role: 'user',   content: userPrompt },
  ];

  // ── [1] beforeAgent → SignalReceived + WorkflowStarted ───────────────────
  console.log('\n[1] beforeAgent...');
  await mw.beforeAgent({ messages }, 'span-test-thread');
  console.log(`    workflow_id = ${mw._workflowId}`);

  // ── [2] wrapModelCall → LLMStarted + http_request span + LLMCompleted ───
  console.log('\n[2] wrapModelCall (real LLM call via OpenRouter)...');
  let llmResponse;
  try {
    llmResponse = await mw.wrapModelCall(messages, () => callOpenRouter(userPrompt));
    console.log(`    LLM response: "${String(llmResponse).slice(0, 120)}"`);
  } catch (err) {
    console.warn('    wrapModelCall error (governance may have blocked):', err.message);
  }

  // ── [3] wrapToolCall → ToolStarted + ToolCompleted ───────────────────────
  console.log('\n[3] wrapToolCall (simulated web_search tool)...');
  try {
    const toolResult = await mw.wrapToolCall(
      'web_search',
      { query: 'AI governance frameworks 2025' },
      async () => {
        // Simulate tool latency
        await new Promise((r) => setTimeout(r, 200));
        return { results: ['OpenBox', 'NIST AI RMF', 'EU AI Act'] };
      },
    );
    console.log(`    Tool result: ${JSON.stringify(toolResult)}`);
  } catch (err) {
    console.warn('    wrapToolCall error:', err.message);
  }

  // ── [4] afterAgent → WorkflowCompleted ───────────────────────────────────
  console.log('\n[4] afterAgent...');
  const finalMessages = [
    ...messages,
    { role: 'assistant', content: String(llmResponse ?? '') },
  ];
  const verdict = await mw.afterAgent({ messages: finalMessages });
  console.log(`    Final verdict: ${verdict?.verdict ?? 'null'} (risk_score: ${verdict?.risk_score ?? 'n/a'})`);

  console.log('\n✅  Done — check your OpenBox dashboard for:');
  console.log('    • 1 Signal (user_prompt)');
  console.log('    • 1 LLM Call (LLMStarted → http_request span → LLMCompleted)');
  console.log('    • 1 Tool Exec (ToolStarted → ToolCompleted)');
  console.log('    • WorkflowCompleted');
}

main().catch((err) => {
  console.error('\n❌  Test failed:', err.message ?? err);
  process.exit(1);
});
