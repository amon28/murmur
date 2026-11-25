// Murmur's memory: turns note chunks and questions into vectors with a local embedding model (EmbeddingGemma by default).
// Read from the models folder; when it is not there yet (a new PC), it is downloaded once into that folder (~320 MB).
// Runs as an Electron utility process; talks to main.js by messages.
import fs from 'node:fs'
import path from 'node:path'
const port = process.parentPort
let extractor = null, prefixes = { query: '', doc: '' }

port.on('message', async ({ data: m }) => {
  if (m.type === 'load') {
    try {
      const { pipeline, env, AutoConfig } = await import('@huggingface/transformers')
      fs.mkdirSync(m.dir, { recursive: true })
      env.allowLocalModels = true
      env.localModelPath = m.dir
      env.cacheDir = m.dir
      env.allowRemoteModels = !fs.existsSync(path.join(m.dir, m.model, 'tokenizer.json'))
      let last = 0
      const progress_callback = (p) => {
        if (p.status !== 'progress' || !p.total || p.total < 5e6) return
        const pct = Math.floor(p.progress)
        if (pct !== last) { last = pct; port.postMessage({ type: 'progress', file: path.basename(p.file), pct }) }
      }
      // EmbeddingGemma 2 also has image and audio encoders (~550 MB) that text never uses; without their configs they are neither
      // downloaded nor loaded (same vectors for text)
      const config = await AutoConfig.from_pretrained(m.model)
      delete config.vision_config; delete config.audio_config
      extractor = await pipeline('feature-extraction', m.model, { dtype: m.dtype || 'q8', config, progress_callback, session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 } })
      // EmbeddingGemma was trained with task prefixes; other models get plain text
      prefixes = /embeddinggemma/i.test(m.model) ? { query: 'task: search result | query: ', doc: 'title: none | text: ' } : { query: '', doc: '' }
      port.postMessage({ type: 'ready' })
    } catch (e) {
      port.postMessage({ type: 'error', error: String(e.message || e).slice(0, 300) })
    }
  } else if (m.type === 'embed') {
    try {
      if (!extractor) throw new Error('model not loaded')
      const pre = prefixes[m.kind === 'query' ? 'query' : 'doc']
      const out = await extractor(m.texts.map((t) => pre + t), { pooling: 'mean', normalize: true })
      const dims = out.dims[1]
      const vectors = m.texts.map((_, i) => Array.from(out.data.slice(i * dims, (i + 1) * dims), (x) => Math.round(x * 1e5) / 1e5))
      port.postMessage({ id: m.id, vectors })
    } catch (e) {
      port.postMessage({ id: m.id, error: String(e.message || e) })
    }
  }
})
