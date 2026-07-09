#!/usr/bin/env node
/**
 * Content Builder Agent (LangChain + OpenBox Governance)
 *
 * A content writer agent configured entirely through files on disk:
 * - AGENTS.md defines brand voice and style guide
 * - skills/ provides specialized workflows (blog posts, social media)
 * - subagents.yaml defines the researcher subagent configuration
 *
 * Usage:
 *   node examples/content-builder-agent/content-writer.ts "Write a blog post about AI agents"
 *   npm run example:content-writer -- "Create a LinkedIn post about prompt engineering"
 *
 * This is a 1:1 TypeScript port of content_writer.py from the Python SDK. A few
 * behaviors map differently because of the underlying platforms (each is noted
 * inline): the TS middleware factory is async and returns a bundle with a
 * `close()` handle, and `rich` console rendering is approximated with `chalk`.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, env } from "node:process";

import chalk from "chalk";
import yaml from "js-yaml";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { createAgent, initChatModel, tool } from "langchain";
import { HumanMessage, isAIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import { createOpenBoxLangChainMiddleware } from "openbox-langchain-governance/middleware";

// Python configures the stdlib logging module (WARNING globally, DEBUG for the
// "openbox_langchain" logger). The TS SDK exposes only a minimal warn-sink
// `logger` option, so the closest equivalent is to route SDK diagnostics to the
// console (wired into the middleware in `createContentWriter`).

const EXAMPLE_DIR = dirname(fileURLToPath(import.meta.url));

// Load environment from this example's own .env (mirrors the Python example,
// which is run from this directory so load_dotenv() picks up ./.env). Using an
// explicit path makes it work regardless of the current working directory.
loadDotenv({ quiet: true, path: join(EXAMPLE_DIR, ".env") });

/** Read a required environment variable, throwing if unset (mirrors os.environ[key]). */
function requireEnv(name: string): string {
  const value = env[name];
  if (value === undefined) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
}

// ═══════════════════════════════════════════════════════════════════
// Tools
// ═══════════════════════════════════════════════════════════════════

const webSearch = tool(
  async ({ query, max_results, topic }) => {
    try {
      const { tavily } = await import("@tavily/core");

      const apiKey = env.TAVILY_API_KEY;
      if (!apiKey) {
        return { error: "TAVILY_API_KEY not set" };
      }

      const client = tavily({ apiKey });
      return await client.search(query, { maxResults: max_results, topic });
    } catch (e) {
      return { error: `Search failed: ${String(e)}` };
    }
  },
  {
    name: "web_search",
    description: `Search the web for current information.

Args:
    query: The search query (be specific and detailed)
    max_results: Number of results to return (default: 5)
    topic: "general" for most queries, "news" for current events

Returns:
    Search results with titles, URLs, and content excerpts.`,
    schema: z.object({
      query: z.string().describe("The search query (be specific and detailed)"),
      max_results: z
        .number()
        .int()
        .default(5)
        .describe("Number of results to return (default: 5)"),
      topic: z
        .enum(["general", "news"])
        .default("general")
        .describe('"general" for most queries, "news" for current events')
    })
  }
);

const writeFile = tool(
  ({ file_path, content }) => {
    try {
      const path = join(EXAMPLE_DIR, file_path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      return `File written to ${path}`;
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
  {
    name: "write_file",
    description: `Write content to a file. Creates parent directories as needed.

Args:
    file_path: Relative path from the project root (e.g., 'blogs/my-post/post.md')
    content: The content to write`,
    schema: z.object({
      file_path: z
        .string()
        .describe(
          "Relative path from the project root (e.g., 'blogs/my-post/post.md')"
        ),
      content: z.string().describe("The content to write")
    })
  }
);

const readFile = tool(
  ({ file_path }) => {
    try {
      const path = join(EXAMPLE_DIR, file_path);
      return readFileSync(path, "utf-8");
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
  {
    name: "read_file",
    description: `Read content from a file.

Args:
    file_path: Relative path from the project root (e.g., 'research/topic.md')`,
    schema: z.object({
      file_path: z
        .string()
        .describe(
          "Relative path from the project root (e.g., 'research/topic.md')"
        )
    })
  }
);

const generateCover = tool(
  async ({ prompt, slug }) => {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      // Python's genai.Client() auto-reads GOOGLE_API_KEY/GEMINI_API_KEY from the
      // environment; the JS SDK requires an explicit key, so pass it through.
      const client = new GoogleGenAI({
        apiKey: env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? ""
      });
      const response = await client.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [prompt]
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const data = part.inlineData?.data;
        if (data) {
          const outputPath = join(EXAMPLE_DIR, "blogs", slug, "hero.png");
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, Buffer.from(data, "base64"));
          return `Image saved to ${outputPath}`;
        }
      }

      return "No image generated";
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
  {
    name: "generate_cover",
    description: `Generate a cover image for a blog post.

Args:
    prompt: Detailed description of the image to generate.
    slug: Blog post slug. Image saves to blogs/<slug>/hero.png`,
    schema: z.object({
      prompt: z
        .string()
        .describe("Detailed description of the image to generate."),
      slug: z
        .string()
        .describe("Blog post slug. Image saves to blogs/<slug>/hero.png")
    })
  }
);

const generateSocialImage = tool(
  async ({ prompt, platform, slug }) => {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const client = new GoogleGenAI({
        apiKey: env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? ""
      });
      const response = await client.models.generateContent({
        model: "gemini-2.5-flash-image",
        contents: [prompt]
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const data = part.inlineData?.data;
        if (data) {
          const outputPath = join(EXAMPLE_DIR, platform, slug, "image.png");
          mkdirSync(dirname(outputPath), { recursive: true });
          writeFileSync(outputPath, Buffer.from(data, "base64"));
          return `Image saved to ${outputPath}`;
        }
      }

      return "No image generated";
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  },
  {
    name: "generate_social_image",
    description: `Generate an image for a social media post.

Args:
    prompt: Detailed description of the image to generate.
    platform: Either "linkedin" or "tweets"
    slug: Post slug. Image saves to <platform>/<slug>/image.png`,
    schema: z.object({
      prompt: z
        .string()
        .describe("Detailed description of the image to generate."),
      platform: z.string().describe('Either "linkedin" or "tweets"'),
      slug: z
        .string()
        .describe("Post slug. Image saves to <platform>/<slug>/image.png")
    })
  }
);

// ═══════════════════════════════════════════════════════════════════
// Skill & subagent loading
// ═══════════════════════════════════════════════════════════════════

/** Load all SKILL.md files and return their combined content. */
function loadSkills(skillsDir: string): string {
  const skillFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "SKILL.md") {
        skillFiles.push(full);
      }
    }
  };
  walk(skillsDir);
  // Lexicographic by full path (matches Python's sorted(rglob("SKILL.md")) for
  // the current skills/ layout; add prefix-colliding dir names only with care).
  skillFiles.sort();
  return skillFiles
    .map((file) => readFileSync(file, "utf-8"))
    .join("\n\n---\n\n");
}

/** Load subagent definitions from YAML. */
function loadSubagentConfig(configPath: string): Record<string, unknown> {
  return (yaml.load(readFileSync(configPath, "utf-8")) ?? {}) as Record<
    string,
    unknown
  >;
}

// ═══════════════════════════════════════════════════════════════════
// Researcher subagent
// ═══════════════════════════════════════════════════════════════════

/** Create and run the researcher subagent synchronously. */
async function runResearcher(topic: string, saveTo: string): Promise<string> {
  const config = loadSubagentConfig(join(EXAMPLE_DIR, "subagents.yaml"));
  const researcherSpec = (config.researcher ?? {}) as Record<string, unknown>;
  const systemPrompt =
    typeof researcherSpec.system_prompt === "string"
      ? researcherSpec.system_prompt
      : "You are a research assistant.";
  const modelName =
    typeof researcherSpec.model === "string"
      ? researcherSpec.model
      : "openai:gpt-4o-mini";

  const model = await initChatModel(modelName, { temperature: 0 });
  const researcher = createAgent({
    model,
    tools: [webSearch, writeFile],
    systemPrompt
  });

  const taskDescription = `Research ${topic} and save findings to ${saveTo}`;
  const result = await researcher.invoke({
    messages: [new HumanMessage(taskDescription)]
  });

  // Extract last AI message as summary
  const messages = result.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg !== undefined && isAIMessage(msg)) {
      const content = msg.content;
      const hasContent =
        typeof content === "string" ? content !== "" : content.length > 0;
      if (hasContent) {
        if (typeof content === "string") {
          return `Research complete. Summary: ${content.slice(0, 300)}...`;
        }
        break;
      }
    }
  }

  return "Research complete.";
}

const research = tool(
  async ({ topic, save_to }) => {
    console.log(
      `  ${chalk.bold.magenta(">> Researching:")} ${topic.slice(0, 60)}...`
    );
    const result = await runResearcher(topic, save_to);
    console.log(`  ${chalk.green("✓ Research complete")}`);
    return result;
  },
  {
    name: "research",
    description: `Delegate research to the researcher subagent. ALWAYS use this first before writing any content.

Args:
    topic: The topic to research (be specific)
    save_to: File path to save research results (e.g., 'research/ai-agents.md')`,
    schema: z.object({
      topic: z.string().describe("The topic to research (be specific)"),
      save_to: z
        .string()
        .describe(
          "File path to save research results (e.g., 'research/ai-agents.md')"
        )
    })
  }
);

// ═══════════════════════════════════════════════════════════════════
// Main agent
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a content writer agent configured by filesystem files.
 *
 * Returns the agent plus the OpenBox middleware bundle (so the caller can
 * `close()` it). The Python version returns just the agent because its
 * middleware factory is synchronous and has no cleanup handle.
 */
async function createContentWriter() {
  // Load memory (brand voice & style guide)
  const agentsMd = readFileSync(join(EXAMPLE_DIR, "AGENTS.md"), "utf-8");

  // Load skills (blog-post, social-media workflows)
  const skillsText = loadSkills(join(EXAMPLE_DIR, "skills"));

  // Build system prompt combining memory + skills
  const systemPrompt = `${agentsMd}

## Available Skills (loaded from skills/)

${skillsText}

## Tool Usage Instructions

- Use the \`research\` tool FIRST before writing any content
- Use \`write_file\` to save content to the appropriate directory
- Use \`read_file\` to read research results before writing
- Use \`generate_cover\` for blog post cover images (saves to blogs/<slug>/hero.png)
- Use \`generate_social_image\` for social media images (saves to <platform>/<slug>/image.png)
`;

  // Create OpenBox governance middleware.
  // NOTE: Python passes `tool_type_map={"web_search": "http"}`. The TS enforcing
  // middleware has no `toolTypeMap` option (see src/middleware/options.ts), so it
  // is intentionally omitted here.
  const openbox = await createOpenBoxLangChainMiddleware({
    apiUrl: requireEnv("OPENBOX_URL"),
    apiKey: requireEnv("OPENBOX_API_KEY"),
    agentName: env.OPENBOX_AGENT_NAME ?? "ContentWriter",
    logger: console
  });

  const model = await initChatModel("openai:gpt-4o-mini", { temperature: 0 });

  const agent = createAgent({
    model,
    tools: [research, writeFile, readFile, generateCover, generateSocialImage],
    systemPrompt,
    middleware: [openbox.middleware]
  });

  return { agent, openbox };
}

// ═══════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════

/** Flatten AIMessage content (string or content-block list) into text. */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type?: unknown; text?: unknown } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text"
      )
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

/** Render content inside a titled, colored box (a stand-in for rich's Panel + Markdown). */
function printPanel(
  content: string,
  title: string,
  borderColor: "green"
): void {
  const paint = chalk[borderColor];
  const width = 68;
  console.log(
    paint(`┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}┐`)
  );
  for (const line of content.split("\n")) {
    console.log(`${paint("│")} ${line}`);
  }
  console.log(paint(`└${"─".repeat(width)}┘`));
}

/** Run the content writer agent with progress output. */
async function main(): Promise<void> {
  const cliArgs = argv.slice(2);
  const task =
    cliArgs.length > 0
      ? cliArgs.join(" ")
      : "Write a blog post about how AI agents are transforming software development";

  console.log();
  console.log(
    `${chalk.bold.blue("Content Builder Agent")} ${chalk.dim("(LangChain + OpenBox)")}`
  );
  console.log(chalk.dim(`Task: ${task}`));
  console.log();

  const { agent, openbox } = await createContentWriter();

  try {
    // Stream with governance middleware (injected via createAgent)
    let printedCount = 0;
    const stream = await agent.stream(
      { messages: [new HumanMessage(task)] },
      { streamMode: "values" }
    );

    for await (const chunk of stream) {
      const messages = (chunk as { messages?: BaseMessage[] }).messages;
      if (messages) {
        for (const msg of messages.slice(printedCount)) {
          if (isAIMessage(msg)) {
            const content = msg.content;
            const hasContent =
              typeof content === "string" ? content !== "" : content.length > 0;
            if (hasContent) {
              const text = extractText(content);
              if (text.trim() !== "") {
                printPanel(text, "Agent", "green");
              }
            }

            const toolCalls = msg.tool_calls;
            if (toolCalls && toolCalls.length > 0) {
              for (const tc of toolCalls) {
                const name = tc.name ?? "";
                if (name === "research") {
                  console.log(
                    `  >> Research: ${String(tc.args.topic ?? "").slice(0, 60)}...`
                  );
                } else if (name === "write_file") {
                  console.log(
                    `  >> Writing: ${String(tc.args.file_path ?? "")}`
                  );
                }
              }
            }
          }
        }
        printedCount = messages.length;
      }
    }

    console.log();
    console.log(chalk.bold.green("✓ Done!"));
  } finally {
    // TS-only: release the middleware runtime + instrumentation.
    await openbox.close();
  }
}

process.on("SIGINT", () => {
  console.log(chalk.yellow("\nInterrupted"));
  process.exit(130);
});

await main();
