import { Resource } from 'harperdb'

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Harper Demo Agent</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f0f2f5;
      height: 100dvh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    header {
      background: #0f172a;
      color: #f8fafc;
      padding: 0.875rem 1.25rem;
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-shrink: 0;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }
    header svg { flex-shrink: 0; }
    header h1 { font-size: 1rem; font-weight: 600; letter-spacing: -0.01em; }
    #conv-badge {
      margin-left: auto;
      font-size: 0.65rem;
      opacity: 0.4;
      font-family: monospace;
    }

    #chat {
      flex: 1;
      overflow-y: auto;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.875rem;
      scroll-behavior: smooth;
    }

    .message {
      display: flex;
      flex-direction: column;
      max-width: 78%;
    }
    .message.user  { align-self: flex-end;  align-items: flex-end; }
    .message.assistant { align-self: flex-start; align-items: flex-start; }

    .bubble {
      padding: 0.7rem 1rem;
      border-radius: 1.1rem;
      line-height: 1.55;
      font-size: 0.93rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .user .bubble {
      background: #2563eb;
      color: #fff;
      border-bottom-right-radius: 0.25rem;
    }
    .assistant .bubble {
      background: #fff;
      color: #111827;
      border-bottom-left-radius: 0.25rem;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }

    /* — metadata strip — */
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
      margin-top: 0.35rem;
      padding: 0.35rem 0.6rem;
      background: rgba(0,0,0,0.04);
      border-radius: 0.5rem;
      font-size: 0.68rem;
      color: #6b7280;
    }
    .meta .pill {
      display: flex;
      align-items: center;
      gap: 0.2rem;
      white-space: nowrap;
    }
    .meta .pill.vector-hit  { color: #059669; font-weight: 500; }
    .meta .pill.vector-miss { color: #9ca3af; }
    .meta .pill.cache-hit   { color: #2563eb; font-weight: 500; }

    /* — typing indicator — */
    .typing-wrap { align-self: flex-start; }
    .typing {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0.7rem 1rem;
      background: #fff;
      border-radius: 1.1rem;
      border-bottom-left-radius: 0.25rem;
      box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    }
    .typing span {
      display: block;
      width: 7px; height: 7px;
      background: #d1d5db;
      border-radius: 50%;
      animation: bop 1.1s ease-in-out infinite;
    }
    .typing span:nth-child(2) { animation-delay: 0.18s; }
    .typing span:nth-child(3) { animation-delay: 0.36s; }
    @keyframes bop {
      0%, 80%, 100% { transform: translateY(0);    background: #d1d5db; }
      40%           { transform: translateY(-6px); background: #6b7280; }
    }

    /* — input bar — */
    .input-bar {
      background: #fff;
      border-top: 1px solid #e5e7eb;
      padding: 0.875rem 1.25rem;
      display: flex;
      align-items: flex-end;
      gap: 0.6rem;
      flex-shrink: 0;
    }
    #input {
      flex: 1;
      resize: none;
      border: 1.5px solid #e5e7eb;
      border-radius: 0.75rem;
      padding: 0.6rem 0.875rem;
      font-family: inherit;
      font-size: 0.93rem;
      line-height: 1.45;
      outline: none;
      height: 2.6rem;
      max-height: 9rem;
      overflow-y: auto;
      transition: border-color 0.15s;
    }
    #input:focus { border-color: #2563eb; }
    #send {
      height: 2.6rem;
      padding: 0 1.1rem;
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 0.75rem;
      font-size: 0.9rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s, opacity 0.15s;
      white-space: nowrap;
      flex-shrink: 0;
    }
    #send:hover:not(:disabled) { background: #1d4ed8; }
    #send:disabled { opacity: 0.45; cursor: not-allowed; }

    .error .bubble {
      background: #fee2e2;
      color: #991b1b;
    }
  </style>
</head>
<body>

<header>
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2a10 10 0 1 0 10 10"/>
    <path d="M12 8v4l2 2"/>
    <path d="M18 2v6h6"/>
  </svg>
  <h1>Harper Demo Agent</h1>
  <span id="conv-badge"></span>
</header>

<div id="chat"></div>

<div class="input-bar">
  <textarea id="input" placeholder="Message Harper Demo Agent… (Enter to send, Shift+Enter for newline)" rows="1"></textarea>
  <button id="send">Send</button>
</div>

<script>
  let conversationId = null
  const chat   = document.getElementById('chat')
  const input  = document.getElementById('input')
  const send   = document.getElementById('send')
  const badge  = document.getElementById('conv-badge')

  /* ── helpers ──────────────────────────────────────────── */
  function scrollBottom() {
    chat.scrollTop = chat.scrollHeight
  }

  function addMessage(role, content, meta) {
    const wrap = document.createElement('div')
    wrap.className = 'message ' + role

    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = content
    wrap.appendChild(bubble)

    if (meta) {
      wrap.appendChild(buildMeta(meta))
    }

    chat.appendChild(wrap)
    scrollBottom()
    return wrap
  }

  function buildMeta(meta) {
    const { latencyMs, tokens, cost, vectorContext } = meta
    const div = document.createElement('div')
    div.className = 'meta'

    const latency = (latencyMs / 1000).toFixed(2) + 's'

    if (vectorContext.cached) {
      // Served entirely from Harper's semantic cache — no LLM call
      div.innerHTML =
        '<span class="pill">⚡ ' + latency + '</span>' +
        '<span class="pill cache-hit">💾 served from Harper cache — $0.0000 · 0 tokens</span>'
    } else {
      const tok     = tokens.input + ' in · ' + tokens.output + ' out'
      const usd     = '$' + cost.total.toFixed(4)
      const vectorClass = vectorContext.hit ? 'vector-hit' : 'vector-miss'
      const vectorIcon  = vectorContext.hit ? '⬡' : '○'
      const vectorLabel = vectorContext.hit
        ? vectorContext.count + ' memor' + (vectorContext.count === 1 ? 'y' : 'ies') + ' from Harper vector index'
        : 'no vector context — LLM knowledge only'

      div.innerHTML =
        '<span class="pill">⚡ ' + latency + '</span>' +
        '<span class="pill">📊 ' + tok + '</span>' +
        '<span class="pill">💰 ' + usd + '</span>' +
        '<span class="pill ' + vectorClass + '">' + vectorIcon + ' ' + vectorLabel + '</span>'
    }

    return div
  }

  function showTyping() {
    const wrap = document.createElement('div')
    wrap.className = 'typing-wrap'
    wrap.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>'
    chat.appendChild(wrap)
    scrollBottom()
    return wrap
  }

  /* ── send ─────────────────────────────────────────────── */
  async function sendMessage() {
    const text = input.value.trim()
    if (!text || send.disabled) return

    input.value = ''
    input.style.height = ''
    send.disabled = true

    addMessage('user', text)
    const indicator = showTyping()

    try {
      const res  = await fetch('/Agent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message: text, conversationId }),
      })

      const data = await res.json()
      indicator.remove()

      if (!res.ok) {
        const errText = typeof data === 'string' ? data : (data.error || JSON.stringify(data))
        addMessage('assistant error', '⚠ ' + errText)
      } else {
        conversationId = data.conversationId
        badge.textContent = 'conv ' + conversationId.slice(0, 8) + '…'
        addMessage('assistant', data.message.content, data.meta)
      }
    } catch (err) {
      indicator.remove()
      addMessage('assistant error', '⚠ ' + err.message)
    }

    send.disabled = false
    input.focus()
  }

  /* ── events ───────────────────────────────────────────── */
  send.addEventListener('click', sendMessage)

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })

  input.addEventListener('input', () => {
    input.style.height = ''
    input.style.height = Math.min(input.scrollHeight, 144) + 'px'
  })

  input.focus()
</script>
</body>
</html>`

export class Chat extends Resource {
  static loadAsInstance = false

  get() {
    return new Response(HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
}
