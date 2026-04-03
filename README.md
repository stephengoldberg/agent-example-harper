# Harper Demo Agent

A conversational AI agent with persistent semantic memory, a two-layer semantic cache, web search, cost tracking, and a browser chat UI — all running on [Harper](https://harper.fast) with Claude.

Live demo: **[agent-example.stephen-demo-org.harperfabric.com/Chat](https://agent-example.stephen-demo-org.harperfabric.com/Chat)**

## What It Does

- **Chat with Claude** via a REST endpoint (`POST /Agent`) or the built-in browser chat UI (`GET /Chat`)
- **Semantic cache** — two-layer cache catches repeated and rephrased questions before they reach Claude, returning answers instantly at zero LLM cost
- **Web search** — Anthropic's built-in server-side web search (`web_search_20250305`, up to 5 uses per turn); no external API key required
- **Persistent memory** — every message is embedded and stored in Harper; semantic recall surfaces relevant context from past conversations automatically
- **Local embeddings** — `bge-small-en-v1.5` runs via `harper-fabric-embeddings` (llama.cpp wrapper), entirely in-process; no embedding API key or billing
- **Per-response metadata** — every API response includes latency, token counts, cost breakdown, web searches used, and vector context stats
- **Global savings tracker** — cache hits accumulate a running total of USD saved and hit count in a `Stats` table, displayed live in the chat sidebar
- **Auto-generated REST APIs** — full CRUD on `Conversation`, `Message`, and `Stats` tables, generated from the GraphQL schema with zero route code

## Architecture

```
User Query
    │
    ▼
┌──────────────────────────────────────────────────────────┐
│                         Harper                           │
│                                                          │
│  1. Embed user message (Local SLM: bge-small-en-v1.5)   │
│  2. Store user message + embedding                       │
│  3. HNSW semantic cache check (cosine distance < 0.12)   │
│       │                          │                       │
│   Cache HIT                  Cache MISS                  │
│       │                          │                       │
│  Return $0.00           Call Claude ──────────────────────┼──► Anthropic API
│  + saved $X                      │                       │    + Web Search
│                          Embed response (local SLM)  ◄───┘
│                          Store in Harper                  │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

Every request is standalone. Ask once, pay for Claude. Ask again — or rephrase the same question — and Harper serves the cached answer instantly at $0.

## How the Semantic Cache Works

Before calling Claude, the agent searches Harper's HNSW vector index for semantically similar past questions:

```javascript
tables.Message.search({
  conditions: {
    attribute: 'embedding',
    comparator: 'lt',
    value: 0.12,           // cosine distance < 0.12 ≡ cosine similarity ≥ 0.88
    target: userEmbedding,
  },
  limit: 10,
})
```

Harper's HNSW index evaluates the distance threshold internally — no full table scan, no in-memory cosine math. When a match is found, the agent looks up the assistant reply that followed it and returns that directly. No Claude call, no tokens, no cost.

Cache hits return `cost.total: 0` and include a `cost.saved` field showing what the call would have cost. The saved amount is added to the global `Stats` record (`totalSaved`, `cacheHits`).

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Harper CLI](https://www.npmjs.com/package/harperdb): `npm install -g harperdb`
- [Anthropic API key](https://console.anthropic.com/)

No embedding API key needed — embeddings run in-process.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/stephengoldberg/agent-example-harper.git
cd agent-example-harper

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env — add your ANTHROPIC_API_KEY

# Start the dev server
npm run dev
```

> **First run:** On startup, `bge-small-en-v1.5` (~24 MB) is auto-downloaded into `./models/`. This only happens once.

The server starts at `http://localhost:9926`. Open `http://localhost:9926/Chat` in your browser.

## Usage

**Open the chat UI:**

```
http://localhost:9926/Chat
```

**Send a message via API:**

```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What is Harper?"}'
```

Response:

```json
{
  "conversationId": "abc-123",
  "message": { "role": "assistant", "content": "Harper is..." },
  "meta": {
    "latencyMs": 1842,
    "tokens": { "input": 312, "output": 148, "total": 460 },
    "cost": { "input": 0.000936, "output": 0.00222, "search": 0, "total": 0.003156 },
    "webSearches": 0,
    "vectorContext": { "hit": false, "count": 0, "cached": false }
  }
}
```

**Continue a conversation:**

```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "abc-123",
    "message": "Tell me more about its vector search"
  }'
```

**Ask the same question again (cache hit — free and instant):**

```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What is Harper?"}'

# meta.cost.total = 0, meta.cost.saved = 0.003156
```

**Check global savings:**

```bash
curl http://localhost:9926/PublicStats/global
# { "id": "global", "totalSaved": 0.003156, "cacheHits": 1, "updatedAt": "..." }
```

**Auto-generated CRUD** (from schema, no route code written):

```bash
# List all conversations
curl http://localhost:9926/Conversation

# Get messages for a conversation
curl "http://localhost:9926/Message?conversationId=abc-123"
```

## Project Structure

```
├── config.yaml              # Harper app configuration (6 lines)
├── schemas/
│   └── schema.graphql       # Database schema (Conversation, Message, Stats + HNSW index)
├── resources/
│   ├── Agent.js             # POST /Agent (agent loop + semantic cache + web search)
│   │                        # GET  /PublicStats/:id (public stats endpoint)
│   └── Chat.js              # GET  /Chat (full browser chat UI served as HTML)
├── lib/
│   ├── config.js            # Environment variable helpers
│   └── embeddings.js        # Local llama.cpp embeddings via harper-fabric-embeddings
├── models/                  # Auto-downloaded GGUF model (gitignored)
├── .env.example             # Environment template
└── package.json
```

## Schema

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
  cost: Float
  embedding: [Float] @indexed(type: "HNSW", distance: "cosine")
  createdAt: String
}

type Stats @table @export {
  id: ID @primaryKey
  totalSaved: Float
  cacheHits: Int
  updatedAt: String
}
```

`@table` creates the database table. `@export` generates the full REST CRUD API. `@indexed(type: "HNSW", distance: "cosine")` adds the HNSW vector index used for both semantic cache lookup and context retrieval.

## Deploying to Harper Fabric

```bash
# 1. Create a cluster at https://fabric.harper.fast/
# 2. Add credentials to .env
CLI_TARGET=https://your-instance.your-org.harperfabric.com:9925/
CLI_TARGET_USERNAME=your-username
CLI_TARGET_PASSWORD=your-password

# 3. Deploy
npm run deploy
```

Rolling restarts and replication are handled automatically.

**Public access note:** To make endpoints accessible without authentication, set `target.checkPermission = false` inside the handler method. This is the V2 Resource API pattern (`loadAsInstance = false`). The V1 method `allowRead()` is ignored in V2 Resources and has no effect.

## Why Harper for AI Agents

| Concern | Traditional Stack | Harper |
|---|---|---|
| Database | Postgres / MongoDB | Built in |
| Vector search | Pinecone / Weaviate | Built in (HNSW — one schema directive) |
| Semantic cache | Redis + custom logic | Built in (native HNSW threshold filter) |
| API server | Express / Fastify | Auto-generated from schema |
| Chat UI server | Vite / Next.js | Resource returning `Response(html)` |
| Embeddings | Voyage / OpenAI API | Local via `harper-fabric-embeddings` (24 MB, in-process) |
| Deployment | Docker + K8s + cloud | `harperdb deploy .` |

**Key insights from building this:**

- **Native HNSW conditions search scales.** Passing `comparator: 'lt'` to Harper's vector search evaluates the distance threshold inside the index. No JS cosine math, no full scans.
- **Everything in one process means no network hops.** Database, vector index, cache, API, and agent code share the same runtime. No Redis round-trip, no vector DB round-trip.
- **The schema is the only config you need.** One `@indexed(type: "HNSW", distance: "cosine")` directive creates the vector index. One `@export` generates the CRUD API. One `@indexed` on `conversationId` creates the secondary index.
- **Resources can return anything.** A `Resource` subclass can return a `Response` with any content type — JSON, HTML, plain text. The chat UI lives in the same project and deploy as the agent logic.
- **Local embeddings eliminate a cost center.** `bge-small-en-v1.5` runs in-process via llama.cpp. No per-embedding billing, no embedding service SLA to worry about.

## License

Apache 2.0 — see [LICENSE](LICENSE)
