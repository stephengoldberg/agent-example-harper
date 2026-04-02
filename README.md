# Agent Example: Conversational AI on Harper

A conversational AI agent with persistent semantic memory, built on [Harper](https://harper.fast) and [Claude](https://anthropic.com).

One GraphQL schema defines the database. One JavaScript file implements the agent. One command deploys it globally.

## What It Does

- **Chat with Claude** via a single REST endpoint (`POST /Agent`)
- **Remember everything** — every message is embedded and stored in Harper
- **Semantic recall** — vector search surfaces relevant context from past conversations automatically
- **Conversation history** — full CRUD on conversations and messages via auto-generated REST APIs
- **Local embeddings** — uses [`harper-fabric-embeddings`](https://github.com/heskew/harper-fabric-embeddings) (llama.cpp + bge-small-en-v1.5), no embedding API key required

## Architecture

```
POST /Agent { message, conversationId? }
     │
     ├─ Store user message + embedding in Harper (local llama.cpp)
     ├─ Vector search for relevant past messages (HNSW)
     ├─ Load recent conversation history
     ├─ Call Claude with context
     ├─ Store assistant response + embedding
     └─ Return response
```

**No separate database. No separate cache. No separate vector store. No separate API server. No embedding API.** Harper handles the first four; `harper-fabric-embeddings` runs `bge-small-en-v1.5` locally (24 MB, one-time download).

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Harper CLI](https://www.npmjs.com/package/harperdb): `npm install -g harperdb`
- [Anthropic API key](https://console.anthropic.com/)

That's it — embeddings run locally, no extra API key needed.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/HarperFast/agent-example-harper.git
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

The server starts at `http://localhost:9926`.

## Usage

**Start a new conversation:**

```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What is Harper?"}'
```

**Continue a conversation:**

```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{
    "conversationId": "your-conversation-id",
    "message": "Tell me more about its vector search"
  }'
```

**List conversations** (auto-generated from schema):

```bash
curl http://localhost:9926/Conversation
```

**Get messages for a conversation** (auto-generated from schema):

```bash
curl "http://localhost:9926/Message?conversationId=your-id"
```

## Deploy to Harper Fabric

```bash
# 1. Create a cluster at https://fabric.harper.fast/
# 2. Add your Fabric credentials to .env (see .env.example)
# 3. Deploy
npm run deploy
```

That's it. Your agent is now running globally on Harper Fabric.

## Project Structure

```
├── config.yaml              # Harper app configuration
├── schemas/
│   └── schema.graphql       # Database schema (conversations + messages + vector index)
├── resources/
│   └── Agent.js             # The agent endpoint (~100 lines)
├── lib/
│   ├── config.js            # Environment variable helpers
│   └── embeddings.js        # Local llama.cpp embeddings via harper-fabric-embeddings
├── models/                  # Auto-downloaded GGUF model (gitignored)
├── .env.example             # Environment template
└── package.json
```

## Why Harper for Agents?

| Concern | Traditional Stack | Harper |
|---|---|---|
| Database | Postgres/MongoDB | Built in |
| Vector search | Pinecone/Weaviate | Built in (HNSW) |
| API server | Express/Fastify | Auto-generated from schema |
| Caching | Redis | Built in (sub-ms) |
| Embeddings | Voyage/OpenAI API | Local via `harper-fabric-embeddings` (bge-small, 24 MB) |
| Deployment | Docker + K8s + cloud | `harperdb deploy .` |

## License

MIT
