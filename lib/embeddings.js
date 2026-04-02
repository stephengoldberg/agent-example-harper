import { init, embed as llamaEmbed } from 'harper-fabric-embeddings'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const modelPath = resolve(__dirname, '../models/bge-small-en-v1.5-q4_k_m.gguf')

// Model is pre-downloaded by the predev/prestart npm hook (scripts/download-model.js)
const initPromise = init({ modelPath })

export async function embed(text) {
  await initPromise
  return llamaEmbed(text)
}
