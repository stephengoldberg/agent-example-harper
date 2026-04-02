#!/usr/bin/env node
// Downloads the bge-small-en-v1.5 embedding model if not already present.
// Run automatically via the predev / prestart npm hooks.

import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { pipeline } from 'stream/promises'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const modelsDir = resolve(__dirname, '../models')
const modelPath = resolve(modelsDir, 'bge-small-en-v1.5-q4_k_m.gguf')
const MODEL_URL =
  'https://huggingface.co/CompendiumLabs/bge-small-en-v1.5-gguf/resolve/main/bge-small-en-v1.5-q4_k_m.gguf'

if (existsSync(modelPath)) {
  console.log('✓ Embedding model already downloaded.')
  process.exit(0)
}

console.log('Downloading bge-small-en-v1.5 embedding model (~24 MB)...')
mkdirSync(modelsDir, { recursive: true })

const response = await fetch(MODEL_URL)
if (!response.ok) {
  console.error(`Download failed: ${response.status} ${response.statusText}`)
  process.exit(1)
}

const total = Number(response.headers.get('content-length') || 0)
let downloaded = 0

const progress = new TransformStream({
  transform(chunk, controller) {
    downloaded += chunk.byteLength
    if (total) {
      const pct = Math.round((downloaded / total) * 100)
      process.stdout.write(`\r  ${pct}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`)
    }
    controller.enqueue(chunk)
  },
})

await pipeline(response.body.pipeThrough(progress), createWriteStream(modelPath))
console.log('\n✓ Model ready.')
