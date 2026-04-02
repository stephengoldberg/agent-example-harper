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

// Normalize text for cache comparison — lowercase, collapse whitespace, strip punctuation
const normalize = (s) =>
  s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()

export class Agent extends Resource {
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

    // 2. Semantic cache check — search BEFORE storing the current message so we
    //    don't match ourselves. If the top vector results contain an identical
    //    user question, return the stored answer instantly without calling Claude.
    let cachedAnswer = null
    const topSimilar = []
    const cacheSearch = tables.Message.search({
      sort: { attribute: 'embedding', target: userEmbedding },
      limit: 10,
    })
    for await (const msg of cacheSearch) topSimilar.push(msg)

    const cacheMatch = topSimilar.find(
      (msg) => msg.role === 'user' && msg.content &&
               normalize(msg.content) === normalize(message)
    )

    if (cacheMatch) {
      // Load the conversation that contained this question and find the
      // assistant reply that immediately followed it.
      const convMsgs = []
      const convSearch = tables.Message.search({
        conditions: [{ attribute: 'conversationId', value: cacheMatch.conversationId }],
        limit: 100,
      })
      for await (const m of convSearch) convMsgs.push(m)
      convMsgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const idx = convMsgs.findIndex((m) => m.id === cacheMatch.id)
      cachedAnswer = convMsgs.slice(idx + 1).find((m) => m.role === 'assistant') ?? null
    }

    // 3. Create or reuse a conversation
    const conversationId = existingId || crypto.randomUUID()
    if (!existingId) {
      await tables.Conversation.put({
        id: conversationId,
        title: message.slice(0, 100),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }

    // 4. Store the user message (always, even on cache hits — keeps history intact)
    await tables.Message.put({
      id: crypto.randomUUID(),
      conversationId,
      role: 'user',
      content: message,
      embedding: userEmbedding,
      createdAt: new Date().toISOString(),
    })

    // 5. Return from semantic cache if we have a hit — zero LLM cost
    if (cachedAnswer) {
      return {
        conversationId,
        message: { role: 'assistant', content: cachedAnswer.content },
        meta: {
          latencyMs: Date.now() - startTime,
          tokens: { input: 0, output: 0, total: 0 },
          cost:   { input: 0, output: 0, total: 0 },
          vectorContext: { hit: true, count: 1, cached: true },
        },
      }
    }

    // 6. Semantic recall — find relevant messages across all conversations
    const relevant = []
    const searchResults = tables.Message.search({
      sort: { attribute: 'embedding', target: userEmbedding },
      limit: 5,
    })
    for await (const msg of searchResults) {
      if (msg.content) relevant.push(msg)
    }

    // 7. Load recent messages from this conversation
    const recent = []
    const history = tables.Message.search({
      conditions: [{ attribute: 'conversationId', value: conversationId }],
      limit: 50,
    })
    for await (const msg of history) {
      recent.push({ role: msg.role, content: msg.content, createdAt: msg.createdAt })
    }
    recent.sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    // 8. Build the prompt with semantic context
    let systemPrompt = SYSTEM_PROMPT
    if (relevant.length > 0) {
      const memories = relevant.map((m) => `[${m.role}]: ${m.content}`).join('\n')
      systemPrompt += `\n\nRelevant context from memory:\n${memories}`
    }

    // 9. Call Claude
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

    const latencyMs = Date.now() - startTime
    const assistantContent = response.content[0].text
    const { input_tokens, output_tokens } = response.usage

    // 10. Store the assistant's response with its embedding
    const assistantEmbedding = await embed(assistantContent)
    await tables.Message.put({
      id: crypto.randomUUID(),
      conversationId,
      role: 'assistant',
      content: assistantContent,
      embedding: assistantEmbedding,
      createdAt: new Date().toISOString(),
    })

    // 11. Update conversation timestamp
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
          input:  +(input_tokens  * COST_INPUT_PER_TOKEN).toFixed(6),
          output: +(output_tokens * COST_OUTPUT_PER_TOKEN).toFixed(6),
          total:  +((input_tokens * COST_INPUT_PER_TOKEN) + (output_tokens * COST_OUTPUT_PER_TOKEN)).toFixed(6),
        },
        vectorContext: { hit: relevant.length > 0, count: relevant.length, cached: false },
      },
    }
  }
}
