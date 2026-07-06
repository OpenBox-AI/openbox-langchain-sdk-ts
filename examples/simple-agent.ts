/**
 * Simplest possible LangChain TS agent wrapped with OpenBox governance.
 *
 * Run with: npx tsx examples/simple-agent.ts
 */

import 'dotenv/config';
import { ChatOpenAI } from '@langchain/openai';
import { OpenBoxLangChainMiddleware } from '../src/index';

async function main() {
  const mw = new OpenBoxLangChainMiddleware({
    apiKey: process.env.OPENBOX_API_KEY!,
    openboxUrl: process.env.OPENBOX_API_URL ?? 'https://core.openbox.ai',
    agentName: 'SimpleAgent',
    // Optional — only needed if OpenBox Core enforces signed (AIP) requests.
    agentDid: process.env.OPENBOX_AGENT_DID || undefined,
    agentPrivateKey: process.env.OPENBOX_AGENT_PRIVATE_KEY || undefined,
  });

  const model = new ChatOpenAI({
    modelName: process.env.OPENROUTER_MODEL ?? 'liquid/lfm-2.5-1.2b-instruct:free',
    apiKey: process.env.OPENROUTER_API_KEY,
    configuration: {
      baseURL: process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
    },
  });

  const messages: [string, string][] = [
    ['system', 'You are a helpful assistant.'],
    ['human', 'Say hello and name one benefit of AI governance, in one sentence.'],
  ];

  // 1. Signal governance that the agent is starting
  await mw.beforeAgent({ messages });

  // 2. Wrap the model call — governance fires LLMStarted + LLMCompleted
  const response = await mw.wrapModelCall(messages, () => model.invoke(messages));

  // 3. Signal governance that the agent completed
  await mw.afterAgent({ messages: [...messages, response] });

  console.log((response as { content: unknown }).content);
}

main().catch((err) => {
  console.error('Agent run failed:', err.message ?? err);
  process.exit(1);
});
