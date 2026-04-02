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

// Approximate pricing for Claude Sonnet 4.5 (per token)
const COST_INPUT_PER_TOKEN  = 3  / 1_000_000  // $3  / 1M input tokens
const COST_OUTPUT_PER_TOKEN = 15 / 1_000_000  // $15 / 1M output tokens
const COST_PER_WEB_SEARCH   = 10 / 1_000      // $10 / 1K searches

// Anthropic web search tool — executed server-side, no external API key needed
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }

// Normalize text for exact cache comparison
const normalize = (s) =>
  s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()

// Cosine similarity between two embedding vectors (1.0 = identical, 0.0 = unrelated)
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

// Similarity threshold for semantic cache hits (0–1). Questions above this score
// are considered "the same question" and served from Harper without calling Claude.
const CACHE_THRESHOLD = 0.88

// Fetch the embedding for a stored message directly from Harper by primary key.
// Harper's search() results don't include the raw float array, but a direct
// record lookup does — giving us persistent embeddings that survive restarts.
async function getEmbedding(msgId) {
  const record = await tables.Message.get(msgId)
  return record?.embedding ?? null
}

export class Agent extends Resource {
  allowRead()   { return true }
  allowCreate() { return true }
  static loadAsInstance = false

  // POST /Agent — send a message, get a response
  async post(target, data) {
    const startTime = Date.now()
    const { message, conversationId: existingId } = data || {}
    if (!message) {
      const err = new Error('Missing required field: message')
      err.statusCode = 400
      throw err
    }

    // 1. Embed first — before any DB writes to avoid holding transactions open
    const userEmbedding = await embed(message)

    // 2. Create or reuse a conversation
    const conversationId = existingId || crypto.randomUUID()
    if (!existingId) {
      await tables.Conversation.put({
        id: conversationId,
        title: message.slice(0, 100),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }

    // 3. Store the user message with its embedding
    const userMsgId = crypto.randomUUID()
    await tables.Message.put({
      id: userMsgId,
      conversationId,
      role: 'user',
      content: message,
      embedding: userEmbedding,
      createdAt: new Date().toISOString(),
    })

    // 4. Vector search for relevant messages across all conversations
    //    (used for semantic context AND semantic cache — keep embedding field for similarity calc)
    const relevant = []
    const searchResults = tables.Message.search({
      sort: { attribute: 'embedding', target: userEmbedding },
      limit: 10,
    })
    for await (const msg of searchResults) {
      if (msg.content && msg.id !== userMsgId) {
        relevant.push(msg) // msg.embedding is kept for cosine similarity below
      }
    }

    // 5. Load full conversation history (includes current user message)
    const recent = []
    const history = tables.Message.search({
      conditions: [{ attribute: 'conversationId', value: conversationId }],
      limit: 100,
    })
    for await (const msg of history) {
      recent.push({ id: msg.id, role: msg.role, content: msg.content, createdAt: msg.createdAt })
    }
    recent.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    // 6. Semantic cache check
    //
    //    First: look in this conversation's history for an identical prior question.
    //    This is the most reliable path — no extra DB round-trip needed.
    let cachedReply = null

    const prevSame = recent.find(
      (m) => m.id !== userMsgId &&
             m.role === 'user' &&
             m.content &&
             normalize(m.content) === normalize(message)
    )
    if (prevSame) {
      const pIdx = recent.indexOf(prevSame)
      cachedReply = recent.slice(pIdx + 1).find((m) => m.role === 'assistant') ?? null
    }

    // Second: semantic similarity check across all conversations.
    // If any user message in the vector results scores above the threshold
    // (meaning it's asking essentially the same thing), serve its answer from cache.
    if (!cachedReply) {
      // Fetch embeddings from Harper by primary key and compute cosine similarity.
      // These are persistent — works correctly after restarts.
      const scoredMatches = (
        await Promise.all(
          relevant
            .filter((m) => m.role === 'user')
            .map(async (m) => {
              const emb = await getEmbedding(m.id)
              return { msg: m, sim: cosineSimilarity(userEmbedding, emb) }
            })
        )
      )
        .filter(({ sim }) => sim >= CACHE_THRESHOLD)
        .sort((a, b) => b.sim - a.sim)

      for (const { msg: match } of scoredMatches) {
        // Find the assistant reply that followed this question in its conversation
        const matchConvMsgs = []
        const matchHistory = tables.Message.search({
          conditions: [{ attribute: 'conversationId', value: match.conversationId }],
          limit: 100,
        })
        for await (const m of matchHistory) matchConvMsgs.push(m)
        matchConvMsgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        const midx = matchConvMsgs.findIndex((m) => m.id === match.id)
        const reply = matchConvMsgs.slice(midx + 1).find((m) => m.role === 'assistant')
        if (reply) {
          cachedReply = reply
          break
        }
      }
    }

    // Return the cached answer — zero LLM cost
    if (cachedReply) {
      // Look up original response cost and accumulate global savings
      let savedCost = 0
      try {
        const origMsg = await tables.Message.get(cachedReply.id)
        savedCost = origMsg?.cost ?? 0
        const stats = await tables.Stats.get('global')
        await tables.Stats.put({
          id: 'global',
          totalSaved: ((stats?.totalSaved) ?? 0) + savedCost,
          cacheHits:  ((stats?.cacheHits)  ?? 0) + 1,
          updatedAt:  new Date().toISOString(),
        })
      } catch {}
      return {
        conversationId,
        message: { role: 'assistant', content: cachedReply.content },
        meta: {
          latencyMs: Date.now() - startTime,
          tokens: { input: 0, output: 0, total: 0 },
          cost:   { input: 0, output: 0, total: 0, saved: savedCost },
          vectorContext: { hit: true, count: 1, cached: true },
        },
      }
    }

    // 7. Build the prompt with semantic context (top 5 relevant messages)
    const context = relevant.slice(0, 5)
    let systemPrompt = SYSTEM_PROMPT
    if (context.length > 0) {
      systemPrompt += '\n\nRelevant context from memory:\n' +
        context.map((m) => `[${m.role}]: ${m.content}`).join('\n')
    }

    // 8. Call Claude with web search enabled — Anthropic executes searches server-side,
    //    no external search API or key required.
    const messages = [
      ...recent
        .filter((m) => m.id !== userMsgId)
        .map(({ role, content }) => ({ role, content })),
      { role: 'user', content: message },
    ]

    let apiResponse = await getClient().messages.create({
      model: config.anthropic.model(),
      max_tokens: 1024,
      tools: [WEB_SEARCH_TOOL],
      system: systemPrompt,
      messages,
    })

    // Handle pause_turn — server hit the max_uses limit mid-response; continue once
    if (apiResponse.stop_reason === 'pause_turn') {
      apiResponse = await getClient().messages.create({
        model: config.anthropic.model(),
        max_tokens: 1024,
        tools: [WEB_SEARCH_TOOL],
        system: systemPrompt,
        messages: [...messages, { role: 'assistant', content: apiResponse.content }],
      })
    }

    const latencyMs = Date.now() - startTime

    // The API can split the answer across multiple text blocks (sentence fragments joined
    // without separators) and may emit a text block BEFORE the web search tool call.
    // Strategy: find the last non-text block (tool use / search result) and take only the
    // text blocks that follow it — these form the actual answer. Join with '' since the
    // fragments are already continuous prose. Falls back to all text blocks if no tools used.
    const lastToolIdx = apiResponse.content.reduce((acc, b, i) => b.type !== 'text' ? i : acc, -1)
    const assistantContent = apiResponse.content
      .slice(lastToolIdx + 1)
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()

    const { input_tokens, output_tokens } = apiResponse.usage
    const webSearches = apiResponse.usage?.server_tool_use?.web_search_requests ?? 0

    // 9. Store the assistant's response with its embedding
    const assistantMsgId = crypto.randomUUID()
    const assistantEmbedding = await embed(assistantContent)
    const searchCost = webSearches * COST_PER_WEB_SEARCH
    const totalCost = (input_tokens * COST_INPUT_PER_TOKEN) + (output_tokens * COST_OUTPUT_PER_TOKEN) + searchCost
    await tables.Message.put({
      id: assistantMsgId,
      conversationId,
      role: 'assistant',
      content: assistantContent,
      cost: totalCost,
      embedding: assistantEmbedding,
      createdAt: new Date().toISOString(),
    })

    // 10. Update conversation timestamp
    await tables.Conversation.put({
      id: conversationId,
      updatedAt: new Date().toISOString(),
    })

    return {
      conversationId,
      message: { role: 'assistant', content: assistantContent },
      meta: {
        latencyMs,
        tokens: {
          input:  input_tokens,
          output: output_tokens,
          total:  input_tokens + output_tokens,
        },
        cost: {
          input:   +(input_tokens  * COST_INPUT_PER_TOKEN).toFixed(6),
          output:  +(output_tokens * COST_OUTPUT_PER_TOKEN).toFixed(6),
          search:  +searchCost.toFixed(6),
          total:   +totalCost.toFixed(6),
        },
        webSearches,
        vectorContext: { hit: context.length > 0, count: context.length, cached: false },
      },
    }
  }
}
