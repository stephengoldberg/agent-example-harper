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

  // POST /Agent — send a message, get a response
  async post(target, data) {
    const { message, conversationId: existingId } = data || {}
    if (!message) {
      const err = new Error('Missing required field: message')
      err.statusCode = 400
      throw err
    }

    // 1. Embed first — this may take a moment on first run while the model loads.
    //    Doing this before any database writes avoids holding transactions open
    //    during the (potentially slow) model initialization.
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

    // 4. Semantic recall — find relevant messages across all conversations
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
      message: {
        role: 'assistant',
        content: assistantContent,
      },
    }
  }
}
