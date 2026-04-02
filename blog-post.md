---
title: Build and Deploy a Conversational AI Agent on Harper
published: false
description: Build a chat agent with persistent semantic memory using Harper, Claude, and about 100 lines of JavaScript. No glue code required.
tags: ai, agents, harperdb, javascript
---

If you've built an AI agent before, you know the drill: spin up a database for conversation history, bolt on a vector store for semantic search, wire up an API server, add a caching layer so it doesn't crawl, and then figure out how to deploy the whole thing. Five services, five sets of credentials, and a weekend gone.

What if your entire agent backend — database, vector search, caching, API, and deployment — was one thing?

That's [Harper](https://harper.fast). In this tutorial, we'll build a conversational AI agent with persistent semantic memory in about 100 lines of JavaScript and deploy it globally with a single command.

## What We're Building

A conversational assistant powered by Claude that:

- **Persists every conversation** in Harper's database
- **Embeds every message** as a vector for semantic recall
- **Searches past conversations** automatically to give Claude relevant context
- **Exposes a single REST endpoint** — `POST /Agent` — that handles the entire agent loop

When you ask it a question it discussed three conversations ago, it remembers. All backed by Harper's built-in HNSW vector index — no Pinecone, no Weaviate, no extra service.

## Prerequisites

- Node.js 22+
- An [Anthropic API key](https://console.anthropic.com/) (for Claude)

That's it. Embeddings run locally — no second API key required.

Install the Harper CLI:

```bash
npm install -g harperdb
```

## Step 1: Scaffold the Project

```bash
mkdir agent-example-harper && cd agent-example-harper
npm init -y
npm install @anthropic-ai/sdk harper-fabric-embeddings graphql
```

Set `"type": "module"` in your `package.json` and add these scripts:

```json
{
  "type": "module",
  "engines": { "harperdb": "^4.4" },
  "scripts": {
    "dev": "harperdb dev .",
    "start": "harperdb run .",
    "deploy": "npx -y dotenv-cli -- harperdb deploy . restart=rolling replicated=true"
  }
}
```

Create a `config.yaml` — this is how Harper knows what your app does:

```yaml
loadEnv:
  files:
    - '.env'

rest: true

graphqlSchema:
  files: 'schemas/*.graphql'

jsResource:
  files: 'resources/*.js'
```

Four lines of config. `rest: true` turns on the auto-generated REST API. `graphqlSchema` points to your schema. `jsResource` points to your custom endpoints. That's the entire backend configuration.

Create a `.env` file with your Anthropic key:

```
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

## Step 2: Define the Schema

This is where Harper shines. Create `schemas/schema.graphql`:

```graphql
type Conversation @table @export {
  id: ID @primaryKey
  title: String
  createdAt: String
  updatedAt: String
}

type Message @table @export {
  id: ID @primaryKey
  conversationId: String @indexed
  role: String
  content: String
  embedding: [Float] @indexed(type: "HNSW", distance: "cosine")
  createdAt: String
}
```

That's it. Those 16 lines give you:

- **Two database tables** (`Conversation` and `Message`) with automatic persistence
- **Full REST CRUD APIs** for both tables (thanks to `@export`) — no controllers, no routes, no ORM
- **A vector index** on `Message.embedding` using HNSW with cosine similarity — no separate vector database
- **A secondary index** on `conversationId` for fast lookups

You can immediately `GET /Conversation`, `PUT /Message/:id`, `DELETE /Conversation/:id` — all auto-generated. You didn't write a single route handler for any of that.

## Step 3: Write the Helper Modules

Two small files in `lib/`. First, environment config (`lib/config.js`):

```javascript
const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

const optional = (name, fallback) => process.env[name] ?? fallback

export const config = {
  anthropic: {
    apiKey: () => required('ANTHROPIC_API_KEY'),
    model: () => optional('CLAUDE_MODEL', 'claude-sonnet-4-5-20250514'),
  },
}
```

Then the embedding helper (`lib/embeddings.js`):

```javascript
import { init, embed as llamaEmbed } from 'harper-fabric-embeddings'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { pipeline } from 'stream/promises'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const modelsDir = resolve(__dirname, '../models')
const modelPath = resolve(modelsDir, 'bge-small-en-v1.5-q4_k_m.gguf')
const MODEL_URL =
  'https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q4_k_m.gguf'

async function ensureModel() {
  if (existsSync(modelPath)) return
  mkdirSync(modelsDir, { recursive: true })
  console.log('Downloading bge-small-en-v1.5 (~24 MB)...')
  const response = await fetch(MODEL_URL)
  if (!response.ok) throw new Error(`Model download failed: ${response.status}`)
  await pipeline(response.body, createWriteStream(modelPath))
  console.log('Model ready.')
}

const initPromise = ensureModel().then(() => init({ modelPath }))

export async function embed(text) {
  await initPromise
  return llamaEmbed(text)
}
```

We're using [`harper-fabric-embeddings`](https://github.com/heskew/harper-fabric-embeddings) — a lightweight llama.cpp wrapper built specifically for Harper Fabric. It runs `bge-small-en-v1.5` locally via the native `@node-llama-cpp` addon. **No API key. No external service.** On first run it downloads the model (~24 MB) into `./models/` and caches it there forever after.

## Step 4: Build the Agent

This is the heart of the application. Create `resources/Agent.js`:

```javascript
import { Resource, tables } from 'harperdb'
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../lib/config.js'
import { embed } from '../lib/embeddings.js'

let _client
const getClient = () =>
  (_client ??= new Anthropic({ apiKey: config.anthropic.apiKey() }))

const SYSTEM_PROMPT = `You are a helpful, concise assistant. You have access to \
relevant context from previous conversations when available. Use this context \
naturally — don't mention that you're reading stored memories unless the user asks.`

export class Agent extends Resource {
  static loadAsInstance = false

  async post(target, data) {
    const { message, conversationId: existingId } = data || {}
    if (!message) {
      const err = new Error('Missing required field: message')
      err.statusCode = 400
      throw err
    }

    // 1. Create or reuse a conversation
    const conversationId = existingId || crypto.randomUUID()
    if (!existingId) {
      await tables.Conversation.put({
        id: conversationId,
        title: message.slice(0, 100),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }

    // 2. Embed the user's message
    const userEmbedding = await embed(message)

    // 3. Store the user message
    const userMsgId = crypto.randomUUID()
    await tables.Message.put({
      id: userMsgId,
      conversationId,
      role: 'user',
      content: message,
      embedding: userEmbedding,
      createdAt: new Date().toISOString(),
    })

    // 4. Semantic recall — find relevant messages across ALL conversations
    const relevant = []
    const searchResults = tables.Message.search({
      sort: { attribute: 'embedding', target: userEmbedding },
      limit: 5,
    })
    for await (const msg of searchResults) {
      if (msg.id !== userMsgId && msg.content) {
        relevant.push(msg)
      }
    }

    // 5. Load recent messages from this conversation
    const recent = []
    const history = tables.Message.search({
      conditions: [{ attribute: 'conversationId', value: conversationId }],
      limit: 50,
    })
    for await (const msg of history) {
      if (msg.id !== userMsgId) {
        recent.push({ role: msg.role, content: msg.content, createdAt: msg.createdAt })
      }
    }
    recent.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    // 6. Build the prompt with semantic context
    let systemPrompt = SYSTEM_PROMPT
    if (relevant.length > 0) {
      const memories = relevant
        .map((m) => `[${m.role}]: ${m.content}`)
        .join('\n')
      systemPrompt += `\n\nRelevant context from memory:\n${memories}`
    }

    // 7. Call Claude
    const messages = [
      ...recent.map(({ role, content }) => ({ role, content })),
      { role: 'user', content: message },
    ]

    const response = await getClient().messages.create({
      model: config.anthropic.model(),
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    })

    const assistantContent = response.content[0].text

    // 8. Store the assistant's response with its embedding
    const assistantEmbedding = await embed(assistantContent)
    await tables.Message.put({
      id: crypto.randomUUID(),
      conversationId,
      role: 'assistant',
      content: assistantContent,
      embedding: assistantEmbedding,
      createdAt: new Date().toISOString(),
    })

    // 9. Update conversation timestamp
    await tables.Conversation.put({
      id: conversationId,
      updatedAt: new Date().toISOString(),
    })

    return {
      conversationId,
      message: { role: 'assistant', content: assistantContent },
    }
  }
}
```

Let's walk through what's happening:

1. **Create or reuse a conversation** — if no `conversationId` is provided, we start a new one. Harper stores it instantly.
2. **Embed and store the user message** — `harper-fabric-embeddings` generates a vector embedding locally via llama.cpp, Harper stores both the text and embedding together. No separate vector database or embedding API needed.
3. **Semantic recall** — we search the `embedding` field across *all* messages using Harper's built-in HNSW index. This means the agent can recall relevant information from completely different conversations.
4. **Load conversation history** — we also fetch recent messages from the current conversation for direct context.
5. **Call Claude** — we combine the semantic memories and conversation history into a single prompt and send it to Claude.
6. **Store the response** — the assistant's reply gets embedded and stored too, so it becomes part of the searchable memory.

The class name `Agent` becomes the URL path automatically. The `@export` directive on the schema tables gives us full CRUD on `Conversation` and `Message` for free. The only custom code we wrote is the agent loop itself.

## Step 5: Run It

```bash
npm run dev
```

Harper starts at `http://localhost:9926`. Test it:

```bash
# Start a conversation
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "My favorite programming language is Rust"}'

# Returns: { "conversationId": "abc-123", "message": { "role": "assistant", "content": "..." } }

# Later, in a new conversation, it remembers:
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What programming language do I like?"}'

# The agent recalls "Rust" from the previous conversation via vector search
```

The auto-generated REST APIs work too:

```bash
# List all conversations
curl http://localhost:9926/Conversation

# Get all messages for a conversation
curl "http://localhost:9926/Message?conversationId=abc-123"
```

You didn't write a single line of code for those endpoints. Harper generated them from the schema.

## Step 6: Deploy

Create a cluster on [Harper Fabric](https://fabric.harper.fast/), add the credentials to your `.env`:

```
CLI_TARGET=https://your-instance.your-org.harperfabric.com:9925/
CLI_TARGET_USERNAME=your-username
CLI_TARGET_PASSWORD=your-password
```

Then deploy:

```bash
npm run deploy
```

Your agent is now running globally on Harper Fabric. No Docker, no Kubernetes, no cloud console, no CI/CD pipeline.

## Why Harper for Agents?

After building this, here's what stands out:

**Zero glue code.** In a traditional stack, you'd need a database driver, an ORM, a vector database client, an API framework, route definitions, a caching layer, and deployment configuration. With Harper, the schema *is* the database, the API, and the vector store. The config file is 6 lines.

**Vector search is a schema directive, not a service.** Adding semantic memory to an agent is usually a project in itself — pick a vector database, manage embeddings, handle the query pipeline. Here it's one line in the schema: `@indexed(type: "HNSW", distance: "cosine")`. Done.

**Local embeddings, no API key.** `harper-fabric-embeddings` runs `bge-small-en-v1.5` via llama.cpp, right in the same Node.js process. No Voyage AI account. No OpenAI billing. No embedding service to manage. One dependency, zero extra credentials.

**Everything runs in one process.** The database, cache, API server, and your agent code all share the same runtime. No network hops between services. No cold starts. Sub-millisecond access to cached data.

**Deploy is one command.** `harperdb deploy .` pushes your code and data schema to Harper Fabric. Rolling restarts, replication, and global distribution are handled for you.

**TypeScript works without a build step.** Harper strips types natively via Node.js. No tsc, no webpack, no build pipeline. Write TypeScript if you want, or stay with JavaScript — both work out of the box.

## What's Next

This is a starting point. Here's where you could take it:

- **Add tool use** — give Claude tools that read and write to Harper tables, turning it into a task-execution agent
- **Real-time streaming** — use Harper's built-in pub/sub (SSE, WebSocket, MQTT) to stream responses as they arrive
- **Multi-agent coordination** — multiple agents communicating through Harper's pub/sub system
- **MCP integration** — expose your Harper data to other AI tools via the [Harper MCP server](https://github.com/HarperFast/harperdb-mcp-server)
- **Add a frontend** — serve a chat UI from Harper's static file serving, keeping everything in one project

The [full source code](https://github.com/HarperFast/agent-example-harper) is on GitHub. Clone it, add your Anthropic key, and start building.
