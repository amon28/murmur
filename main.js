// Murmur: a small local AI window for notes and conversation.
// Main process: settings, notes on disk, the llama.cpp and whisper.cpp servers it starts, and the embedder child process.
const { app, BrowserWindow, ipcMain, globalShortcut, utilityProcess, dialog, shell, Notification, Tray, Menu, nativeImage, desktopCapturer, screen, clipboard } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const L = require('./lib')
const { splitArgs, dropSpecArgs, firstWords, keyWords, parseWhen, CHARS_PER_TOKEN } = L

if (process.env.MURMUR_DATA) app.setPath('userData', process.env.MURMUR_DATA) // a separate copy for testing, with its own lock
const DATA = app.getPath('userData')
const SETTINGS_FILE = path.join(DATA, 'settings.json')
const HAD_SETTINGS = fs.existsSync(SETTINGS_FILE) // read before anything writes it: an update, not a new install
const NOTES_FILE = path.join(DATA, 'notes.json')
const VECTORS_FILE = path.join(DATA, 'vectors.json')
const CHAT_FILE = path.join(DATA, 'chat.json')
const LOG_FILE = path.join(DATA, 'murmur.log')
const MODELS_DIR = path.join(DATA, 'models') // what Setup downloads goes here
// llama.cpp and whisper.cpp (Vulkan builds, with the Microsoft C++ runtime next to them) ship inside the app
const BIN = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin')

// Files already on the PC are used where they exist (LM Studio and OBS LocalVocal models, and any folders named in
// <data>/local-paths.json); anywhere else Murmur uses its own copies: the bundled programs and the models Setup downloads.
// local-paths.json (optional): { "llamaDir": "...", "gemmaDir": "...", "whisperBuild": "...", "embedDir": "..." }
const HOME = process.env.USERPROFILE || ''
const LOCAL = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'local-paths.json'), 'utf8')) } catch { return {} } })()
const NOWHERE = path.join(DATA, '.none') // a path that never exists, for folders this PC does not have
const LLAMA_DIR = LOCAL.llamaDir || NOWHERE
const GEMMA_DIR = LOCAL.gemmaDir || NOWHERE
const OBS_MODELS = path.join(process.env.APPDATA || '', 'obs-studio', 'plugin_config', 'obs-localvocal', 'models')
const WHISPER_BUILD = LOCAL.whisperBuild || NOWHERE
const LOCAL_EMBED = LOCAL.embedDir || NOWHERE
const firstExisting = (...paths) => paths.find((p) => fs.existsSync(p)) || paths.at(-1)

// What Setup can download, and where it lands. The key is the setting it fills in.
const HF = 'https://huggingface.co'
const DOWNLOADS = {
  llmModel: { label: 'Chat model — Gemma 4 E4B, 4.2 GB', url: `${HF}/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf`, file: 'gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf', required: true },
  llmDraft: { label: 'Faster replies (MTP draft), 60 MB', url: `${HF}/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/mtp-gemma-4-E4B-it.gguf`, file: 'mtp-gemma-4-E4B-it.gguf' },
  llmVision: { label: 'Seeing images (vision part), 1 GB', url: `${HF}/unsloth/gemma-4-E4B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf`, file: 'mmproj-BF16.gguf' },
  whisperModel: { label: 'Speech recognition — Whisper turbo, 574 MB', url: `${HF}/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin`, file: 'ggml-large-v3-turbo-q5_0.bin', required: true },
}

const DEFAULTS = {
  // chat model
  llmMode: 'managed', // managed = Murmur starts llama-server; external = any OpenAI-compatible server
  llamaServer: firstExisting(path.join(LLAMA_DIR, 'llama-server.exe'), path.join(BIN, 'llama', 'llama-server.exe')),
  llmModel: firstExisting(path.join(GEMMA_DIR, DOWNLOADS.llmModel.file), path.join(MODELS_DIR, DOWNLOADS.llmModel.file)),
  llmDraft: firstExisting(path.join(GEMMA_DIR, DOWNLOADS.llmDraft.file), path.join(MODELS_DIR, DOWNLOADS.llmDraft.file)),
  llmVision: firstExisting(path.join(GEMMA_DIR, DOWNLOADS.llmVision.file), path.join(MODELS_DIR, DOWNLOADS.llmVision.file)),
  llmPort: 8091,
  llmCtx: 16384,
  // the GGUF's own chat template: with the preset's custom Gemma template the model wrote its thinking into the answer.
  // Two slots sharing one context: slot 0 is the chat, slot 1 the side tasks (intent, titles, learning), so a side
  // task never throws away the chat's cached prompt. --no-cache-idle-slots: otherwise a new task moves the idle chat
  // slot out to RAM and clears it, and Gemma (sliding-window attention) cannot pick up a partial match from there.
  llmArgs: '-ngl 99 -np 2 --kv-unified --no-cache-idle-slots -fa on --jinja --spec-type draft-mtp --spec-draft-n-max 2',
  thinking: false, // Gemma thinks before chat replies (slower, better on hard questions); side tasks never think
  externalUrl: 'http://127.0.0.1:8080/v1',
  externalModel: 'local-model',
  externalKey: '',
  temperature: 0.7,
  systemPrompt: 'You are Murmur, a friendly assistant living in a small window on the user\'s PC. You help them take notes and talk things through. Keep replies short and clear unless asked for more.',
  webSearch: 'auto', // auto = the model searches when it needs to, button = only with the 🌐 button, off
  // ears
  whisperServer: firstExisting(path.join(WHISPER_BUILD, 'build', 'bin', 'Release', 'whisper-server.exe'), path.join(BIN, 'whisper', 'whisper-server.exe')),
  whisperModel: firstExisting(path.join(OBS_MODELS, 'ggml-medium-q8_0', 'ggml-medium-q8_0.bin'), path.join(MODELS_DIR, DOWNLOADS.whisperModel.file)),
  whisperPort: 8097,
  whisperLang: 'auto',
  micDevice: '',
  vadLevel: 0.012, // speech above this loudness (RMS)
  silenceMs: 1000, // a pause this long ends a sentence
  // memory (downloads itself into embedDir on first start when it is not there, ~320 MB)
  embedDir: firstExisting(LOCAL_EMBED, path.join(DATA, 'embed-models')),
  embedModel: 'onnx-community/embeddinggemma-2-ONNX',
  embedDtype: 'q8',
  recallCount: 4,
  recallMin: 0.65, // EmbeddingGemma scores unrelated text around 0.45-0.6, related 0.68+
  recallChats: true, // past conversations are searched by meaning too, not only notes
  // dictation
  tidyNotes: true, // after dictation, the model writes a title and a short summary
  learn: true, // after a few quiet minutes the model updates what it knows about the user and its own manner with them
  // window
  alwaysOnTop: true,
  hotkeyShow: 'Control+Alt+M',
  hotkeyDictate: 'Control+Alt+N',
  hotkeyScreen: 'Control+Alt+S', // pick part of the screen and ask about it
  hotkeyType: 'Control+Alt+T', // type what you say into the app in front
  closeToTray: true, // the close button hides Murmur in the tray, so reminders still come
  startAtLogin: false,
  // ears
  vad: 'silero', // silero = a small speech detector model; level = the loudness gate
  whisperHints: true, // names from your notes and profile are given to Whisper so it spells them right
  // video memory
  earsIdleMin: 10, // Whisper stops after this many minutes without the mic (0 = never)
  llmIdleMin: 0, // the chat model too (0 = never)
  autoUpdate: true,
}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
// for files that hold the user's data: a file that is there but cannot be read is moved aside (never saved over),
// and the newest backup that reads is used instead
function readData(file, fallback, backups = []) {
  if (!fs.existsSync(file)) return fallback
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`
    try { fs.renameSync(file, aside) } catch {}
    log('could not read', file, e.message, '-> moved to', aside)
    for (const b of backups) { try { const v = JSON.parse(fs.readFileSync(b, 'utf8')); log('restored from', b); return v } catch {} }
    return fallback
  }
}
function writeJson(file, value) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 1)); fs.renameSync(tmp, file) }
function log(...parts) { try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${parts.join(' ')}\n`) } catch {} }

let settings = { ...DEFAULTS, ...readJson(SETTINGS_FILE, {}) }
// 0.7.1 saved its default arguments with one slot; those (and only those, not arguments the user wrote) move to two
if (settings.llmArgs === '-ngl 99 -np 1 -fa on --jinja --spec-type draft-mtp --spec-draft-n-max 2') { settings.llmArgs = DEFAULTS.llmArgs; writeJson(SETTINGS_FILE, settings) }
// thinking used to be a --reasoning flag in the extra arguments; it is its own setting now, switched per request
{
  const m = settings.llmArgs.match(/\s*--reasoning(?:\s+(on|off|auto))?/)
  if (m) {
    if (!('thinking' in readJson(SETTINGS_FILE, {}))) settings.thinking = m[1] === 'on'
    settings.llmArgs = settings.llmArgs.replace(m[0], '').trim()
    writeJson(SETTINGS_FILE, settings)
  }
}
const BACKUP_DIR = path.join(DATA, 'backups')
// backups\<kind>-<date>.json, newest first
const backupsOf = (kind) => { try { return fs.readdirSync(BACKUP_DIR).filter((f) => new RegExp(`^${kind}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f)).sort().reverse().map((f) => path.join(BACKUP_DIR, f)) } catch { return [] } }
let notes = readData(NOTES_FILE, [], backupsOf('notes'))
// deleted notes wait here for 30 days before they are gone
const TRASH_FILE = path.join(DATA, 'trash.json')
let trash = readData(TRASH_FILE, [], backupsOf('trash')).filter((n) => Date.now() - n.deleted < 30 * 864e5)
// chunk key (note id + text hash) -> vector, in a binary file that is appended to (vectors.json before 0.7.2)
const { VecStore } = require('./vecstore')
const vectors = new VecStore(path.join(DATA, 'vectors.bin'))
if (fs.existsSync(VECTORS_FILE)) log('vectors moved from json:', vectors.importJson(VECTORS_FILE))
let win = null

// ---------- servers ----------

const servers = {} // name -> { proc, state, detail }
function setState(name, state, detail = '') {
  servers[name] = { ...(servers[name] || {}), state, detail }
  win?.webContents.send('status', statusAll())
  // notes saved before the model could name them still carry their first words as a title
  if (name === 'llm' && state === 'ready') (async () => { for (const n of notes.filter((n) => n.title === firstWords(n.text)).slice(0, 20)) await nameNote(n) })()
}
function statusAll() {
  const out = {}
  for (const n of ['llm', 'ears', 'memory']) out[n] = { state: servers[n]?.state || 'off', detail: servers[n]?.detail || '' }
  return out
}

async function ping(url, ms = 1500, headers = {}) {
  try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) }); return r.ok } catch { return false }
}

function startProcess(name, exe, args, healthUrl, readyMs = 180000, headers = {}) {
  if (!fs.existsSync(exe)) { setState(name, 'error', `not found: ${exe}`); return }
  // the key is never written to the log
  log(`start ${name}:`, exe, args.map((a, i) => (args[i - 1] === '--api-key' ? '***' : a)).join(' '))
  setState(name, 'starting', path.basename(args[args.indexOf('-m') + 1] || exe))
  const proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true })
  servers[name].proc = proc
  let tail = ''
  const keep = (d) => { tail = (tail + d.toString()).slice(-4000) }
  proc.stdout.on('data', keep); proc.stderr.on('data', keep)
  proc.on('exit', (code) => {
    if (servers[name]?.proc !== proc) return
    servers[name].proc = null
    log(`${name} exited ${code}\n${tail}`)
    setState(name, 'error', `stopped (code ${code}): ${tail.trim().split('\n').slice(-2).join(' ')}`.slice(0, 300))
  })
  const started = Date.now()
  const wait = async () => {
    if (servers[name]?.proc !== proc) return
    if (await ping(healthUrl, 1500, headers)) return setState(name, 'ready', servers[name].detail)
    if (Date.now() - started > readyMs) return setState(name, 'error', 'did not answer in time')
    setTimeout(wait, 1000)
  }
  wait()
}

// stops a server Murmur started and resolves once it is gone (so its port is free for the next one)
function stopProcess(name) {
  const p = servers[name]?.proc
  if (!p) return Promise.resolve()
  servers[name].proc = null
  return new Promise((res) => {
    const done = () => { clearTimeout(t); res() }
    const t = setTimeout(done, 8000)
    p.once('exit', done)
    try { spawn('taskkill', ['/pid', String(p.pid), '/t', '/f'], { windowsHide: true }) } catch { done() }
  })
}

let llmSlots = 1
// a fresh key for each server Murmur starts, so no other program or web page on this PC can use the model
let llmKey = ''
function llmBase() { return settings.llmMode === 'external' ? settings.externalUrl.replace(/\/+$/, '') : `http://127.0.0.1:${settings.llmPort}/v1` }

// Starting is serialized: a second call while one runs waits for it, then starts again with the newest settings.
const starting = {}, startingNow = {}
function serialized(name, fn) {
  startingNow[name] = (startingNow[name] || 0) + 1
  const run = async () => { try { await fn() } catch (e) { log(`start ${name} failed`, e.message); setState(name, 'error', e.message) } finally { startingNow[name]-- } }
  starting[name] = (starting[name] || Promise.resolve()).then(run)
  return starting[name]
}
function startLlm() { return serialized('llm', startLlmNow) }
async function startLlmNow() {
  if (settings.llmMode === 'external') {
    await stopProcess('llm'); llmKey = ''
    setState('llm', 'starting', settings.externalModel)
    const ok = await ping(llmBase() + '/models', 4000, settings.externalKey ? { Authorization: `Bearer ${settings.externalKey}` } : {})
    return setState('llm', ok ? 'ready' : 'error', ok ? settings.externalModel : `no answer from ${settings.externalUrl}`)
  }
  const port = Number(settings.llmPort)
  // a server Murmur did not start (it was already running): used as it is, its slots and key unknown.
  // Murmur's own server is always restarted, so new settings take effect.
  if (!servers.llm?.proc && await ping(`http://127.0.0.1:${port}/health`)) { llmSlots = 1; llmKey = ''; return setState('llm', 'ready', `already running on :${port}`) }
  await stopProcess('llm')
  if (!fs.existsSync(settings.llmModel)) return setState('llm', 'missing', 'model not downloaded yet — open Setup')
  llmKey = crypto.randomBytes(24).toString('hex')
  const args = ['-m', settings.llmModel, '--host', '127.0.0.1', '--port', String(port), '-c', String(settings.llmCtx), '--alias', 'murmur', '--api-key', llmKey]
  if (settings.llmDraft && fs.existsSync(settings.llmDraft)) args.push('-md', settings.llmDraft)
  // image tokens follow the picture size (70-1120)
  if (settings.llmVision && fs.existsSync(settings.llmVision)) args.push('--mmproj', settings.llmVision, '--image-min-tokens', '70', '--image-max-tokens', '1120')
  let extra = splitArgs(settings.llmArgs).filter((a, i, all) => a !== '--api-key' && all[i - 1] !== '--api-key')
  if (!args.includes('-md')) extra = dropSpecArgs(extra) // the MTP flags need the draft model
  // Each request says whether the model thinks (chat_template_kwargs.enable_thinking in complete(): the chat follows
  // Settings › Think before answering, side tasks never think). With the server started as --reasoning off, that
  // per-request switch was measured to work both ways on Gemma 4 E4B (b9608), so it is always started that way;
  // a --reasoning value saved in the extra arguments by older versions is dropped.
  extra = extra.filter((a, i, all) => !(a === '--reasoning' || a === '-rea') && !((all[i - 1] === '--reasoning' || all[i - 1] === '-rea') && /^(on|off|auto)$/.test(a)))
  args.push('--reasoning', 'off')
  llmSlots = Number(L.argValue(extra, '-np', '--parallel')) || 1
  lastLlmUse = Date.now()
  startProcess('llm', settings.llamaServer, [...args, ...extra], `http://127.0.0.1:${port}/health`)
}
function startEars() { return serialized('ears', startEarsNow) }
async function startEarsNow() {
  const port = Number(settings.whisperPort)
  if (!servers.ears?.proc && await ping(`http://127.0.0.1:${port}/`)) return setState('ears', 'ready', `already running on :${port}`)
  await stopProcess('ears')
  if (!fs.existsSync(settings.whisperModel)) return setState('ears', 'missing', 'model not downloaded yet — open Setup')
  const args = ['-m', settings.whisperModel, '--host', '127.0.0.1', '--port', String(port), '-l', settings.whisperLang || 'auto', '-t', '4']
  lastEarsUse = Date.now()
  startProcess('ears', settings.whisperServer, args, `http://127.0.0.1:${port}/`, 60000)
}

// ---------- giving video memory back when idle ----------
// Whisper stops after `earsIdleMin` minutes without the mic, the chat model after `llmIdleMin` (0 = never), and they
// start again by themselves the next time they are needed. The GPU is shared with games and other local AI.
let lastEarsUse = Date.now(), lastLlmUse = Date.now()
const SLEEP_NOTE = 'resting to free video memory; starts again when needed'
setInterval(async () => {
  const idle = (t, min) => Number(min) > 0 && Date.now() - t > Number(min) * 6e4
  if (servers.ears?.proc && servers.ears.state === 'ready' && !dict && idle(lastEarsUse, settings.earsIdleMin)) { log('ears idle, stopping'); await stopProcess('ears'); setState('ears', 'sleeping', SLEEP_NOTE) }
  if (servers.llm?.proc && servers.llm.state === 'ready' && !chatBusy && idle(lastLlmUse, settings.llmIdleMin)) { log('llm idle, stopping'); await stopProcess('llm'); setState('llm', 'sleeping', SLEEP_NOTE) }
}, 30000)
let dict = false // the window is dictating: Whisper stays up (set over IPC)
// waits until a server is up, waking it when it was resting; false if it cannot start
async function ready(name, ms) {
  const s = servers[name]?.state
  if (s === 'sleeping') (name === 'llm' ? startLlm : startEars)()
  const end = Date.now() + ms
  while (Date.now() < end) {
    const st = servers[name]?.state
    if (st === 'ready') return true
    if ((st === 'missing' || st === 'error' || st === 'off') && !startingNow[name] && !servers[name]?.proc) return false
    await new Promise((r) => setTimeout(r, 250))
  }
  return servers[name]?.state === 'ready'
}

// ---------- embedder (child process, so loading the model never freezes the window) ----------

let embedder = null, embedSeq = 0
const embedWaiting = new Map()
function startEmbedder() {
  try { embedder?.kill() } catch {}
  for (const [, w] of embedWaiting) w.reject(new Error('embedder restarted'))
  embedWaiting.clear()
  setState('memory', 'starting', settings.embedModel.split('/').pop())
  embedder = utilityProcess.fork(path.join(__dirname, 'embedder.mjs'), [], { serviceName: 'Murmur embedder' })
  embedder.on('message', (m) => {
    if (m.type === 'ready') { setState('memory', 'ready', settings.embedModel.split('/').pop()); indexNotes().then(indexChats) }
    else if (m.type === 'progress') setState('memory', 'starting', `downloading ${m.file} ${m.pct}%`)
    else if (m.type === 'error' && m.id == null) setState('memory', 'error', m.error)
    else {
      const w = embedWaiting.get(m.id); if (!w) return
      embedWaiting.delete(m.id)
      m.error ? w.reject(new Error(m.error)) : w.resolve(m.vectors)
    }
  })
  embedder.on('exit', () => { if (servers.memory?.state !== 'error') setState('memory', 'error', 'embedder stopped') })
  embedder.postMessage({ type: 'load', dir: settings.embedDir, model: settings.embedModel, dtype: settings.embedDtype })
}
function embed(texts, kind) {
  if (servers.memory?.state !== 'ready') return Promise.reject(new Error('memory not ready'))
  const id = ++embedSeq
  return new Promise((resolve, reject) => {
    embedWaiting.set(id, { resolve, reject })
    embedder.postMessage({ type: 'embed', id, texts, kind })
  })
}

// ---------- notes ----------

// before the first save of each day the notes as they were are copied to backups\notes-<date>.json; the last 14 days are kept
// Once a day, before the first change, notes, trash, profile and all conversations are copied to backups\ (the last 14
// days are kept). A file that cannot be read on start is restored from the newest of these (readData).
let backedUp = ''
function dailyBackup() {
  const d = new Date().toLocaleDateString('sv')
  if (backedUp === d) return
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const copy = (src, kind) => { const t = path.join(BACKUP_DIR, `${kind}-${d}.json`); if (!fs.existsSync(t) && fs.existsSync(src)) fs.copyFileSync(src, t) }
    copy(NOTES_FILE, 'notes'); copy(TRASH_FILE, 'trash'); copy(PROFILE_FILE, 'profile')
    const ct = path.join(BACKUP_DIR, `chats-${d}.json`)
    if (!fs.existsSync(ct) && convs.size) writeJson(ct, [...convs.values()].filter((c) => c.messages.length))
    for (const kind of ['notes', 'trash', 'profile', 'chats']) for (const f of backupsOf(kind).slice(14)) fs.unlinkSync(f)
    backedUp = d
  } catch (e) { log('backup failed', e.message) }
}
function saveNotes() { dailyBackup(); writeJson(NOTES_FILE, notes) }
function saveTrash() { dailyBackup(); writeJson(TRASH_FILE, trash) }
// chunks are worked out once per version of a note (hashing every note on every message added up)
const chunkCache = new Map()
function chunks(note) {
  const ver = `${note.updated}|${note.title}|${String(note.text || '').length}`
  const hit = chunkCache.get(note.id)
  if (hit?.ver === ver) return hit.list
  const list = chunksNow(note)
  chunkCache.set(note.id, { ver, list })
  if (chunkCache.size > notes.length + 50) for (const id of chunkCache.keys()) if (!notes.some((n) => n.id === id)) chunkCache.delete(id)
  return list
}
function chunksNow(note) {
  // about 700 characters per chunk, split at paragraph or sentence ends, title in front so each chunk knows what it belongs to
  const body = String(note.text || '').trim()
  const parts = []
  let cur = ''
  for (const piece of body.split(/(?<=[.!?\n])\s+/)) {
    if ((cur + ' ' + piece).length > 700 && cur) { parts.push(cur); cur = piece } else cur = cur ? cur + ' ' + piece : piece
  }
  if (cur) parts.push(cur)
  if (!parts.length) parts.push('')
  return parts.map((p) => ({ key: note.id + ':' + crypto.createHash('sha1').update(note.title + '\n' + p).digest('hex').slice(0, 16), text: `${note.title}\n${p}`.trim(), part: p }))
}
let indexing = null
function indexNotes() {
  if (indexing) return indexing
  // passes repeat until nothing is missing, so notes added while a pass runs are not left out
  indexing = (async () => {
    await null // never finish synchronously, or `indexing` would be set after it was cleared
    for (let pass = 0; pass < 5; pass++) {
      const want = new Map()
      for (const n of notes) for (const c of chunks(n)) want.set(c.key, c.text)
      const missing = [...want].filter(([k]) => !vectors.has(k))
      for (let i = 0; i < missing.length; i += 16) {
        const batch = missing.slice(i, i + 16)
        const vecs = await embed(batch.map(([, t]) => t), 'doc')
        vectors.setMany(batch.map(([k], j) => [k, vecs[j]]))
      }
      vectors.deleteMany(vectors.keys().filter((k) => !want.has(k)))
      if (!missing.length) break
    }
  })().catch((e) => log('index failed', e.message)).finally(() => { indexing = null })
  return indexing
}
function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s } // vectors are normalized

// qv: the query's vector when the caller already has it (the message is embedded once per turn)
async function searchNotes(query, count = settings.recallCount, min = settings.recallMin, near = 0.06, qv = null) {
  const q = String(query || '').trim()
  if (!q || !notes.length) return []
  let scored = []
  try {
    await indexNotes()
    if (!qv) [qv] = await embed([q], 'query')
    for (const n of notes) {
      let best = -1, bestPart = ''
      for (const c of chunks(n)) { const v = vectors.get(c.key); if (!v) continue; const s = cosine(qv, v); if (s > best) { best = s; bestPart = c.part } }
      // a word of the question in the title or text (a dish, a name) counts for more than meaning alone can show
      const title = n.title.toLowerCase(), text = n.text.toLowerCase()
      best += keyWords(q).reduce((b, w) => b + (title.includes(w) ? 0.08 : text.includes(w) ? 0.04 : 0), 0)
      if (best >= min) scored.push({ id: n.id, title: n.title, score: best, part: bestPart })
    }
  } catch {
    // memory not loaded yet: plain word match
    const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2)
    for (const n of notes) {
      const hay = (n.title + ' ' + n.text).toLowerCase()
      const hits = words.filter((w) => hay.includes(w)).length
      if (hits) scored.push({ id: n.id, title: n.title, score: hits / words.length, part: n.text.slice(0, 700) })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  // for chat, only notes about as close as the best one: a weaker match is usually a different topic
  return scored.filter((s) => !near || s.score >= scored[0].score - near).slice(0, count)
}

function addNote({ title, text, source = 'typed', transcript }) {
  const now = Date.now()
  const note = { id: crypto.randomUUID(), title: (title || '').trim() || firstWords(text), text: (text || '').trim(), source, created: now, updated: now, ...(transcript ? { transcript } : {}) }
  notes.unshift(note); saveNotes(); indexNotes()
  win?.webContents.send('notes-changed')
  if (!(title || '').trim() && note.text) nameNote(note)
  return note
}
function appendNote(id, text) {
  const n = notes.find((x) => x.id === id); text = String(text || '').trim()
  if (!n || !text) return null
  n.text = `${n.text.trim()}\n\n${text}`; n.updated = Date.now()
  notes.splice(notes.indexOf(n), 1); notes.unshift(n) // newest first
  saveNotes(); indexNotes(); win?.webContents.send('notes-changed')
  return n
}
// a note saved without a title ("Save as note" on a reply) gets one from the model
async function nameNote(note) {
  if (servers.llm?.state !== 'ready') return
  try {
    const out = await complete([
      { role: 'system', content: 'Give this note a short title of 2-6 words that says what it is about. Answer with the title only, no quotes or punctuation at the end. Use the language of the note.' },
      { role: 'user', content: note.text.slice(0, 3000) },
    ], { maxTokens: 30, temperature: 0.2, background: true })
    const title = out.replace(/[*#"“”]/g, '').split('\n').map((l) => l.trim()).find(Boolean)?.replace(/[.:]$/, '').slice(0, 80)
    const n = notes.find((x) => x.id === note.id)
    if (title && n && n.title === firstWords(n.text)) { n.title = title; saveNotes(); indexNotes(); win?.webContents.send('notes-changed') }
  } catch (err) { log('note title failed', err.message) }
}
// ---------- chat ----------

// Every conversation is its own file in <data>/chats; one stays open (`conv`). A new conversation gets no file until its first message.
const CHATS_DIR = path.join(DATA, 'chats')
const convs = new Map() // id -> { id, title, titled, created, updated, messages }
function loadConvs() {
  fs.mkdirSync(CHATS_DIR, { recursive: true })
  let lost = []
  for (const f of fs.readdirSync(CHATS_DIR)) {
    if (!f.endsWith('.json')) continue
    const file = path.join(CHATS_DIR, f)
    const c = readData(file, null)
    if (c?.id && Array.isArray(c.messages)) convs.set(c.id, c)
    else if (!fs.existsSync(file)) lost.push(f.replace(/\.json$/, '')) // could not be read: moved aside by readData
  }
  // a conversation file that could not be read comes back from the newest daily backup that has it
  for (const b of lost.length ? backupsOf('chats') : []) {
    const list = readJson(b, [])
    for (const id of lost.slice()) {
      const c = Array.isArray(list) && list.find((x) => x?.id === id)
      if (c) { convs.set(id, c); writeJson(path.join(CHATS_DIR, id + '.json'), c); log('restored chat', id, 'from', b); lost = lost.filter((x) => x !== id) }
    }
    if (!lost.length) break
  }
  // the single chat.json of the first version becomes the first conversation
  const old = readJson(CHAT_FILE, null)
  if (Array.isArray(old) && old.length) {
    const c = newConv(); c.messages = old; c.title = firstWords(old.find((m) => m.role === 'user')?.content); c.created = old[0].at || Date.now(); c.updated = old.at(-1).at || Date.now()
    saveConv(c)
  }
  if (old) try { fs.renameSync(CHAT_FILE, CHAT_FILE + '.old') } catch {}
}
function newConv() { const now = Date.now(); const c = { id: crypto.randomUUID(), title: 'New conversation', titled: false, created: now, updated: now, messages: [] }; convs.set(c.id, c); return c }
function saveConv(c) { if (c.messages.length) { dailyBackup(); writeJson(path.join(CHATS_DIR, c.id + '.json'), c) } }
function convSummary(c) {
  const last = c.messages.at(-1)
  return { id: c.id, title: c.title, updated: c.updated, count: c.messages.length, preview: last ? String(last.content).replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').slice(0, 120) : '' }
}
function latestConv() { return [...convs.values()].filter((c) => c.messages.length).sort((a, b) => b.updated - a.updated)[0] }
let conv = null // the open conversation, set at start
let chatAbort = null

// after the first reply the model names the conversation (a few words); until then it is named after the first message
async function nameConv(c) {
  if (c.titled) return
  c.titled = true
  c.title = firstWords(c.messages.find((m) => m.role === 'user')?.content)
  try {
    const talk = c.messages.slice(0, 4).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).slice(0, 600)}`).join('\n')
    const t = await complete([
      { role: 'system', content: 'Give this conversation a short title of 2-6 words. Answer with the title only, no quotes, no full stop.' },
      { role: 'user', content: talk },
    ], { maxTokens: 24, temperature: 0.3, background: true })
    const clean = t.replace(/^["'*\s]+|["'*.\s]+$/g, '').split('\n')[0].slice(0, 60)
    if (clean) c.title = clean
  } catch {}
  saveConv(c)
  win?.webContents.send('chats-changed')
}

// ---------- what Murmur learns about the user ----------
// profile.json: facts about the user, and the personality Murmur grows with them. Both are written by the model in a
// quiet moment after a few messages (reflect), from the talk since the last time and the 👍/👎 the user gave; the user can
// see, edit and remove all of it in the You tab.
const PROFILE_FILE = path.join(DATA, 'profile.json')
let profile = { facts: [], persona: '', updated: 0, learnedFrom: 0, ...readData(PROFILE_FILE, {}, backupsOf('profile')) }
function saveProfile() { dailyBackup(); writeJson(PROFILE_FILE, profile); win?.webContents.send('profile-changed') }
function profilePrompt() {
  let out = ''
  if (profile.persona.trim()) out += `\n\nYour own way with this user, grown from your talks together (be this, naturally; never describe it or mention that you learn):\n${profile.persona.trim()}`
  if (profile.facts.length) out += `\n\nWhat you know about the user (use it when it fits, like a friend would; do not list it back to them):\n` + profile.facts.map((f) => '- ' + f.text).join('\n')
  return out
}
// the talk since the last reflection, oldest first, with the user's ratings, up to about 9000 characters.
// upTo is the time of the last message included: the next reflection starts after it, so nothing is skipped
// (not what came in while this one ran, nor what did not fit this time)
function sinceLastReflect() {
  const all = []
  for (const c of convs.values()) for (const m of c.messages) if (m.at > profile.learnedFrom && String(m.content).trim()) all.push(m)
  all.sort((a, b) => a.at - b.at)
  const lines = []; let used = 0, upTo = profile.learnedFrom
  for (const m of all) {
    const rate = m.rating === 1 ? ' [the user liked this reply 👍]' : m.rating === -1 ? ' [the user disliked this reply 👎]' : ''
    const line = `${m.role === 'user' ? 'User' : 'Murmur'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, m.role === 'user' ? 800 : 400)}${rate}`
    if (used + line.length > 9000 && lines.length) break
    lines.push(line); used += line.length + 1; upTo = m.at
  }
  return { talk: lines.join('\n'), upTo }
}
const REFLECT = `You are Murmur, a personal assistant, thinking back over recent conversations with your user to know them better and to grow your own personality with them. Answer with JSON only:
{"add": ["new fact", ...], "remove": [numbers of facts that are wrong or outdated], "persona": "..."}
Facts: short lines about the user that will stay useful later: their name, people and pets in their life, work or studies, where they live, interests, likes and dislikes, food, goals, routines, and how they like to be answered (length, tone, language). Only what the user said or clearly showed, never guesses. Not one-off tasks or the content of their notes or questions. Do not add what is already in the list; when a fact changed, remove the old one and add the new one.
Persona: 3-6 sentences of instructions to yourself, Murmur, about how you are with this user: your tone, humor, warmth, how long your replies are, words or nicknames you share, little running jokes, what to avoid. "You" in it always means you, Murmur, never the user; it starts with "You are Murmur". Call the user by name or "they", never he or she unless they said so. Do not repeat the facts in it. It is yours, so give it some character, shaped by what this user enjoys: they liked replies marked 👍, disliked ones marked 👎, and their corrections ("too long", "be serious") matter most. Keep the old persona and change it only a little at a time. If there is nothing new, keep it as it is.
Example of the style (for a different user): "You are Murmur, Sam's dry-humored desk buddy. You answer in one or two sentences unless Sam asks for more. You tease gently about Sam's coffee habit and never lecture. Skip the cheerleading; Sam likes plain facts with one joke at most."`
let reflecting = false
async function reflect(force = false) {
  if (reflecting || (!settings.learn && !force)) return false
  const { talk, upTo } = sinceLastReflect()
  if (!talk.trim() || !talk.includes('User:')) return false
  reflecting = true
  try {
    const known = profile.facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n') || '(none yet)'
    const out = await complete([
      { role: 'system', content: REFLECT },
      { role: 'user', content: `Facts you know:\n${known}\n\nYour persona now:\n${profile.persona || '(none yet: you are new to this user; start one from what you see, kept light)'}\n\nRecent conversation:\n${talk}` },
    ], { maxTokens: 700, temperature: 0.4, background: true })
    const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
    const drop = new Set((j.remove || []).map(Number))
    const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    profile.facts = profile.facts.filter((_, i) => !drop.has(i + 1))
    for (const t of (j.add || []).map((x) => String(x).trim()).filter(Boolean)) {
      if (!profile.facts.some((f) => norm(f.text) === norm(t))) profile.facts.push({ id: crypto.randomUUID(), text: t.slice(0, 200), at: Date.now() })
    }
    profile.facts = profile.facts.slice(-60)
    if (typeof j.persona === 'string' && j.persona.trim().length > 20) profile.persona = j.persona.trim().slice(0, 1200)
    profile.learnedFrom = upTo; profile.updated = Date.now()
    saveProfile()
    log('reflected:', (j.add || []).length, 'added', drop.size, 'removed')
    setTimeout(maybeReflect, 0) // more talk than fit this time: the rest goes next
    return true
  } catch (err) { log('reflect failed', err.message); return false } finally { reflecting = false }
}
// after every few messages, once the user has been quiet for a while (so it never holds up a reply)
let reflectT = null
function maybeReflect() {
  clearTimeout(reflectT)
  if (!settings.learn) return
  const fresh = [...convs.values()].reduce((k, c) => k + c.messages.filter((m) => m.role === 'user' && m.at > profile.learnedFrom).length, 0)
  if (fresh >= 4) reflectT = setTimeout(reflect, 90_000)
}

// ---------- past conversations as memory ----------
// Every exchange (a message and the reply to it) gets a vector like a note chunk does, kept in chat-vectors.json, so
// a new message can bring back what was said in other conversations, days ago.
const CHAT_VECTORS_FILE = path.join(DATA, 'chat-vectors.json')
const chatVectors = new VecStore(path.join(DATA, 'chat-vectors.bin')) // convId:at:hash -> vector
if (fs.existsSync(CHAT_VECTORS_FILE)) log('chat vectors moved from json:', chatVectors.importJson(CHAT_VECTORS_FILE))
const exchangeCache = new Map()
function exchanges(c) {
  const ver = `${c.messages.length}|${c.updated}`
  const hit = exchangeCache.get(c.id)
  if (hit?.ver === ver) return hit.list
  const list = exchangesNow(c)
  exchangeCache.set(c.id, { ver, list })
  return list
}
function exchangesNow(c) {
  const out = []
  c.messages.forEach((m, i) => {
    if (m.role !== 'user' || !String(m.content).trim()) return
    const r = c.messages[i + 1]?.role === 'assistant' ? c.messages[i + 1] : null
    const text = `User: ${String(m.content).slice(0, 500)}${r ? '\nMurmur: ' + String(r.content).slice(0, 500) : ''}`
    out.push({ key: `${c.id}:${m.at}:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 10)}`, conv: c.id, at: m.at, text })
  })
  return out
}
let chatIndexing = null
function indexChats() {
  if (chatIndexing) return chatIndexing
  chatIndexing = (async () => {
    await null
    for (let pass = 0; pass < 5; pass++) {
      const want = new Map()
      for (const c of convs.values()) for (const x of exchanges(c)) want.set(x.key, x.text)
      const missing = [...want].filter(([k]) => !chatVectors.has(k))
      for (let i = 0; i < missing.length; i += 16) {
        const batch = missing.slice(i, i + 16)
        const vecs = await embed(batch.map(([, t]) => t), 'doc')
        chatVectors.setMany(batch.map(([k], j) => [k, vecs[j]]))
      }
      chatVectors.deleteMany(chatVectors.keys().filter((k) => !want.has(k)))
      if (!missing.length) break
    }
  })().catch((e) => log('chat index failed', e.message)).finally(() => { chatIndexing = null })
  return chatIndexing
}
// "what did we talk about yesterday", "remember when…": the user is asking about the past, so look more widely
async function searchChats(query, exceptConv, wide = false, qv = null) {
  if (!settings.recallChats || !String(query).trim()) return []
  try {
    await indexChats()
    if (!qv) [qv] = await embed([query], 'query')
    const words = keyWords(query)
    const scored = []
    for (const c of convs.values()) {
      if (c.id === exceptConv) continue // the open conversation is already in front of the model
      for (const x of exchanges(c)) {
        const v = chatVectors.get(x.key); if (!v) continue
        const low = x.text.toLowerCase()
        const score = cosine(qv, v) + words.reduce((b, w) => b + (low.includes(w) ? 0.04 : 0), 0)
        scored.push({ ...x, title: c.title, score })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    const min = settings.recallMin - (wide ? 0.06 : 0), best = scored[0]?.score || 0
    const out = [], perConv = {}
    for (const s of scored) {
      if (s.score < min || s.score < best - (wide ? 0.1 : 0.06) || out.length >= (wide ? 5 : 3)) break
      if ((perConv[s.conv] = (perConv[s.conv] || 0) + 1) > 2) continue
      out.push(s)
    }
    return out
  } catch { return [] }
}
const day = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
function pastPrompt(pastChats, exceptConv, wide) {
  let out = ''
  if (pastChats.length) out += `\n\nFrom your earlier conversations with the user, found because they may relate to this message (bring them up naturally when they help, like a friend who remembers, e.g. "like we talked about on Monday"; ignore them when they do not fit):\n` +
    pastChats.map((p) => `- ${day(p.at)}, in "${p.title}":\n${p.text.replace(/^/gm, '  ')}`).join('\n')
  // when they ask about the past, the latest conversations by date help with "yesterday" and "last time"
  if (wide) {
    const recent = [...convs.values()].filter((c) => c.id !== exceptConv && c.messages.length).sort((a, b) => b.updated - a.updated).slice(0, 8)
    if (recent.length) out += `\n\nYour latest conversations with the user (newest first):\n` + recent.map((c) => `- ${day(c.updated)}: "${c.title}" (began: ${String(c.messages.find((m) => m.role === 'user')?.content || '').replace(/\s+/g, ' ').slice(0, 120)})`).join('\n')
  }
  return out
}

const NOTE_TOOL = `
Notes: only when the user asks you to save, remember, note down or write down something, add a block at the very end of your reply:
<note title="Short title">The content to save, in clear sentences.</note>
When a note from the user's notebook (in the context block) is about the same thing, add to it instead of making a second one, using its ref: <note-add ref="n1">The new part.</note-add>
When they ask to be reminded of something, write the note tag with a remind time (24-hour clock, their local time, worked out from Now), titled with what to do, like: <note title="Call the plumber" remind="2026-01-31 09:00">Call the plumber.</note> Murmur pops the reminder up at that time.
Do not mention the tags.`
const VOICE = `
Speak to the user directly as "you". Never narrate your own thinking or plans (no "The user is asking…", "I should check…"); just answer. Never say you saved or noted something unless you wrote a note block for it.`
// What a message is for, read by the model before it answers, so "don't let me forget the gate code is 4417" is kept
// without the word "remember". The prompt is in lib.js; the word lists there are only the fallback when the model can't
// be asked. On Murmur's own server the answer is held to a JSON schema, so it is short and always parses.
async function readIntent(text, lastReply, signal) {
  const fallback = L.intentByWords(text)
  if (!text || (text.length < 12 && fallback.intent === 'chat')) return fallback // "hi", "thanks"
  try {
    const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000)
    const out = await complete([{ role: 'system', content: L.INTENT }, { role: 'user', content: L.intentUserText(text, lastReply) }],
      { maxTokens: 40, temperature: 0, signal: sig, schema: L.INTENT_SCHEMA })
    const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
    return { ...L.settleIntent(text, j), by: 'model' }
  } catch (err) { if (signal?.aborted) throw err; log('intent failed', err.message); return fallback }
}
const SEARCH_TOOL = `
You can search the web. When the answer depends on current or recent information (news, prices, weather, releases, scores, schedules) or on facts you are unsure of, reply with ONLY this line and nothing else:
<search>short search query</search>
You will then get the results and can answer. Do not search for things you already know well or for chit-chat.`

// ---------- attachments ----------
// Files are turned into text once, images are kept as JPEG (the window already shrank them); both live in <data>/attachments.
const ATTACH_DIR = path.join(DATA, 'attachments')
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|java|c|cc|cpp|h|hpp|cs|go|rs|rb|php|sh|ps1|bat|cmd|ini|cfg|conf|toml|ya?ml|log|sql|lua|kt|swift|r|tex|srt|vtt)$/i
async function fileToText(name, bytes) {
  const buf = Buffer.from(bytes)
  if (/\.pdf$/i.test(name)) {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const { text } = await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })
    return text
  }
  if (/\.docx$/i.test(name)) return (await require('mammoth').extractRawText({ buffer: buf })).value
  if (TEXT_EXT.test(name) || !buf.subarray(0, 4000).includes(0)) return buf.toString('utf8') // unknown types: text if there are no zero bytes
  throw new Error(`can't read ${path.extname(name) || 'this kind of'} files`)
}
ipcMain.handle('attach:add', async (_e, { name, kind, bytes, thumb }) => {
  fs.mkdirSync(ATTACH_DIR, { recursive: true })
  const id = crypto.randomUUID()
  if (kind === 'image') {
    fs.writeFileSync(path.join(ATTACH_DIR, id + '.jpg'), Buffer.from(bytes))
    return { id, kind, name, thumb }
  }
  const text = String(await fileToText(name, bytes)).replace(/\r\n/g, '\n').trim()
  if (!text) throw new Error(`${name} has no text in it`)
  fs.writeFileSync(path.join(ATTACH_DIR, id + '.txt'), text)
  return { id, kind: 'file', name, chars: text.length }
})
function removeAttachment(id) {
  const safe = String(id || '').replace(/[^\w-]/g, '')
  if (!safe) return
  for (const ext of ['.jpg', '.txt']) { try { fs.unlinkSync(path.join(ATTACH_DIR, safe + ext)) } catch {} }
}
// files attached but never sent (removed from the tray, or the window closed), or left by chats deleted before 0.7.2:
// anything no conversation points to and older than a day
function sweepAttachments() {
  try {
    const used = new Set()
    for (const c of convs.values()) for (const m of c.messages) for (const a of m.attachments || []) used.add(a.id)
    let n = 0
    for (const f of fs.readdirSync(ATTACH_DIR)) {
      const id = f.replace(/\.(jpg|txt)$/, '')
      if (used.has(id) || id === f) continue
      const p = path.join(ATTACH_DIR, f)
      if (Date.now() - fs.statSync(p).mtimeMs > 864e5) { fs.unlinkSync(p); n++ }
    }
    if (n) log('removed', n, 'unused attachments')
  } catch {}
}
function attachmentText(a, max) {
  try { const t = fs.readFileSync(path.join(ATTACH_DIR, a.id + '.txt'), 'utf8'); return t.length > max ? t.slice(0, max) + `\n[… ${t.length - max} more characters cut]` : t } catch { return '(file missing)' }
}
function attachmentLength(a) { try { return fs.readFileSync(path.join(ATTACH_DIR, a.id + '.txt'), 'utf8').length } catch { return 0 } }
function hasVision() { return settings.llmMode === 'external' || (!!settings.llmVision && fs.existsSync(settings.llmVision)) }

// How much of a message's files the model reads is decided once, when it is sent, and kept with the message
// (attachment.inline): the message then reads the same on every later turn, so the cached prompt stays valid, and many or
// long files can never overflow the context. The files share about a third of the context.
const IMAGE_TOKENS = 1120 // the most an image costs (--image-max-tokens)
const MAX_IMAGES = 4 // pictures the model sees at once: the newest ones in the conversation
function fileBudget() { return Math.min(24000, Math.floor(Number(settings.llmCtx) * CHARS_PER_TOKEN * 0.33)) }
function allotFiles(attachments) {
  const files = attachments.filter((a) => a.kind === 'file')
  const lengths = files.map(attachmentLength)
  const shares = L.shareFileChars(lengths, fileBudget())
  const cut = []
  files.forEach((a, i) => { if (shares[i] < lengths[i]) cut.push({ name: a.name, kept: shares[i], total: lengths[i] }) })
  const list = attachments.map((a) => (a.kind === 'file' ? { ...a, inline: shares[files.indexOf(a)] } : a))
  return { list, cut }
}

// one stored message as the model sees it: file text inlined, images as pictures when `images` says so
function toModel(m, images) {
  if (m.role !== 'user' || !m.attachments?.length) return { role: m.role, content: m.content }
  let text = m.content
  const parts = []
  for (const a of m.attachments) {
    if (a.kind === 'file') text += `\n\n[Attached file: ${a.name}]\n\`\`\`\n${attachmentText(a, a.inline ?? 3000)}\n\`\`\``
    else if (images && hasVision()) {
      try { parts.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ATTACH_DIR, a.id + '.jpg')).toString('base64') } }) } catch {}
    } else text += `\n[An image was attached here: ${a.name}]`
  }
  return parts.length ? { role: 'user', content: [{ type: 'text', text: text || 'What is in this picture?' }, ...parts] } : { role: 'user', content: text }
}
const imageCount = (m) => (m.attachments || []).filter((a) => a.kind === 'image').length
// what toModel will send, in characters (an image counted at its most)
function modelSize(m, images) {
  let n = String(m.content || '').length
  for (const a of m.attachments || []) n += a.kind === 'file' ? Math.min(a.inline ?? 3000, attachmentLength(a)) + a.name.length + 40 : images ? IMAGE_TOKENS * CHARS_PER_TOKEN : 60
  return n
}
// The history the model sees: a stopped or failed turn is left out (an empty reply, or a message that never got one),
// so the model never sees two user messages in a row or an empty answer.
function usableHistory(chat) {
  const out = []
  for (let i = 0; i < chat.length; i++) {
    const m = chat[i]
    if (m.role === 'assistant' && !String(m.content || '').trim()) continue
    if (m.role === 'user') { const next = chat[i + 1]; if (!next || next.role !== 'assistant' || !String(next.content || '').trim()) continue }
    out.push(m)
  }
  return out
}

// The system prompt holds only what stays the same from message to message (instructions, the profile), and the history
// follows unchanged, so llama.cpp reuses its cached prompt and reads only the new message. Everything that changes each
// turn (the time, recalled notes, past talks, web results, what this message is for) goes with the new message, at the end.
function buildMessages(c, chat, user, recalled, { web, allowSearch, showNotes, past = '', intent, think } = {}) {
  const today = new Date().toLocaleString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const sys = `${settings.systemPrompt}${profilePrompt()}${VOICE}${NOTE_TOOL}${settings.webSearch === 'auto' ? SEARCH_TOOL : ''}
Each user message may begin with a [Context for this message] block written by Murmur, not by the user: use it, never mention it.`
  let ctx = `Now: ${today}.`
  ctx += intent === 'remind' ? `\nThis message asks for a reminder: add one note block with its remind time. If they did not say when (no day or time at all), do not guess and write no note block: ask them when.`
    : intent === 'save' ? `\nThis message wants something kept: save it with exactly one note block (or one note-add to a matching note) holding only what this message wants kept, and say briefly that you did. If it points back ("that", "this", "save it"), what to keep is your previous reply or the user's previous message, written out in full in the note.`
    : `\nThis message does not ask to save anything: write no note blocks.`
  if (settings.webSearch === 'auto' && !allowSearch) ctx += web ? `\nYou already searched; answer from the results below, do not search again.` : `\nNo web search for this message.`
  if (showNotes) {
    // the whole note, so the answer can show what is in it
    ctx += recalled.length
      ? `\n\nThe user is asking for a note from their notebook. Show them what it says: its title in bold, then its content, keeping its steps, lists and details (tidy the formatting if needed, but do not shorten it or leave parts out). If several notes match, show the one that fits best and name the others. Do not save anything.\n\n` +
        recalled.map((r) => { const t = notes.find((x) => x.id === r.id)?.text || r.part; return `[${r.ref}] Note "${r.title}":\n${t.length > 6000 ? t.slice(0, 6000) + '\n[… rest cut]' : t}` }).join('\n\n')
      : `\n\nThe user is asking for a note, but no note in their notebook matches. Say so plainly and suggest the Notes list (☰). Do not make one up and do not save anything.`
  }
  const upcoming = notes.filter((n) => n.remind && !n.reminded).sort((a, b) => a.remind - b.remind).slice(0, 8)
  if (upcoming.length) ctx += `\n\nThe user's upcoming reminders:\n` + upcoming.map((n) => `- ${new Date(n.remind).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}: ${n.title}`).join('\n')
  if (!showNotes && recalled.length) {
    ctx += `\n\nBackground from the user's notebook (private context for you; use it when it helps, ignore it when it does not):\n` +
      recalled.map((r) => `- [${r.ref}] "${r.title}": ${r.part}`).join('\n')
  }
  ctx += past
  if (web) {
    ctx += `\n\nWeb search results for "${web.query}" (searched just now). Answer from them; when they disagree, prefer the newest and most official source. Do not end with a list of sources (the app shows them). If they do not answer the question, say so.\n` +
      web.results.map((r, i) => `[${i + 1}] ${r.title} — ${r.url}\n${r.snippet || ''}${r.text ? '\nPage text: ' + r.text : ''}`).join('\n\n')
  }
  const wrap = (t) => `[Context for this message]\n${ctx.trim()}\n[End of context]\n\n${t}`

  // pictures: the newest MAX_IMAGES in the conversation, this message's first
  const hist = usableHistory(chat)
  let imagesLeft = MAX_IMAGES - imageCount(user)
  const withImages = new Set()
  for (let i = hist.length - 1; i >= 0 && imagesLeft > 0; i--) if (imageCount(hist[i])) { withImages.add(hist[i]); imagesLeft -= imageCount(hist[i]) }

  // what is left of the context for the history, in characters: the context, less the reply (and thinking), the
  // instructions and this message with its context block
  const reply = 1024 + (think ? 3072 : 0) + 64
  const fixed = sys.length + wrap(String(user.content || '')).length + modelSize({ ...user, content: '' }, true)
  const budget = Math.max(0, (Number(settings.llmCtx) - reply) * CHARS_PER_TOKEN - fixed)
  // the window's first message stays the same turn after turn (see fitWindow), so the cached prefix holds
  const sizes = hist.map((m) => modelSize(m, withImages.has(m)) + 16)
  let start = c.windowFrom ? hist.findIndex((m) => m.at >= c.windowFrom) : 0
  if (start < 0) start = hist.length
  start = L.fitWindow(sizes, start, budget)
  c.windowFrom = start < hist.length ? hist[start].at : user.at // all trimmed: the window starts with this message
  const recent = hist.slice(start).map((m) => toModel(m, withImages.has(m)))

  const last = toModel(user, true)
  if (Array.isArray(last.content)) last.content[0].text = wrap(last.content[0].text)
  else last.content = wrap(last.content)
  return [{ role: 'system', content: sys }, ...recent, last]
}

// think: let the model reason first (Gemma's thinking, from the GGUF's own template). Its reasoning streams to onThink and
// never into the answer; requests that do not ask for it (titles, intent, learning) do not think at all.
// side: not the chat itself, so it runs on the second slot when there is one. background: it can wait (titles,
// learning), so it waits until no reply is being written and never slows one down. schema: the answer is held to this
// JSON schema (Murmur's own server only).
let chatBusy = 0
const idleWaiters = []
function chatIdle() { return chatBusy ? new Promise((res) => idleWaiters.push(res)) : null }
function chatEnd() { if (--chatBusy <= 0) { chatBusy = 0; idleWaiters.splice(0).forEach((res) => res()) } }
async function complete(messages, { onToken, onThink, signal, maxTokens = 1024, temperature = settings.temperature, think = false, side = true, background = false, schema = null } = {}) {
  if (background) while (chatBusy) await chatIdle()
  const managed = settings.llmMode !== 'external'
  lastLlmUse = Date.now()
  if (managed && servers.llm?.state === 'sleeping' && !(await ready('llm', 180000))) throw new Error('the chat model could not be started')
  const model = managed ? 'murmur' : settings.externalModel
  const headers = { 'Content-Type': 'application/json' }
  if (!managed && settings.externalKey) headers.Authorization = `Bearer ${settings.externalKey}`
  if (managed && llmKey) headers.Authorization = `Bearer ${llmKey}`
  const r = await fetch(llmBase() + '/chat/completions', {
    method: 'POST', headers, signal,
    body: JSON.stringify({
      model, messages, stream: !!onToken, temperature, max_tokens: think ? maxTokens + 3072 : maxTokens,
      // llama.cpp passes this to the chat template; other servers may refuse fields they do not know
      ...(managed ? { chat_template_kwargs: { enable_thinking: !!think }, cache_prompt: true } : {}),
      ...(managed && llmSlots > 1 ? { id_slot: side ? 1 : 0 } : {}),
      ...(managed && schema ? { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } } : {}),
    }),
  })
  lastLlmUse = Date.now()
  if (!r.ok) {
    const body = await r.text()
    if (/image input is not supported|mmproj/i.test(body)) throw new Error('this model cannot see images (set a vision/mmproj file in Settings)')
    if (/exceed|context size|too long/i.test(body)) throw new Error('this is too long for the model to read at once: start a new conversation, or attach less')
    throw new Error(`model answered ${r.status}: ${body.slice(0, 300)}`)
  }
  if (!onToken) { const j = await r.json(); return j.choices?.[0]?.message?.content || '' }
  let text = '', buf = ''
  const dec = new TextDecoder()
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return text
      try {
        const j = JSON.parse(data)
        if (j.timings && !side) log('llm timings', `prompt ${j.timings.prompt_n} tokens (cache ${j.timings.cache_n ?? '?'}) in ${Math.round(j.timings.prompt_ms)} ms, ${j.timings.predicted_n} out at ${Math.round(j.timings.predicted_per_second)}/s`)
        const delta = j.choices?.[0]?.delta || {}
        if (delta.reasoning_content) onThink?.(delta.reasoning_content)
        const d = delta.content
        if (d) { text += d; if (onToken(d, text) === false) return text }
      } catch {}
    }
  }
  return text
}

// One message at a time: a new one stops the reply still being written and waits until that turn has stored what it
// had, so the conversation stays in order. While a reply is on its way, background tasks wait (see complete).
let chatRun = Promise.resolve()
ipcMain.handle('chat:send', async (e, payload) => {
  const prev = chatRun
  chatAbort?.abort()
  let finish; chatRun = new Promise((r) => { finish = r })
  chatBusy++
  try {
    await Promise.race([prev, new Promise((r) => setTimeout(r, 3000))])
    return await sendChat(e, payload)
  } finally { chatEnd(); finish() }
})
const stopped = () => Object.assign(new Error('stopped'), { name: 'AbortError' })
async function sendChat(e, payload) {
  const { text: rawText, attachments = [], web: forceWeb = false } = typeof payload === 'string' ? { text: payload } : payload || {}
  const userText = String(rawText || '').trim()
  if (!userText && !attachments.length) return null
  clearTimeout(reflectT)
  const abort = chatAbort = new AbortController()
  const live = () => { if (abort.signal.aborted) throw stopped() }
  const c = conv // the reply belongs here even if another conversation is opened meanwhile
  const t0 = Date.now(), times = {}
  // events carry the conversation id, so the window ignores them once it shows a different one
  const send = (ch, v) => { if (!e.sender.isDestroyed()) e.sender.send(ch, { ...v, conv: c.id }) }
  const { list: atts, cut } = allotFiles(attachments)
  const user = { role: 'user', content: userText, at: Date.now(), ...(atts.length ? { attachments: atts } : {}) }
  const history = c.messages.slice()
  c.messages.push(user); c.updated = Date.now(); saveConv(c)
  if (c.messages.length === 1) { c.title = firstWords(userText || attachments[0].name); win?.webContents.send('chats-changed') }
  // the reply box (and Stop) shows at once, before the intent and recall steps
  send('chat:start', { cut })
  let partial = '', thought = '', thoughtStart = 0, recalledIds = [], chatIds = []
  try {
    if (settings.llmMode !== 'external' && servers.llm?.state === 'sleeping') send('chat:status', { text: 'Waking the chat model…' })
    // what the message is for, and its meaning as a vector, at the same time; the vector serves both recall searches
    const qvP = userText && servers.memory?.state === 'ready' ? embed([userText], 'query').then((v) => v[0]).catch(() => null) : Promise.resolve(null)
    const [intent, qv] = await Promise.all([readIntent(userText, history.findLast((m) => m.role === 'assistant')?.content, abort.signal), qvP])
    times.intent = Date.now() - t0
    live()
    log('intent', intent.by, intent.intent, intent.topic, intent.past ? 'past' : '')
    // notes are kept only when the message wants that, never on the model's own idea
    const mayStore = intent.intent === 'save' || intent.intent === 'remind'
    // asking for a note: looked up by its topic ("get tapsilog note" -> "tapsilog"), more loosely, and the whole note goes to the model
    const showNotes = intent.intent === 'show_note'
    const topic = showNotes ? intent.topic || userText.replace(/\b(please|can you|could you|get|show|open|read|find|retrieve|pull up|look up|display|see|check|give me|me|my|the|a|an|notes?|about|on|for|what('?s| is| was) in)\b/gi, ' ').replace(/[\s?.!]+/g, ' ').trim() || userText : userText
    const wide = intent.past
    const [found, pastChats] = await Promise.all([
      userText ? searchNotes(topic, showNotes ? 3 : settings.recallCount, showNotes ? settings.recallMin - 0.07 : settings.recallMin, 0.06, topic === userText ? qv : null) : [],
      userText && !showNotes && !mayStore ? searchChats(userText, c.id, wide, qv) : [], // saving needs no old talks
    ])
    times.recall = Date.now() - t0
    live()
    const recalled = found.map((r, i) => ({ ...r, ref: 'n' + (i + 1) }))
    const past = pastPrompt(pastChats, c.id, wide && !showNotes)
    recalledIds = recalled.map(({ id, title }) => ({ id, title }))
    chatIds = [...new Map(pastChats.map((p) => [p.conv, { conv: p.conv, title: p.title }])).values()]
    send('chat:recall', { recalled: recalledIds, chats: chatIds })
    const searchOn = settings.webSearch !== 'off'
    let web = null
    const doSearch = async (query) => {
      send('chat:status', { text: `Searching the web: ${query}` })
      try { web = { query, results: await websearch().research(query) } } catch (err) { web = { query, results: [] }; send('chat:status', { text: `Web search failed: ${err.message}` }) }
      send('chat:status', { text: '' })
      live()
    }
    if (forceWeb && searchOn) await doSearch(userText.slice(0, 200) || 'image search')
    let reply = ''
    for (let round = 0; round < 2; round++) {
      const messages = buildMessages(c, history, user, recalled, { web, showNotes, past, intent: intent.intent, think: settings.thinking, allowSearch: !showNotes && searchOn && settings.webSearch === 'auto' && !web })
      // hold the first characters back until it is clear the model is not asking for a search
      let shown = 0, asked = null
      reply = await complete(messages, {
        signal: abort.signal, side: false,
        think: settings.thinking,
        onThink: (t) => { if (!thoughtStart) thoughtStart = Date.now(); thought += t; send('chat:think', { t }) },
        onToken: (_t, all) => {
          if (!times.first) times.first = Date.now() - t0
          const lead = all.trimStart()
          if (!web && '<search>'.startsWith(lead.slice(0, 8)) && lead.length < 8) return
          if (!web && lead.startsWith('<search>')) { const m = lead.match(/^<search>([\s\S]*?)<\/search>/); if (m) { asked = m[1].trim(); return false } return }
          send('chat:token', { t: all.slice(shown) }); shown = all.length; partial = all
        },
      })
      if (!asked) { if (reply.length > shown) send('chat:token', { t: reply.slice(shown) }); break }
      await doSearch(asked)
    }
    // note blocks only count when this turn may save (never when the user just asked to see a note), and only the first:
    // a second block is the model saving things nobody asked for
    const saved = []
    const { text: clean, blocks } = L.extractNoteBlocks(reply)
    reply = clean
    const b = mayStore ? blocks.find((x) => x.body) : null
    if (b?.type === 'add') {
      const n = appendNote(recalled.find((r) => r.ref === b.ref)?.id, b.body); if (n) saved.push({ ...n, added: true })
    } else if (b) {
      const when = parseWhen(b.remind)
      if (b.remind && !(when > Date.now())) log('reminder time not understood:', b.remind)
      if (when > Date.now()) { const n = addNote({ title: b.title, text: b.body, source: 'chat' }); n.remind = when; saveNotes(); saved.push(n) }
      else {
        // same title as a note already there: add to it rather than make a twin
        // a recalled note whose title words hold this one's ("Cabin wifi" -> "Wifi password for the cabin") is the same topic
        const words = keyWords(b.title), covers = (t) => { const k = keyWords(t); return words.length > 0 && words.every((w) => k.some((x) => x.startsWith(w) || w.startsWith(x))) }
        const twin = b.title && (notes.find((n) => n.title.trim().toLowerCase() === b.title.toLowerCase()) || notes.find((n) => recalled.some((r) => r.id === n.id) && covers(n.title)))
        saved.push(twin ? { ...appendNote(twin.id, b.body), added: true } : addNote({ title: b.title, text: b.body, source: 'chat' }))
      }
    }
    // the message wanted something kept but the model wrote no note block (it may even say it did): keep it here.
    // "save that" means the previous reply, anything else the message itself; the model names the note afterwards.
    if (intent.intent === 'save' && !saved.length) {
      const prev = history.findLast((m) => m.role === 'assistant')?.content
      const pointsBack = prev && userText.length < 80 && /\b(that|this|it|those|these|above)\b/i.test(userText)
      saved.push(addNote({ title: '', text: pointsBack ? prev : userText, source: 'chat' }))
      if (!reply) reply = 'Saved.'
    }
    // a reminder was asked for but none was set (a time that could not be read, or already past): the reply may still
    // say "I'll remind you", so say plainly what happened. A question back ("When?") needs no warning.
    if (intent.intent === 'remind' && !saved.some((n) => n.remind) && !(saved.length === 0 && /\?\s*$/.test(reply))) {
      const plain = saved.length ? `I saved it as a note, but couldn't work out the time, so no reminder is set. Open the note and use ⏰ to set it.` : `I couldn't work out when to remind you, so no reminder is set. Tell me the day and time, or set it with ⏰ in a note.`
      reply = `${reply ? reply + '\n\n' : ''}⚠️ ${plain}`
    }
    // the model sometimes answers with the note block alone
    if (!reply && saved.length) reply = saved.map((n) => n.remind ? `I'll remind you: **${n.title}**, ${new Date(n.remind).toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : `Saved to **${n.title}**.`).join('\n')
    const sources = web?.results.slice(0, 5).map(({ title, url }) => ({ title, url })) || []
    const at = Date.now()
    const thinking = thought.trim() ? { thinking: thought.trim(), thoughtMs: Date.now() - thoughtStart } : {}
    const savedOut = saved.map(({ id, title, added, remind }) => ({ id, title, ...(added ? { added } : {}), ...(remind ? { remind } : {}) }))
    c.messages.push({ role: 'assistant', content: reply, at, ...thinking, recalled: recalledIds, ...(chatIds.length ? { chats: chatIds } : {}), saved: savedOut, ...(sources.length ? { sources } : {}) })
    c.updated = Date.now(); saveConv(c)
    send('chat:done', { at, ...thinking, text: reply, saved: savedOut, sources, recalled: recalledIds, chats: chatIds })
    log('timing', `intent ${times.intent} ms, recall ${times.recall} ms, first token ${times.first ?? '-'} ms, done ${Date.now() - t0} ms`)
    nameConv(c)
    maybeReflect()
    indexChats()
    return true
  } catch (err) {
    const wasStopped = err.name === 'AbortError' || abort.signal.aborted
    // what was written so far is kept (the window still shows it); a turn with nothing is stored as stopped or failed,
    // and left out of what the model sees next time (usableHistory)
    const kept = L.extractNoteBlocks(partial).text
    const at = Date.now()
    const thinking = thought.trim() ? { thinking: thought.trim(), thoughtMs: Date.now() - (thoughtStart || at) } : {}
    c.messages.push({ role: 'assistant', content: kept, at, ...thinking, recalled: recalledIds, ...(wasStopped ? { stopped: true } : { error: String(err.message).slice(0, 300) }) })
    c.updated = Date.now(); saveConv(c)
    send('chat:done', { at, error: wasStopped ? 'stopped' : err.message, text: kept })
    return false
  }
}
let ws = null
function websearch() { return (ws ||= require('./websearch')) }
ipcMain.handle('app:openUrl', (_e, url) => { if (/^(https?:\/\/|mailto:)/i.test(url)) shell.openExternal(url) })
ipcMain.handle('app:info', () => ({ version: app.getVersion(), electron: process.versions.electron }))
ipcMain.handle('attach:image', (_e, id) => { try { return 'data:image/jpeg;base64,' + fs.readFileSync(path.join(ATTACH_DIR, String(id).replace(/[^\w-]/g, '') + '.jpg')).toString('base64') } catch { return null } })
ipcMain.handle('chat:rate', (_e, convId, at, rating) => {
  const c = convs.get(convId), m = c?.messages.find((x) => x.at === at && x.role === 'assistant')
  if (!m) return false
  if (rating) m.rating = rating; else delete m.rating
  // a rating on an older reply is still something to learn from
  if (m.at <= profile.learnedFrom && rating) profile.learnedFrom = Math.min(profile.learnedFrom, m.at - 1)
  saveConv(c); return true
})
ipcMain.handle('profile:get', () => ({ ...profile, learn: settings.learn }))
ipcMain.handle('profile:set', (_e, p) => {
  if (Array.isArray(p.facts)) profile.facts = p.facts.map((f) => ({ id: f.id || crypto.randomUUID(), text: String(f.text || '').trim().slice(0, 200), at: f.at || Date.now() })).filter((f) => f.text)
  if (typeof p.persona === 'string') profile.persona = p.persona.trim().slice(0, 2000)
  if (typeof p.learn === 'boolean') { settings.learn = p.learn; writeJson(SETTINGS_FILE, settings) }
  saveProfile(); return { ...profile, learn: settings.learn }
})
ipcMain.handle('profile:reflect', async () => { clearTimeout(reflectT); const ok = await reflect(true); return { ok, profile: { ...profile, learn: settings.learn } } })
ipcMain.handle('profile:reset', (_e, what) => {
  if (what !== 'facts') profile.persona = ''
  if (what !== 'persona') profile.facts = []
  saveProfile(); return { ...profile, learn: settings.learn }
})
ipcMain.handle('chat:stop', () => { chatAbort?.abort(); return true })
ipcMain.handle('chat:history', () => ({ id: conv.id, title: conv.title, messages: conv.messages }))
ipcMain.handle('chat:new', () => {
  if (!conv.messages.length) return conv.id // already on an empty one
  conv = newConv(); return conv.id
})
ipcMain.handle('chat:open', (_e, id) => { const c = convs.get(id); if (c) conv = c; return { id: conv.id, title: conv.title, messages: conv.messages } })
ipcMain.handle('chat:list', (_e, q) => {
  q = String(q || '').trim().toLowerCase()
  return [...convs.values()]
    .filter((c) => c.messages.length && (!q || c.title.toLowerCase().includes(q) || c.messages.some((m) => String(m.content).toLowerCase().includes(q))))
    .sort((a, b) => b.updated - a.updated).map(convSummary)
})
ipcMain.handle('chat:rename', (_e, id, title) => { const c = convs.get(id); if (!c || !String(title).trim()) return false; c.title = String(title).trim().slice(0, 80); c.titled = true; saveConv(c); return true })
ipcMain.handle('chat:delete', (_e, id) => {
  const gone = convs.get(id)
  convs.delete(id)
  // its attached files and pictures go with it
  for (const m of gone?.messages || []) for (const a of m.attachments || []) removeAttachment(a.id)
  try { fs.unlinkSync(path.join(CHATS_DIR, id + '.json')) } catch {}
  if (conv?.id === id) conv = latestConv() || newConv()
  return conv.id
})

// ---------- ears ----------

const SILENCE_JUNK = /^\s*(\[[^\]]*\]|\([^)]*\)|thank you\.?|thanks for watching!?|you|\.+|bye\.?)\s*$/i
// names Whisper should know (people, places, dishes from the notes and the profile), refreshed every few minutes
let hints = { text: '', at: 0 }
function whisperPrompt() {
  if (!settings.whisperHints) return ''
  if (Date.now() - hints.at > 5 * 6e4) hints = { text: L.whisperHints([...profile.facts.map((f) => f.text), ...notes.slice(0, 40).map((n) => n.title)]), at: Date.now() }
  return hints.text
}
async function transcribe(wav) {
  lastEarsUse = Date.now()
  if (servers.ears?.state !== 'ready' && !(await ready('ears', 60000))) throw new Error('Whisper is not running. Check Settings.')
  const form = new FormData()
  form.append('file', new Blob([Buffer.from(wav)], { type: 'audio/wav' }), 'speech.wav')
  form.append('temperature', '0.0')
  form.append('response_format', 'json')
  const prompt = whisperPrompt()
  if (prompt) form.append('prompt', prompt)
  const r = await fetch(`http://127.0.0.1:${settings.whisperPort}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) })
  lastEarsUse = Date.now()
  if (!r.ok) throw new Error(`whisper answered ${r.status}`)
  const j = await r.json()
  const text = String(j.text || '').replace(/\[BLANK_AUDIO\]/g, '').replace(/\s+/g, ' ').trim()
  // Whisper sometimes repeats the hint list back on silence
  if (prompt && text && prompt.toLowerCase().includes(text.toLowerCase().replace(/[.,!?]+$/, ''))) return ''
  return SILENCE_JUNK.test(text) ? '' : text
}
ipcMain.handle('ears:transcribe', (_e, wav) => transcribe(wav))
// the mic was pressed: a resting Whisper starts now, while the user is still talking
ipcMain.handle('ears:wake', () => { lastEarsUse = Date.now(); if (servers.ears?.state === 'sleeping') startEars(); return servers.ears?.state || 'off' })
ipcMain.handle('ears:dictating', (_e, on) => { dict = !!on; lastEarsUse = Date.now() })

// ---------- speech detector (Silero VAD) ----------
// A 2 MB model that tells speech from noise far better than loudness does (fans, typing, music). It runs here, on the
// CPU, about 0.1 ms per 32 ms of sound. The window falls back to the loudness gate when it is not there.
let vad = null, vadLoading = null
function vadLoad() {
  if (vad || vadLoading) return vadLoading || Promise.resolve(true)
  vadLoading = (async () => {
    const file = path.join(BIN, 'vad', 'silero_vad.onnx')
    if (!fs.existsSync(file)) { log('vad model missing', file); return false }
    const ort = require('onnxruntime-node')
    const sess = await ort.InferenceSession.create(file, { intraOpNumThreads: 1, interOpNumThreads: 1 })
    vad = { ort, sess, state: new Float32Array(256), ctx: new Float32Array(64), sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []) }
    return true
  })().catch((e) => { log('vad failed', e.message); return false }).finally(() => { vadLoading = null })
  return vadLoading
}
ipcMain.handle('vad:start', async () => {
  if (settings.vad !== 'silero' || !(await vadLoad())) return false
  vad.state = new Float32Array(256); vad.ctx = new Float32Array(64)
  return true
})
// one frame of 512 samples (16 kHz) -> how likely it is speech, 0-1. Silero v5 wants the last 64 samples in front.
ipcMain.handle('vad:prob', async (_e, frame) => {
  if (!vad) return -1
  const f = frame instanceof Float32Array ? frame : Float32Array.from(frame)
  const input = new Float32Array(64 + f.length); input.set(vad.ctx); input.set(f, 64); vad.ctx = f.slice(-64)
  const { ort, sess } = vad
  const out = await sess.run({ input: new ort.Tensor('float32', input, [1, input.length]), state: new ort.Tensor('float32', vad.state, [2, 1, 128]), sr: vad.sr })
  vad.state = new Float32Array(out.stateN.data)
  return out.output.data[0]
})

// ---------- typing what you say into the app in front ----------
// Each phrase goes through the clipboard and Ctrl+V (what the user had copied is put back right after), sent by one
// PowerShell that stays open, so a phrase lands in about a tenth of a second. A small badge on screen says the mic is on.
let typer = null, typeBadge = null
function typeText(text) {
  if (!text) return
  if (!typer) {
    typer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'], { windowsHide: true })
    typer.on('exit', () => { typer = null })
    typer.stdin.on('error', () => {})
    typer.stdin.write('Add-Type -AssemblyName System.Windows.Forms\n')
  }
  const before = { text: clipboard.readText(), image: clipboard.readImage() }
  clipboard.writeText(text + ' ')
  typer.stdin.write("[System.Windows.Forms.SendKeys]::SendWait('^v')\n")
  setTimeout(() => { if (!before.image.isEmpty()) clipboard.writeImage(before.image); else clipboard.writeText(before.text) }, 700)
}
ipcMain.handle('type:text', (_e, text) => typeText(String(text || '').trim()))
ipcMain.handle('type:state', (_e, on) => {
  dict = !!on
  if (on && !typeBadge) {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    typeBadge = new BrowserWindow({ width: 330, height: 38, x: Math.round(d.workArea.x + d.workArea.width / 2 - 165), y: d.workArea.y + 12, frame: false, resizable: false, movable: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, show: false, transparent: true, backgroundColor: '#00000000', webPreferences: { sandbox: true } })
    typeBadge.setAlwaysOnTop(true, 'screen-saver'); typeBadge.setIgnoreMouseEvents(true)
    const keys = settings.hotkeyType.replace(/Control/g, 'Ctrl')
    typeBadge.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<body style="margin:0;font:13px system-ui;background:transparent"><div style="margin:2px;padding:8px 14px;border-radius:16px;background:#15161aee;color:#e7e7ea;border:1px solid #ff5d6c;display:flex;gap:8px;align-items:center"><span style="width:9px;height:9px;border-radius:50%;background:#ff5d6c"></span>Typing what you say · ${keys} to stop</div></body>`))
    typeBadge.once('ready-to-show', () => typeBadge?.showInactive())
    typeBadge.on('closed', () => { typeBadge = null })
  } else if (!on && typeBadge) typeBadge.close()
  tray?.setToolTip(on ? 'Murmur: typing what you say' : 'Murmur')
})

// ---------- ask about the screen ----------
// The screen under the mouse is captured (Murmur steps aside first), the user drags a box around the part they mean
// (Enter or a click without dragging = all of it, Esc = cancel), and it is attached to the next message.
let snipping = false
async function captureScreen() {
  if (snipping || !win) return
  snipping = true
  const wasVisible = win.isVisible()
  try {
    if (wasVisible) { win.hide(); await new Promise((r) => setTimeout(r, 300)) }
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || sources[0]
    if (!src || src.thumbnail.isEmpty()) throw new Error('the screen could not be captured')
    const shot = src.thumbnail
    const rect = await pickRegion(d, shot)
    if (!rect) return
    const k = shot.getSize().width / d.size.width
    const crop = rect === 'all' ? shot : shot.crop({ x: Math.round(rect.x * k), y: Math.round(rect.y * k), width: Math.max(1, Math.round(rect.width * k)), height: Math.max(1, Math.round(rect.height * k)) })
    const fit = (img, max) => { const { width, height } = img.getSize(), f = Math.min(1, max / Math.max(width, height)); return f < 1 ? img.resize({ width: Math.round(width * f), height: Math.round(height * f), quality: 'best' }) : img }
    fs.mkdirSync(ATTACH_DIR, { recursive: true })
    const id = crypto.randomUUID()
    fs.writeFileSync(path.join(ATTACH_DIR, id + '.jpg'), fit(crop, 1280).toJPEG(88))
    const thumb = 'data:image/jpeg;base64,' + fit(crop, 320).toJPEG(75).toString('base64')
    showWin()
    win.webContents.send('attach:pushed', { id, kind: 'image', name: 'Screen.jpg', thumb })
  } catch (e) {
    log('screen capture failed', e.message)
    if (wasVisible || win) { showWin(); win.webContents.send('chat:notice', { text: 'Screen capture failed: ' + e.message }) }
  } finally {
    snipping = false
    if (wasVisible && !win.isVisible()) showWin()
  }
}
function pickRegion(d, shot) {
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, frame: false, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#000000', enableLargerThanScreen: true,
      webPreferences: { preload: path.join(__dirname, 'snip-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    let done = false
    const finish = (r) => { if (done) return; done = true; ipcMain.removeListener('snip:done', onDone); if (!w.isDestroyed()) w.close(); resolve(r) }
    const onDone = (e, r) => { if (e.sender === w.webContents) finish(r === 'all' ? 'all' : r && r.width > 4 && r.height > 4 ? r : r ? 'all' : null) }
    ipcMain.on('snip:done', onDone)
    w.on('closed', () => finish(null))
    w.loadFile(path.join(__dirname, 'renderer', 'snip.html'))
    w.webContents.once('did-finish-load', () => {
      w.webContents.send('snip:image', 'data:image/jpeg;base64,' + shot.toJPEG(85).toString('base64'))
      w.setBounds(d.bounds); w.show(); w.focus()
    })
  })
}
ipcMain.handle('screen:capture', () => captureScreen())

// dictation finished: the model turns the spoken words into a written note (the same ideas, put in order); the words as
// they were said stay with the note (note.transcript) in case something was misheard or left out
const ORGANIZE = `You turn what someone said out loud into a clear written note in their notebook.
- Keep every idea, fact, name, number and detail they said. Do not add anything, do not give advice, do not answer questions they asked themselves.
- Drop filler words, false starts, repeats and "um, so, like".
- Put related things together and in a sensible order. Use short paragraphs, and "- " bullet points for lists of things. When they talked about clearly separate topics, give each a "## " heading; a note about one thing needs no headings.
- No tasks, no checkboxes, no "To do" sections, no summary on top: just the note. Things they mean to do stay plain sentences in their words ("I need to call Mark…").
- A heading line always starts with "## " and names a topic they talked about (like "Chairs", "Pricing"), never "Action items", "To do", "Next steps" or "Summary". Each detail goes under the topic it is about.
- Keep their own voice ("I", "my") and the language they spoke.
Answer in exactly this form:
Title: <2-8 words saying what the note is about>

<the note>`
ipcMain.handle('notes:fromDictation', async (_e, transcript) => {
  transcript = String(transcript || '').trim()
  if (!transcript) return null
  let title = '', text = transcript
  if (settings.tidyNotes && servers.llm?.state === 'ready') {
    try {
      const out = (await complete([{ role: 'system', content: ORGANIZE }, { role: 'user', content: transcript }],
        { maxTokens: Math.min(6000, Math.ceil(transcript.length / 2.5) + 300), temperature: 0.2 })).trim()
      const m = out.match(/^\s*\**title:?\**\s*(.+?)\s*\n([\s\S]+)$/i)
      if (m && m[2].trim().length > 3) { title = m[1].replace(/[*#"]/g, '').trim().slice(0, 80); text = m[2].trim() }
      else log('organize: unexpected answer', JSON.stringify(out.slice(0, 200)))
    } catch (err) { log('organize failed', err.message) }
  }
  return addNote({ title, text, source: 'voice', ...(text !== transcript ? { transcript } : {}) })
})

// ---------- notes ipc ----------

ipcMain.handle('notes:list', () => notes)
ipcMain.handle('notes:get', (_e, id) => notes.find((n) => n.id === id) || null)
ipcMain.handle('notes:create', (_e, n) => addNote(n || {}))
ipcMain.handle('notes:update', (_e, n) => {
  const i = notes.findIndex((x) => x.id === n.id); if (i < 0) return null
  const next = { ...notes[i] }
  const edited = 'title' in n || 'text' in n // pinning or a reminder is not an edit
  if ('title' in n) next.title = String(n.title || '').trim() || 'Untitled note'
  if ('text' in n) next.text = String(n.text || '')
  if ('pinned' in n) next.pinned = !!n.pinned
  if ('remind' in n) { next.remind = Number(n.remind) || null; next.reminded = false }
  if (edited) next.updated = Date.now()
  notes[i] = next; saveNotes()
  if (edited) indexNotes()
  return next
})
ipcMain.handle('notes:delete', (_e, id) => {
  const n = notes.find((x) => x.id === id); if (!n) return false
  notes = notes.filter((x) => x.id !== id); trash.unshift({ ...n, deleted: Date.now() })
  saveNotes(); saveTrash(); indexNotes(); return true
})
ipcMain.handle('notes:trash', () => trash)
ipcMain.handle('notes:restore', (_e, id) => {
  const n = trash.find((x) => x.id === id); if (!n) return null
  trash = trash.filter((x) => x.id !== id); delete n.deleted; notes.unshift(n)
  saveNotes(); saveTrash(); indexNotes(); return n
})
ipcMain.handle('notes:purge', (_e, id) => { trash = id ? trash.filter((x) => x.id !== id) : []; saveTrash(); return true })

// the model reads a note and adds a summary on top or a checklist of what is to be done at the end
const NOTE_AI = {
  summary: 'Summarize this note in 1-5 short bullet points (lines starting with "- ") of its main points. Answer with the bullet points only. Use the language of the note.',
  todos: 'List the tasks, things to do or buy, and follow-ups in this note as a checklist, one per line, each line starting with "- [ ] ". Answer with the checklist only. If there are none, answer NONE. Use the language of the note.',
}
ipcMain.handle('notes:ai', async (_e, id, action) => {
  const n = notes.find((x) => x.id === id)
  if (!n || !NOTE_AI[action]) return null
  if (action === 'summary' && n.text.length < 400) return { note: n, added: false, message: 'This note is already short.' }
  let out = (await complete([{ role: 'system', content: NOTE_AI[action] }, { role: 'user', content: `${n.title}\n\n${n.text}`.slice(0, 12000) }], { maxTokens: 600, temperature: 0.2 })).trim()
  if (action === 'todos') {
    // only tasks the note does not already have as a checklist
    const key = (t) => t.replace(/^\s*[-*] \[[ xX]\]\s*/, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const have = new Set(n.text.split('\n').filter((l) => /^\s*[-*] \[[ xX]\]/.test(l)).map(key))
    out = out.split('\n').filter((l) => /^\s*[-*] \[ \]\s*\S/.test(l) && !have.has(key(l))).join('\n')
  }
  if (!out || /^NONE\b/i.test(out)) return { note: n, added: false, message: action === 'todos' ? 'No new tasks found in this note.' : 'Nothing to add.' }
  n.text = action === 'summary' ? `Summary:\n${out}\n\n${n.text.trim()}` : `${n.text.trim()}\n\nTo do:\n${out}`
  n.updated = Date.now(); saveNotes(); indexNotes(); win?.webContents.send('notes-changed')
  return { note: n, added: true }
})

ipcMain.handle('notes:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import notes', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Notes and documents', extensions: ['md', 'markdown', 'txt', 'pdf', 'docx'] }, { name: 'All files', extensions: ['*'] }] })
  if (r.canceled) return 0
  let count = 0
  for (const f of r.filePaths) {
    try {
      const text = String(await fileToText(f, fs.readFileSync(f))).replace(/\r\n/g, '\n').trim()
      if (!text) continue
      const head = text.match(/^#\s+(.+)\n+/) // "# Title" on top (Murmur's own export) stays the title
      addNote({ title: head ? head[1] : path.basename(f).replace(/\.[^.]+$/, ''), text: head ? text.slice(head[0].length) : text, source: 'file' })
      count++
    } catch (e) { log('import failed', f, e.message) }
  }
  return count
})

// reminders: a Windows notification and a line in the chat when one is due
const toasts = new Set() // kept so a click still reaches us
function checkReminders() {
  const due = notes.filter((n) => n.remind && !n.reminded && n.remind <= Date.now())
  if (!due.length) return
  for (const n of due) {
    n.reminded = true
    win?.webContents.send('note:due', { id: n.id, title: n.title })
    if (!Notification.isSupported()) continue
    const t = new Notification({ title: '⏰ ' + n.title, body: n.text.replace(/\s+/g, ' ').slice(0, 140), icon: path.join(__dirname, 'renderer', 'icon.png') })
    t.on('click', () => { if (win) { win.show(); win.focus(); win.webContents.send('note:open', n.id) } toasts.delete(t) })
    t.on('close', () => toasts.delete(t))
    toasts.add(t); t.show()
  }
  saveNotes(); win?.webContents.send('notes-changed')
}
setInterval(checkReminders, 20000)
ipcMain.handle('notes:search', (_e, q) => searchNotes(q, 20, settings.recallMin - 0.03, 0))
ipcMain.handle('notes:export', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Export notes to folder', properties: ['openDirectory', 'createDirectory'] })
  if (r.canceled || !r.filePaths[0]) return 0
  for (const n of notes) {
    const name = (n.title || 'note').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 60).trim() || 'note'
    fs.writeFileSync(path.join(r.filePaths[0], `${name} (${n.id.slice(0, 4)}).md`), `# ${n.title}\n\n${n.text}\n`)
  }
  shell.openPath(r.filePaths[0])
  return notes.length
})

// ---------- settings ipc ----------

function foundModels() {
  const list = { whisper: [], llm: [] }
  const walk = (dir, re, out, depth = 3) => {
    try {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, d.name)
        if (d.isDirectory() && depth > 0) walk(p, re, out, depth - 1)
        else if (re.test(d.name)) out.push(p)
      }
    } catch {}
  }
  walk(OBS_MODELS, /^ggml-.*\.bin$/i, list.whisper)
  walk(path.join(WHISPER_BUILD, 'models'), /^ggml-(?!.*for-tests).*\.bin$/i, list.whisper, 0)
  walk(path.join(HOME, '.lmstudio', 'models'), /^(?!mmproj|mtp-).*\.gguf$/i, list.llm, 3)
  return list
}
ipcMain.handle('settings:get', () => ({ settings, defaults: DEFAULTS, found: foundModels(), dataDir: DATA }))
ipcMain.handle('settings:set', (_e, next) => {
  const before = settings
  settings = { ...settings, ...next }
  writeJson(SETTINGS_FILE, settings)
  const changed = (keys) => keys.some((k) => String(before[k]) !== String(settings[k]))
  if (changed(['llmMode', 'llamaServer', 'llmModel', 'llmDraft', 'llmVision', 'llmPort', 'llmCtx', 'llmArgs', 'externalUrl', 'externalModel', 'externalKey'])) startLlm()
  if (changed(['whisperServer', 'whisperModel', 'whisperPort', 'whisperLang'])) startEars()
  if (changed(['embedDir', 'embedModel', 'embedDtype'])) { vectors.clear(); chatVectors.clear(); startEmbedder() }
  if (changed(['hotkeyShow', 'hotkeyDictate', 'hotkeyScreen', 'hotkeyType'])) registerHotkeys()
  if (changed(['startAtLogin'])) applyLogin()
  if (changed(['vad']) && settings.vad === 'silero') vadLoad()
  win?.setAlwaysOnTop(!!settings.alwaysOnTop)
  return settings
})
ipcMain.handle('settings:restart', (_e, which) => { if (which === 'llm') startLlm(); if (which === 'ears') startEars(); if (which === 'memory') startEmbedder(); return true })
ipcMain.handle('settings:pick', async (_e, opts) => {
  const r = await dialog.showOpenDialog(win, { properties: [opts?.folder ? 'openDirectory' : 'openFile'], filters: opts?.filters })
  return r.canceled ? null : r.filePaths[0]
})
ipcMain.handle('status', () => statusAll())

// ---------- setup: download what this PC is missing ----------
// Downloads go to <data>/models as .part files and resume where they stopped; a finished file fills in its setting.
const downloading = new Map() // key -> AbortController
function setupStatus() {
  return Object.entries(DOWNLOADS).map(([key, d]) => {
    const target = path.join(MODELS_DIR, d.file)
    const part = target + '.part'
    return {
      key, label: d.label, required: !!d.required,
      have: !!settings[key] && fs.existsSync(settings[key]),
      path: settings[key], busy: downloading.has(key),
      partial: fs.existsSync(part) ? fs.statSync(part).size : 0,
    }
  })
}
// Hugging Face names a large file's SHA-256 and size in the headers of its download link (before the redirect)
async function expectedFile(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(15000) })
    const sha = String(r.headers.get('x-linked-etag') || '').match(/[0-9a-f]{64}/i)?.[0]?.toLowerCase()
    return { sha, size: Number(r.headers.get('x-linked-size')) || 0 }
  } catch (e) { log('could not get the file hash', e.message); return {} }
}
function sha256File(file, signal) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256'), st = fs.createReadStream(file, { highWaterMark: 4 << 20 })
    signal?.addEventListener('abort', () => st.destroy(Object.assign(new Error('paused'), { name: 'AbortError' })))
    st.on('data', (b) => h.update(b)); st.on('error', reject); st.on('end', () => resolve(h.digest('hex')))
  })
}
async function download(key) {
  const d = DOWNLOADS[key]
  if (!d || downloading.has(key)) return
  const ctl = new AbortController(); downloading.set(key, ctl)
  const target = path.join(MODELS_DIR, d.file), part = target + '.part'
  const tell = (v) => win?.webContents.send('setup:progress', { key, ...v })
  try {
    fs.mkdirSync(MODELS_DIR, { recursive: true })
    const want = await expectedFile(d.url)
    let have = fs.existsSync(part) ? fs.statSync(part).size : 0
    const r = await fetch(d.url, { headers: have ? { Range: `bytes=${have}-` } : {}, signal: ctl.signal, redirect: 'follow' })
    if (r.status === 416) have = 0 // the part file is already whole
    else if (!r.ok) throw new Error(`download failed (${r.status})`)
    if (r.status === 200) have = 0 // the server ignored the range: start over
    const total = have + Number(r.headers.get('content-length') || 0)
    if (r.status !== 416) {
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' })
      let got = have, lastTell = 0
      try {
        for await (const chunk of r.body) {
          if (!out.write(chunk)) await new Promise((res) => out.once('drain', res))
          got += chunk.length
          if (Date.now() - lastTell > 300) { lastTell = Date.now(); tell({ got, total }) }
        }
      } finally { await new Promise((res) => out.end(res)) }
    }
    // the file must be whole and exactly the one Hugging Face lists (its SHA-256), or it is not used
    const size = fs.statSync(part).size
    if (want.size && size < want.size) throw new Error(`the download stopped early (${Math.round(size / 1e6)} of ${Math.round(want.size / 1e6)} MB): click Download to go on`)
    if (want.size && size > want.size) { fs.unlinkSync(part); throw new Error('the download was damaged: click Download to fetch it again') }
    if (want.sha) {
      tell({ checking: true })
      const sha = await sha256File(part, ctl.signal)
      if (sha !== want.sha) { fs.unlinkSync(part); log('hash mismatch', key, sha, want.sha); throw new Error('the download was damaged: click Download to fetch it again') }
    } else log('no hash to check for', key)
    fs.renameSync(part, target)
    settings[key] = target; writeJson(SETTINGS_FILE, settings)
    tell({ done: true })
    if (key.startsWith('llm')) startLlm()
    if (key === 'whisperModel') startEars()
  } catch (err) {
    tell({ error: err.name === 'AbortError' ? 'paused' : err.message })
  } finally { downloading.delete(key) }
}
ipcMain.handle('setup:status', () => setupStatus())
ipcMain.handle('setup:download', (_e, keys) => { for (const k of keys) download(k); return true })
ipcMain.handle('setup:pause', () => { for (const c of downloading.values()) c.abort(); return true })
ipcMain.handle('app:openData', () => shell.openPath(DATA))

// ---------- window and tray ----------
// Murmur lives in the tray: the close button hides the window (reminders still come), Quit in the tray menu ends it.

let tray = null, quitting = false
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus() }
ipcMain.handle('win:minimize', () => win?.minimize())
ipcMain.handle('win:close', () => win?.close())
ipcMain.handle('win:pin', () => { settings.alwaysOnTop = !settings.alwaysOnTop; writeJson(SETTINGS_FILE, settings); win?.setAlwaysOnTop(settings.alwaysOnTop); return settings.alwaysOnTop })

function createTray() {
  if (tray) return
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'renderer', 'icon.png')).resize({ width: 16, height: 16, quality: 'best' }))
  tray.setToolTip('Murmur')
  tray.on('click', () => (win?.isVisible() && win.isFocused() ? win.hide() : showWin()))
  trayMenu()
}
function trayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Murmur', click: showWin },
    { label: 'Dictate a note', click: () => { showWin(); win?.webContents.send('hotkey:dictate') } },
    { label: 'Ask about the screen', click: () => captureScreen() },
    { label: 'Type what I say', click: () => win?.webContents.send('hotkey:type') },
    { type: 'separator' },
    { label: "What's new", click: () => { showWin(); win?.webContents.send('changelog:show', { all: true }) } },
    { label: 'Start with Windows', type: 'checkbox', checked: !!settings.startAtLogin, click: (item) => { settings.startAtLogin = item.checked; writeJson(SETTINGS_FILE, settings); applyLogin() } },
    { type: 'separator' },
    { label: 'Quit Murmur', click: () => { quitting = true; app.quit() } },
  ]))
}
// starts hidden in the tray when Windows starts it (only the installed app registers itself, not `npm start`)
function applyLogin() {
  if (!app.isPackaged) return
  try { app.setLoginItemSettings({ openAtLogin: !!settings.startAtLogin, args: ['--hidden'] }) } catch (e) { log('login item failed', e.message) }
  trayMenu()
}

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const reg = (acc, fn) => { if (!acc) return; try { if (!globalShortcut.register(acc, fn)) log('hotkey taken', acc) } catch (e) { log('bad hotkey', acc, e.message) } }
  reg(settings.hotkeyShow, () => { if (!win) return; if (win.isVisible() && win.isFocused()) win.hide(); else showWin() })
  reg(settings.hotkeyDictate, () => { if (!win) return; showWin(); win.webContents.send('hotkey:dictate') })
  reg(settings.hotkeyScreen, () => captureScreen())
  // the window stays where it is: the words go to the app in front
  reg(settings.hotkeyType, () => win?.webContents.send('hotkey:type'))
}

function createWindow() {
  const bounds = readJson(path.join(DATA, 'window.json'), { width: 400, height: 640 })
  win = new BrowserWindow({
    ...bounds, minWidth: 320, minHeight: 420, frame: false, backgroundColor: '#15161a', alwaysOnTop: !!settings.alwaysOnTop,
    title: 'Murmur', icon: path.join(__dirname, 'renderer', 'icon.png'), show: !process.argv.includes('--hidden'),
    // the mic keeps working while the window is hidden (typing into other apps, dictation from the tray)
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // the microphone is the only permission the page gets
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'))
  const keep = () => { if (!win.isMinimized() && !win.isMaximized()) writeJson(path.join(DATA, 'window.json'), win.getBounds()) }
  win.on('resized', keep); win.on('moved', keep)
  win.on('close', (e) => {
    if (quitting || !settings.closeToTray || !tray) return
    e.preventDefault(); win.hide()
    if (!settings.trayHintShown && Notification.isSupported()) {
      settings.trayHintShown = true; writeJson(SETTINGS_FILE, settings)
      new Notification({ title: 'Murmur is still here', body: 'It keeps running in the tray so reminders still come. Right-click the tray icon to quit.', icon: path.join(__dirname, 'renderer', 'icon.png') }).show()
    }
  })
  win.on('closed', () => { win = null })
}

// ---------- what's new ----------
// CHANGELOG.md ships with the app. After an update the window opens it once, showing what changed since the version
// the user had; ⓘ › What's new and the tray menu open it any time.
const HAD_SETTINGS_BEFORE = HAD_SETTINGS
let changelogSince = null // the version they came from, when this start is the first after an update
function checkVersionSeen() {
  const now = app.getVersion(), seen = settings.lastSeenVersion
  if (seen === now) return
  // 0.7.x did not record the version; anyone who has settings from before is updating, not installing
  if (HAD_SETTINGS_BEFORE && (!seen || L.newerVersion(now, seen))) changelogSince = seen || '0.7.1'
  settings.lastSeenVersion = now; writeJson(SETTINGS_FILE, settings)
}
ipcMain.handle('changelog:get', () => {
  let entries = []
  try { entries = L.parseChangelog(fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8')) } catch {}
  return { version: app.getVersion(), since: changelogSince, entries }
})
ipcMain.handle('changelog:seen', () => { changelogSince = null })

// ---------- updates ----------
// electron-updater reads latest.yml from the address in package.json (updateUrl, e.g. a GitHub Releases
// …/releases/latest/download/ link). A new version downloads quietly; the window offers to restart, and otherwise it is
// installed when Murmur quits. Settings › Updates can turn it off. Without an address nothing is checked.
let updater = null
function setupUpdater() {
  const url = (() => { try { return require('./package.json').updateUrl || '' } catch { return '' } })()
  if (!app.isPackaged || !settings.autoUpdate || !/^https:\/\//.test(url)) return log('updates off', app.isPackaged ? (url ? '' : '(no updateUrl)') : '(not installed)')
  try { updater = require('electron-updater').autoUpdater } catch (e) { return log('updater missing', e.message) }
  updater.setFeedURL({ provider: 'generic', url })
  updater.autoDownload = true; updater.autoInstallOnAppQuit = true
  updater.logger = { info: (m) => log('update:', m), warn: (m) => log('update warn:', m), error: (m) => log('update error:', m), debug: () => {} }
  updater.on('update-downloaded', (i) => { log('update ready', i.version); win?.webContents.send('update:ready', { version: i.version }) })
  const check = () => updater.checkForUpdates().catch((e) => log('update check failed', e.message))
  setTimeout(check, 60000); setInterval(check, 6 * 3600e3)
}
ipcMain.handle('update:install', () => { if (!updater) return false; quitting = true; updater.quitAndInstall(true, true); return true })

// one Murmur at a time: a second start just brings the open window forward
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => showWin())

// a server Murmur did not start itself (it was already running) can go away later: start our own then
setInterval(async () => {
  for (const [name, url, start] of [['llm', `http://127.0.0.1:${settings.llmPort}/health`, startLlm], ['ears', `http://127.0.0.1:${settings.whisperPort}/`, startEars]]) {
    if (name === 'llm' && settings.llmMode === 'external') continue
    if (servers[name]?.state === 'ready' && !servers[name].proc && !(await ping(url, 3000))) { log(`${name} went away, starting it`); start() }
  }
}, 15000)

app.setAppUserModelId('local.murmur.app') // Windows shows reminders under Murmur's name
app.whenReady().then(() => {
  fs.mkdirSync(DATA, { recursive: true })
  checkVersionSeen()
  setTimeout(checkReminders, 5000) // ones that came due while Murmur was closed
  loadConvs()
  dailyBackup()
  conv = latestConv() || newConv()
  setTimeout(sweepAttachments, 30000)
  createWindow()
  createTray()
  applyLogin()
  registerHotkeys()
  startLlm(); startEars(); startEmbedder()
  if (settings.vad === 'silero') vadLoad()
  setupUpdater()
})
app.on('before-quit', () => { quitting = true })
app.on('window-all-closed', () => app.quit())
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopProcess('llm'); stopProcess('ears'); try { embedder?.kill() } catch {}; ws?.close(); try { typer?.kill() } catch {} })
