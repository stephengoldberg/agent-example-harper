# CLAUDE.md

## Harper Skills

This project uses Harper. Before making changes, install and read the Harper agent skills for best practices on schema design, resources, vector indexing, caching, and deployment:

```bash
npx skills add harperfast/skills
```

These skills provide LLM-consumable guidelines at https://github.com/HarperFast/skills — covering schema relationships, REST/WebSocket APIs, custom resources, vector indexing (HNSW), and caching patterns.

## Project Overview

Harper Demo Agent — a conversational AI agent running entirely on Harper with Claude as the LLM. Harper provides the database, vector index, semantic cache, API server, and deployment runtime in a single process.

Live demo: https://agent-example.stephen-demo-org.harperfabric.com/Chat

## Tech Stack

- **Runtime:** Harper (harperdb) — unified DB/cache/vector/API
- **LLM:** Claude Sonnet via Anthropic SDK (`@anthropic-ai/sdk`)
- **Embeddings:** `bge-small-en-v1.5` running locally via `harper-fabric-embeddings` (llama.cpp) — no embedding API
- **Web Search:** Anthropic's built-in server-side `web_search_20250305` tool
- **Language:** JavaScript (ES modules, `"type": "module"`)
- **License:** Apache 2.0

## Project Structure

```
config.yaml                  # Harper app config (rest, schema, resources)
schemas/schema.graphql       # Database schema — 3 tables, HNSW vector index, TTL
resources/Agent.js           # Agent endpoint (POST /Agent) + PublicStats (GET /PublicStats/global)
resources/Chat.js            # Chat UI (GET /Chat) — full HTML/CSS/JS served from a Resource
lib/config.js                # Environment variable helpers
lib/embeddings.js            # Local SLM embeddings (bge-small-en-v1.5 via llama.cpp)
models/                      # Auto-downloaded GGUF model (gitignored)
.env                         # ANTHROPIC_API_KEY (not committed)
```

## Key Architecture Decisions

### Harper Resource API (V2)
- All resources use `static loadAsInstance = false` (V2 pattern)
- Public access: `target.checkPermission = false` inside each handler method
- **Do NOT use** `allowRead()` / `allowCreate()` — those are V1 methods, silently ignored in V2
- **Do NOT name** a Resource class the same as a `@table` — it shadows `tables.X` and breaks DB access (e.g. we use `PublicStats`, not `Stats`)

### Schema (schemas/schema.graphql)
- `@table(expiration: 3600)` — 1-hour TTL on Message and Conversation tables
- `@export` — auto-generates REST CRUD endpoints
- `@indexed(type: "HNSW", distance: "cosine")` — vector index on `embedding` field
- `@indexed` on `conversationId` — secondary index for conversation lookups
- `Stats` table has no TTL (cumulative savings persist indefinitely)

### Semantic Cache (two layers)
1. **Layer 1 — Exact match:** Normalize text (lowercase, strip punctuation, collapse whitespace) and compare against conversation history. No DB query needed.
2. **Layer 2 — HNSW vector search:** Use Harper's native `conditions` search with `comparator: 'lt'` and `value: 0.12` (cosine distance). **Never do manual cosine similarity in JS** — always use Harper's native HNSW index for distance filtering.

### Vector Context (for LLM prompt)
- Uses `sort: { attribute: 'embedding', target: userEmbedding }` with `limit: 10` — returns top 10 most similar messages
- Top 5 injected into system prompt as silent background context
- System prompt explicitly tells Claude NOT to repeat/summarize context in responses

### Web Search Response Handling
- Anthropic API returns multiple `text` blocks (sentence fragments) mixed with `server_tool_use` and `web_search_tool_result` blocks
- **Always join text blocks that appear AFTER the last non-text block** — text before tool calls is narration ("Let me search for that..."), not the answer
- Handle `pause_turn` stop reason by continuing with partial response as assistant message

### Chat UI (resources/Chat.js)
- Full HTML/CSS/JS served from a single template literal via `new Response(HTML, ...)`
- **Critical:** All regex backslashes in embedded `<script>` must be doubled (`\\d`, `\\s`, `\\*`, `\\n`) because the JS template literal consumes single backslashes
- Backtick characters in regex must use `\\x60` (hex escape) to avoid terminating the template literal
- Mobile responsive: sidebar slides over on screens ≤ 700px
- Harper brand colors: B-Tree Green `#66ffcc`, Quantum Purple `#312556`, Cyber Grape `#7a3a87`, Bytecode Bloom `#c63368`

## Commands

```bash
npm run dev          # Start local dev server (http://localhost:9926)
npm run start        # Start production server
npm run deploy       # Deploy to Harper Fabric
```

## Environment Variables

```
ANTHROPIC_API_KEY    # Required — Anthropic API key for Claude
CLAUDE_MODEL         # Optional — defaults to claude-sonnet-4-5-20250514
```

## Common Tasks

### Wipe the database
```bash
curl -s -X DELETE http://localhost:9926/Message/
curl -s -X DELETE http://localhost:9926/Conversation/
curl -s -X DELETE http://localhost:9926/Stats/
```

### Test the agent via API
```bash
curl -X POST http://localhost:9926/Agent \
  -H "Content-Type: application/json" \
  -d '{"message": "What color is the sky?"}'
```

### Check savings
```bash
curl http://localhost:9926/PublicStats/global
```

## Gotchas

1. **Template literal backslashes** — `\n` inside a JS template literal becomes a real newline. Use `\\n` in Chat.js script sections. Same for `\d`, `\s`, `\*` in regex patterns.
2. **Resource class naming** — naming a class `Stats` when there's a `Stats` table shadows `tables.Stats`. Always use a different name (e.g. `PublicStats`).
3. **`tables.Stats.get()` on empty DB** — returns `null`, not `{}`. Always provide a fallback: `?? { id: 'global', totalSaved: 0, cacheHits: 0 }`.
4. **Web search text blocks** — join only text blocks after the last tool block. Joining all text blocks concatenates narration with the answer.
5. **V2 auth** — `target.checkPermission = false` is the only way to allow unauthenticated access when `loadAsInstance = false`. V1 methods (`allowRead`) are silently ignored.
