# Content Builder Agent

A content writing agent for writing blog posts, LinkedIn posts, and tweets with cover images included.

**This example demonstrates how to use LangChain with OpenBox governance through three filesystem primitives:**

- **Memory** (`AGENTS.md`) – persistent context like brand voice and style guidelines
- **Skills** (`skills/*/SKILL.md`) – workflows for specific tasks, loaded on demand
- **Subagents** (`subagents.yaml`) – specialized agents for delegated tasks like research

The `content-writer.ts` script shows how to combine these into a working agent using LangChain with OpenBox governance. It is a 1:1 TypeScript port of `content_writer.py` from the Python SDK.

## Quick Start

```bash
# Set API keys
export OPENAI_API_KEY="..."
export OPENBOX_URL="https://core.openbox.ai"
export OPENBOX_API_KEY="obx_live_..."
export OPENBOX_AGENT_DID="did:aip:..."          # Required by default for newly registered agents
export OPENBOX_AGENT_PRIVATE_KEY="..."          # Required by default for newly registered agents
export GOOGLE_API_KEY="..."      # For image generation
export TAVILY_API_KEY="..."      # For web search (optional)

# Install deps (from the repo root) and build the SDK once
npm install
npm run build

# Run
npm run example:content-writer -- "Write a blog post about prompt engineering"
```

The script reads a `.env` file in this directory (via `dotenv`), so you can put the
keys there instead of exporting them.

**More examples:**

```bash
npm run example:content-writer -- "Create a LinkedIn post about AI agents"
npm run example:content-writer -- "Write a Twitter thread about the future of coding"

# Or run the file directly (Node >= 24 strips TypeScript natively):
node examples/content-builder-agent/content-writer.ts "Write a blog post about prompt engineering"
```

OpenBox enables DID signing by default for newly registered agents. If signing
has been explicitly disabled for this agent in OpenBox, you can omit
`OPENBOX_AGENT_DID` and `OPENBOX_AGENT_PRIVATE_KEY`.

## How It Works

The agent is configured by files on disk, not code:

```
content-builder-agent/
├── AGENTS.md                    # Brand voice & style guide
├── subagents.yaml               # Subagent definitions
├── skills/
│   ├── blog-post/
│   │   └── SKILL.md             # Blog writing workflow
│   └── social-media/
│       └── SKILL.md             # Social media workflow
└── content-writer.ts            # Wires it together (includes tools)
```

| File                | Purpose                              | When Loaded                        |
| ------------------- | ------------------------------------ | ---------------------------------- |
| `AGENTS.md`         | Brand voice, tone, writing standards | Always (system prompt)             |
| `subagents.yaml`    | Research subagent config             | When research tool runs            |
| `skills/*/SKILL.md` | Content-specific workflows           | Always (appended to system prompt) |

## Architecture

```ts
// Load memory + skills into system prompt
const agentsMd = readFileSync(join(EXAMPLE_DIR, "AGENTS.md"), "utf-8");
const skillsText = loadSkills(join(EXAMPLE_DIR, "skills"));

// Create OpenBox governance middleware (async: returns a bundle with close())
const openbox = await createOpenBoxLangChainMiddleware({
  apiUrl: requireEnv("OPENBOX_URL"),
  apiKey: requireEnv("OPENBOX_API_KEY"),
  agentName: "ContentWriter"
});

// Create agent with middleware
const model = await initChatModel("openai:gpt-4o-mini", { temperature: 0 });
const agent = createAgent({
  model,
  tools: [research, writeFile, readFile, generateCover, generateSocialImage],
  systemPrompt: agentsMd + skillsText,
  middleware: [openbox.middleware]
});

// Run with governance applied automatically
const result = await agent.invoke({ messages: [new HumanMessage(task)] });
```

**Flow:**

1. Agent receives task → loads relevant skill (blog-post or social-media)
2. Calls `research` tool → spawns researcher subagent → saves to `research/`
3. Reads research findings → writes content → saves to `blogs/` or `linkedin/`
4. Generates cover image with Gemini → saves alongside content

## Output

```
blogs/
└── prompt-engineering/
    ├── post.md       # Blog content
    └── hero.png      # Generated cover image

linkedin/
└── ai-agents/
    ├── post.md       # Post content
    └── image.png     # Generated image

research/
└── prompt-engineering.md   # Research notes
```

## Customizing

**Change the voice:** Edit `AGENTS.md` to modify brand tone and style.

**Add a content type:** Create `skills/<name>/SKILL.md` with YAML frontmatter:

```yaml
---
name: newsletter
description: Use this skill when writing email newsletters
---
# Newsletter Skill
...
```

**Add a subagent:** Add to `subagents.yaml`:

```yaml
editor:
  description: Review and improve drafted content
  model: openai:gpt-4o-mini
  system_prompt: |
    You are an editor. Review the content and suggest improvements...
  tools: []
```

**Add a tool:** Define it in `content-writer.ts` with the `tool(...)` helper and add to the `createAgent({ tools: [...] })` list.

## Notes on the TypeScript Port

This example mirrors `content_writer.py` function-for-function. A few behaviors
map differently because of the underlying platforms:

| Aspect             | Python                                                            | TypeScript                                                                                                   |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Middleware factory | `create_openbox_langchain_middleware(...)` returns the middleware | `createOpenBoxLangChainMiddleware(...)` is **async** and returns a bundle `{ middleware, runtime, close() }` |
| Tool type map      | `tool_type_map={"web_search": "http"}`                            | Not available on the enforcing middleware — omitted                                                          |
| Console output     | `rich` Console / Panel / Markdown                                 | `chalk` colors + a simple `printPanel` box                                                                   |
| Model init         | `init_chat_model("openai:gpt-4o-mini", temperature=0)`            | `initChatModel("openai:gpt-4o-mini", { temperature: 0 })`                                                    |
| Web search         | `tavily-python`                                                   | `@tavily/core`                                                                                               |
| Image gen          | `google-genai` (`genai.Client()` auto-reads env key)              | `@google/genai` (`new GoogleGenAI({ apiKey })`)                                                              |

## Requirements

- Node.js 24.10+ (native TypeScript execution)
- `OPENAI_API_KEY` - For the main agent (GPT-4o-mini)
- `OPENBOX_URL` + `OPENBOX_API_KEY` - For OpenBox governance
- `GOOGLE_API_KEY` - For image generation (Gemini)
- `TAVILY_API_KEY` - For web search (optional, research still works without it)
