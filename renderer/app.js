// Murmur window: chat, voice (talk and dictate), the burger drawer with notes and settings.
const M = window.murmur
const $ = (s) => document.querySelector(s)
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }

let settings = {}
let status = {}

// ---------- light markdown (escaped first, so model text can never inject HTML) ----------
// ---------- formatting ----------
// Replies are Markdown (tables, lists, links, code with colours), with ```mermaid diagrams. Whatever the model writes is
// cleaned by DOMPurify before it is shown: no scripts, no styles or ids that could reach the app, links open in the browser.
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const PURIFY = { FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'option', 'img', 'video', 'audio', 'iframe', 'object', 'embed', 'link', 'meta', 'base'], FORBID_ATTR: ['style', 'id', 'name', 'target', 'srcset'] }
let mdParser = null
if (window.marked && window.DOMPurify) {
  mdParser = new marked.Marked({ gfm: true, breaks: true })
  mdParser.use({
    renderer: {
      code({ text, lang }) {
        const l = String(lang || '').trim().split(/\s+/)[0].toLowerCase()
        const raw = encodeURIComponent(text)
        if (l === 'mermaid') return `<div class="diagram" data-raw="${raw}"><div class="code-bar"><span>diagram</span><button data-act="toggle">Code</button><button data-act="copy">Copy</button></div><pre class="hljs"><code>${escHtml(text)}</code></pre></div>`
        let html = escHtml(text)
        try { if (window.hljs) html = l && hljs.getLanguage(l) ? hljs.highlight(text, { language: l, ignoreIllegals: true }).value : text.length < 20000 ? hljs.highlightAuto(text).value : html } catch {}
        const page = l === 'html' || /^\s*<(!doctype html|html)[\s>]/i.test(text)
        return `<div class="codeblock" data-raw="${raw}"><div class="code-bar"><span>${escHtml(l || 'code')}</span>${page ? '<button data-act="preview" title="Open it in its own window: offline and sandboxed">Preview</button>' : ''}<button data-act="copy">Copy</button></div><pre class="hljs"><code>${html}</code></pre></div>`
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        return /^(https?:|mailto:)/i.test(href || '') ? `<a data-url="${escHtml(href)}"${title ? ` title="${escHtml(title)}"` : ''}>${text}</a>` : text
      },
    },
  })
  // inputs: only the read-only checkboxes of a task list (- [x])
  DOMPurify.addHook('uponSanitizeElement', (n, d) => {
    if (d.tagName === 'input' && (n.getAttribute('type') || '').toLowerCase() !== 'checkbox') n.remove()
  })
  // links in HTML the model wrote: also only to the browser
  DOMPurify.addHook('afterSanitizeAttributes', (n) => {
    if (n.tagName === 'INPUT') { n.setAttribute('disabled', ''); n.removeAttribute('value') }
    if (n.tagName === 'A') { const h = n.getAttribute('href'); n.removeAttribute('href'); if (h && /^(https?:|mailto:)/i.test(h)) n.setAttribute('data-url', h) }
  })
}
function md(text) {
  if (mdParser) { try { return DOMPurify.sanitize(mdParser.parse(String(text ?? '')), PURIFY) } catch {} }
  return mdPlain(text)
}
// the plain formatter, if the libraries are missing
function mdPlain(text) {
  const esc = escHtml(text)
  return esc
    .replace(/```([\s\S]*?)```/g, (_, c) => `<code style="display:block;white-space:pre;overflow-x:auto;background:var(--panel2);padding:6px 8px;border-radius:6px">${c.replace(/^\w*\n/, '')}</code>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/^#{1,4}\s+(.*)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ')
}

// Mermaid (5 MB) loads the first time a diagram is shown
let mermaidP = null, diagramN = 0
function loadMermaid() {
  return (mermaidP ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = 'vendor/mermaid.min.js'
    s.onload = () => { mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict', fontFamily: 'inherit' }); res(mermaid) }
    s.onerror = () => { mermaidP = null; rej(new Error('mermaid missing')) }
    document.head.append(s)
  }))
}
async function drawDiagrams(root) {
  const boxes = [...root.querySelectorAll('.diagram:not([data-done])')]
  if (!boxes.length) return
  let mm; try { mm = await loadMermaid() } catch { return }
  for (const d of boxes) {
    d.dataset.done = '1'
    const id = 'mmd' + ++diagramN
    try {
      const { svg } = await mm.render(id, decodeURIComponent(d.dataset.raw))
      const fig = el('div', 'diagram-svg'); fig.innerHTML = svg
      d.insertBefore(fig, d.querySelector('pre')); d.classList.add('drawn')
    } catch (e) {
      document.getElementById('d' + id)?.remove(); document.getElementById(id)?.remove() // mermaid's own error drawing
      d.querySelector('.code-bar span').textContent = "diagram (couldn't be drawn)"
    }
  }
}
// buttons on code and diagrams, and links: the same in the chat and in What's new
function onRichClick(e) {
  const a = e.target.closest('a')
  if (a) { e.preventDefault(); if (a.dataset.url) M.openUrl(a.dataset.url); return }
  const b = e.target.closest('[data-act]'), box = b?.closest('.codeblock, .diagram')
  if (!box) return
  const raw = decodeURIComponent(box.dataset.raw || '')
  if (b.dataset.act === 'copy') { navigator.clipboard.writeText(raw); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200) }
  else if (b.dataset.act === 'preview') M.previewHtml(raw)
  else if (b.dataset.act === 'toggle') { box.classList.toggle('show-code'); b.textContent = box.classList.contains('show-code') ? 'Diagram' : 'Code' }
}

// ---------- status dots ----------
function paintStatus(s) {
  status = s
  for (const d of document.querySelectorAll('#dots span')) {
    const v = s[d.dataset.k] || {}
    d.className = v.state || 'off'
    d.title = `${{ llm: 'Chat model', ears: 'Whisper', memory: 'Memory' }[d.dataset.k]}: ${v.state || 'off'}${v.detail ? ' — ' + v.detail : ''}`
  }
  for (const k of ['llm', 'ears', 'memory']) { const t = document.querySelector(`[data-st="${k}"]`); if (t) t.textContent = `${s[k]?.state || 'off'}${s[k]?.detail ? ' · ' + s[k].detail : ''}` }
}
M.onStatus(paintStatus)
M.status().then(paintStatus)

// ---------- chat ----------
const chatBox = $('#chat')
chatBox.addEventListener('click', onRichClick)
let streaming = null

function scrollDown() { chatBox.scrollTop = chatBox.scrollHeight }
function showEmpty() {
  if (chatBox.children.length) return
  const e = el('div', 'empty')
  e.append(el('b', '', 'Hi! Talk or type.'), el('span', '', 'The mic sends what you say as a message. The note button keeps listening and turns what you say into a note. Your notes are remembered and brought up when they matter.'))
  chatBox.append(e)
}
function addMsg(role, text, extra = {}) {
  chatBox.querySelector('.empty')?.remove()
  // a message: its bubble, and under it a row with ‹ 2/3 ›, its buttons and the time
  const m = el('div', `msg ${role}`), bub = el('div', 'bubble'); m.append(bub)
  m._raw = text; m._atts = extra.attachments
  if (extra.attachments?.length) bub.append(attsFor(extra.attachments))
  if (extra.thinking) bub.append(thoughtBox(extra.thinking, extra.thoughtMs))
  const body = el('div', 'body'); body.innerHTML = md(text); bub.append(body); drawDiagrams(body)
  if (!text && extra.attachments?.length) body.hidden = true
  if (extra.recalled?.length || extra.saved?.length || extra.sources?.length || extra.chats?.length) bub.append(chipsFor(extra))
  if (extra.rating) m.dataset.rating = extra.rating
  if (extra.at) m.dataset.at = extra.at
  if (extra.fork) setBranch(m, { n: extra.fork.tails.length, k: extra.fork.at })
  if (role === 'assistant' && text) footFor(m).append(actionsFor(m, () => body.innerText, extra.at))
  if (role === 'user') footFor(m).append(userActions(m))
  if (role !== 'system') setTime(m)
  chatBox.append(m); scrollDown()
  return m
}
// the model's thinking, folded away above its answer
function thoughtBox(text, ms) {
  const d = el('details', 'thought'), s = el('summary', '', ms ? `💭 Thought for ${Math.max(1, Math.round(ms / 1000))} s` : '💭 Thinking…')
  d.append(s, el('div', 'thought-text', text || ''))
  return d
}
function attsFor(list) {
  const box = el('div', 'msg-atts')
  for (const a of list) {
    if (a.kind === 'image') {
      const img = el('img'); img.alt = a.name; img.src = a.thumb || ''
      img.onclick = async () => showImage((await M.attach.image(a.id)) || img.src)
      box.append(img)
    } else box.append(el('span', 'file', '📄 ' + a.name))
  }
  return box
}
function showImage(src) { const v = el('div', 'viewer'); const i = el('img'); i.src = src; v.append(i); v.onclick = () => v.remove(); document.body.append(v) }
function chipsFor({ recalled = [], saved = [], sources = [], chats = [], at }) {
  const c = el('div', 'chips')
  for (const p of chats) { const b = el('button', 'chip', '💬 ' + p.title); b.title = 'Remembered from this conversation (click to open it)'; b.onclick = () => openConv(p.conv); c.append(b) }
  for (const r of recalled) { const b = el('button', 'chip', '📎 ' + r.title); b.title = 'Used this note'; b.onclick = () => openNote(r.id); c.append(b) }
  for (const s of saved) c.append(savedChip(s, at))
  for (const s of sources) {
    let host = s.url; try { host = new URL(s.url).hostname.replace(/^www\./, '') } catch {}
    const b = el('button', 'chip src', '🌐 ' + host); b.title = s.title + '\n' + s.url; b.onclick = () => M.openUrl(s.url); c.append(b)
  }
  return c
}
// a saved note, with Undo (a new note goes to the trash; added text comes off the note again)
function savedChip(s, at, onUndo) {
  const g = el('span', 'chip-group')
  const b = el('button', 'chip saved', (s.remind ? `⏰ Reminder ${whenFull(s.remind)}: ` : s.added ? '✓ Added to: ' : '✓ Saved: ') + s.title)
  b.onclick = () => openNote(s.id)
  const u = el('button', 'chip undo', 'Undo')
  u.title = s.added ? 'Take the added text off the note again' : 'Remove this note (it goes to the trash)'
  const done = () => { g.classList.add('undone'); b.disabled = true; u.remove(); g.append(el('span', 'chip undone-label', 'undone')) }
  u.onclick = async () => {
    const ok = await M.notes.undo({ id: s.id, addedText: s.added ? s.addedText : undefined, conv: at ? convId : undefined, at })
    if (ok) { done(); onUndo?.(); if (drawerOpen) renderNotes() } else { u.textContent = s.added ? "Can't: the note changed" : "Can't: already gone"; u.disabled = true }
  }
  g.append(b)
  if (s.undone) done(); else if (!s.added || s.addedText) g.append(u)
  return g
}
// small line icons for the row under a message
const ICONS = {
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  regen: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  speak: '<path d="M4 10v4h4l5 4V6L8 10z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  note: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 13h7M9 17h5"/>',
  up: '<path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.2 2.6L12.6 10H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/>',
  down: '<path d="M7 13V4H4v9zM7 13l4 7c1.5 0 2.5-1 2.2-2.6L12.6 14H19a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 17.8 4H7"/>',
  prev: '<path d="M15 6l-6 6 6 6"/>', next: '<path d="M9 6l6 6-6 6"/>',
}
function iconBtn(name, title, onclick) {
  const b = el('button', 'ib'); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title)
  b.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`
  if (onclick) b.onclick = onclick
  return b
}
const setIcon = (b, name) => { b.querySelector('svg').innerHTML = ICONS[name] }
function copyBtn(getText) {
  const b = iconBtn('copy', 'Copy', () => { navigator.clipboard.writeText(getText()); setIcon(b, 'check'); b.title = 'Copied'; setTimeout(() => { setIcon(b, 'copy'); b.title = 'Copy' }, 1200) })
  return b
}
function actionsFor(m, getText, at) {
  const a = el('div', 'msg-actions')
  a.append(copyBtn(getText), regenButton(m), speakBtn(m))
  const save = iconBtn('note', 'Save as note', async () => {
    const n = await M.notes.create({ text: getText(), source: 'chat' })
    setIcon(save, 'check'); save.title = 'Saved as a note'; save.disabled = true
    m.querySelector('.chips') || beforeFoot(m, el('div', 'chips'))
    m.querySelector('.chips').append(savedChip(n, null, () => { setIcon(save, 'note'); save.title = 'Save as note'; save.disabled = false }))
  })
  a.append(save)
  // 👍/👎 teach Murmur what this user likes (see the You tab)
  if (at) {
    const conv = convId
    const up = iconBtn('up', 'Good reply: more like this'), down = iconBtn('down', 'Not good: less like this')
    up.classList.add('rate'); down.classList.add('rate')
    const rate = (v, b) => async () => {
      const now = b.classList.contains('on') ? 0 : v
      await M.chat.rate(conv, at, now)
      up.classList.toggle('on', now === 1); down.classList.toggle('on', now === -1)
    }
    up.onclick = rate(1, up); down.onclick = rate(-1, down)
    const r = m.dataset.rating; if (r === '1') up.classList.add('on'); if (r === '-1') down.classList.add('on')
    a.append(up, down)
  }
  return a
}

// ---------- reading aloud ----------
// The Windows voices, through the browser's speech: offline. One message at a time; its button turns into Stop.
let speaking = null
function speakable(m) {
  const b = m.querySelector('.bubble > .body')?.cloneNode(true)
  if (!b) return ''
  b.querySelectorAll('.codeblock, .diagram, .code-bar').forEach((x) => x.replaceWith(' (code) '))
  return b.innerText.replace(/\s+\n/g, '\n').trim()
}
function stopSpeaking() {
  if (!speaking) return
  speechSynthesis.cancel()
  setIcon(speaking.btn, 'speak'); speaking.btn.title = 'Read aloud'; speaking.btn.classList.remove('on')
  speaking = null
}
function speakBtn(m) {
  const b = iconBtn('speak', 'Read aloud', () => {
    if (speaking?.btn === b) return stopSpeaking()
    stopSpeaking()
    const text = speakable(m); if (!text || !window.speechSynthesis) return
    const u = new SpeechSynthesisUtterance(text)
    const voice = speechSynthesis.getVoices().find((v) => v.default) // Windows' own default voice
    if (voice) u.voice = voice
    u.onend = u.onerror = () => { if (speaking?.u === u) stopSpeaking() }
    speaking = { btn: b, u }
    setIcon(b, 'stop'); b.title = 'Stop reading'; b.classList.add('on')
    speechSynthesis.speak(u)
  })
  return b
}

// ---------- the time under a message ----------
function timeText(at) {
  const d = new Date(at), now = new Date()
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return t
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return 'Yesterday ' + t
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }) + ', ' + t
}
function setTime(m) {
  const f = footFor(m)
  let t = f.querySelector('.time')
  if (!t) { t = el('span', 'time'); f.append(t) }
  const at = Number(m.dataset.at) || Date.now()
  t.textContent = timeText(at); t.title = new Date(at).toLocaleString()
}

// ---------- branches ----------
// Under a message: ‹ 2/3 › where the conversation branches, its buttons, and the time.
function regenOnly(m) { const a = el('div', 'msg-actions'); a.append(regenButton(m)); return a }
function footFor(m) {
  let f = m.querySelector(':scope > .msg-foot')
  if (!f) { f = el('div', 'msg-foot'); m.append(f) }
  return f
}
// into the bubble, after what is there (chips, "stopped")
function beforeFoot(m, node) { (m.querySelector(':scope > .bubble') || m).append(node) }
const busyNow = () => !!streaming
function setBranch(m, { n, k }) {
  const f = footFor(m)
  f.querySelector('.branch')?.remove()
  if (!(n > 1)) return
  const nav = el('div', 'branch')
  const go = (to) => async () => {
    if (busyNow() || !m.dataset.at) return
    const pos = [...chatBox.querySelectorAll('.msg.user, .msg.assistant')].indexOf(m)
    stopSpeaking()
    showConv(await M.chat.branch(convId, Number(m.dataset.at), to))
    const again = chatBox.querySelectorAll('.msg.user, .msg.assistant')[pos]
    if (again) { chatBox.style.scrollBehavior = 'auto'; again.scrollIntoView({ block: 'nearest' }); chatBox.style.scrollBehavior = '' }
  }
  const prev = iconBtn('prev', 'Previous version', go(k - 1)), next = iconBtn('next', 'Next version', go(k + 1))
  prev.disabled = k <= 0; next.disabled = k >= n - 1
  nav.append(prev, el('span', '', `${k + 1}/${n}`), next)
  f.prepend(nav)
}
// everything from this message on leaves the screen: it stays in the old branch
function dropFrom(m) { stopSpeaking(); while (m.nextSibling) m.nextSibling.remove(); m.remove() }
function regenButton(m) {
  return iconBtn('regen', 'Regenerate: write this reply again (the old one stays, switch with ‹ ›)', () => {
    if (busyNow() || !m.dataset.at) return
    const at = Number(m.dataset.at); dropFrom(m)
    M.chat.send({ regenAt: at }).then((r) => { if (r === null) loadHistory() })
  })
}
function userActions(m) {
  const a = el('div', 'msg-actions')
  a.append(copyBtn(() => m._raw || ''), iconBtn('edit', 'Edit: change this message and send it again (the old version stays, switch with ‹ ›)', () => editMsg(m)))
  return a
}
function editMsg(m) {
  if (busyNow() || !m.dataset.at || m.classList.contains('editing')) return
  const body = m.querySelector('.bubble > .body')
  m.classList.add('editing')
  const box = el('div', 'edit-box'), ta = el('textarea'); ta.value = m._raw || ''; ta.rows = Math.min(10, Math.max(2, ta.value.split('\n').length + 1))
  const row = el('div', 'edit-row'), cancel = el('button', 'ghost small', 'Cancel'), go = el('button', 'primary small', 'Send')
  row.append(cancel, go); box.append(ta, row)
  body.hidden = true; body.parentNode.insertBefore(box, body)
  const close = () => { box.remove(); body.hidden = false; m.classList.remove('editing') }
  const send = () => {
    const text = ta.value.trim()
    if (!text && !m._atts?.length) return
    if (busyNow()) return
    if (text === String(m._raw || '').trim()) return close()
    const at = Number(m.dataset.at), atts = m._atts
    dropFrom(m)
    addMsg('user', text, { attachments: atts })
    M.chat.send({ text, editAt: at }).then((r) => { if (r === null) loadHistory() })
  }
  cancel.onclick = close; go.onclick = send
  ta.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } else if (e.key === 'Escape') close() }
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length)
}

let convId = null
function showConv(c) {
  convId = c.id
  streaming = null; setSendMode(false)
  chatBox.innerHTML = ''
  for (const m of c.messages.slice(-80)) {
    // a turn that was stopped before any words, or failed, is kept in the file but shown as such
    if (m.role === 'assistant' && !m.content && (m.error || m.fork)) {
      const x = addMsg('assistant', '', m)
      if (m.error) { x.classList.add('error'); x.querySelector('.body').textContent = '⚠ ' + m.error } else x.querySelector('.body').textContent = '(stopped)'
      footFor(x).append(regenOnly(x)); continue
    }
    if (m.role === 'assistant' && !m.content) continue
    const x = addMsg(m.role, m.content, m)
    if (m.stopped) beforeFoot(x, el('div', 'muted small-text', 'stopped'))
  }
  $('#convTitle').textContent = c.messages.length ? c.title : ''
  showEmpty()
  showContext(c.context)
  chatBox.scrollTop = chatBox.scrollHeight
}

// How full this conversation's context is (from the last reply), in the title bar; and a line in the chat above
// which the model no longer sees the messages (Murmur drops the oldest ones when it fills up).
// a context size is a power-of-two count (16,384 = "16k"), what was used a plain one (1,529 = "1.5k")
const kCtx = (n) => (n % 1024 === 0 ? n / 1024 + 'k' : kTok(n))
const kTok = (n) => (n >= 100000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n))
function showContext(ctx) {
  const box = $('#ctx')
  chatBox.querySelector('.trim-line')?.remove()
  chatBox.querySelectorAll('.msg.unseen').forEach((m) => m.classList.remove('unseen'))
  if (!ctx || !(ctx.read >= 0)) { box.hidden = true; return }
  const used = ctx.read + (ctx.wrote || 0), size = ctx.size || 0
  const pct = size ? Math.min(100, Math.round((used / size) * 100)) : 0
  // messages from before the window: faded, with the line above the first one still seen
  const msgs = [...chatBox.querySelectorAll('.msg.user[data-at], .msg.assistant[data-at]')]
  const hidden = ctx.from ? msgs.filter((m) => Number(m.dataset.at) < ctx.from) : []
  const first = ctx.from ? msgs.find((m) => Number(m.dataset.at) >= ctx.from) : null
  if (hidden.length) {
    hidden.forEach((m) => m.classList.add('unseen'))
    const line = el('div', 'trim-line', 'Murmur no longer shows the model the messages above this line')
    line.title = 'The conversation outgrew the context, so its oldest messages are left out. Start a new conversation, or save what matters as a note.'
    chatBox.insertBefore(line, first || null)
  }
  box.hidden = false
  box.className = 'ctx' + (pct >= 90 ? ' full' : pct >= 70 ? ' high' : '')
  box.style.setProperty('--p', size ? pct : 0)
  box.title = `Context: ${kTok(used)}${size ? ` / ${kCtx(size)} (${pct}%)` : ''}\n${used.toLocaleString()}${size ? ` of ${size.toLocaleString()}` : ''} tokens\n` +
    `Last reply: the model read ${ctx.read.toLocaleString()} (instructions, this chat, notes, files) and wrote ${(ctx.wrote || 0).toLocaleString()}.\n` +
    (hidden.length ? `${hidden.length} older message${hidden.length > 1 ? 's are' : ' is'} no longer seen (above the line in the chat). Murmur keeps room for the reply and trims in steps, so this happens before 100%.` : 'When it fills up, the oldest messages are left out, never the newest.')
}
async function loadHistory() { showConv(await M.chat.history()) }
async function openConv(id) { showConv(await M.chat.open(id)) }
M.chat.onListChanged(async () => {
  const h = await M.chat.history()
  if (h.id === convId) $('#convTitle').textContent = h.messages.length ? h.title : ''
  if (drawerOpen && !$('#tab-chats').hidden) renderChats()
})

async function sendChat(text) {
  text = String(text || '').trim()
  if (pending.some((p) => p.busy)) { addMsg('system', 'Still reading an attachment, one moment…'); return }
  const attachments = pending.filter((p) => p.ready).map((p) => p.ready)
  if (!text && !attachments.length) return
  if (streaming) await M.chat.stop()
  if (status.llm?.state !== 'ready') addMsg('system', status.llm?.state === 'starting' ? 'The model is still loading — your message will be answered once it is up.' : 'The chat model is not running. Check Settings.')
  addMsg('user', text, { attachments })
  const web = webOn
  pending = []; renderTray(); setWeb(false)
  M.chat.send({ text, attachments, web })
}
M.chat.onStart(({ cut, conv, userAt, userFork, replyFork }) => {
  if (conv !== convId) return
  const mine = [...chatBox.querySelectorAll('.msg.user')].at(-1); if (mine && userAt && !mine.dataset.at) mine.dataset.at = userAt
  if (mine && userFork) setBranch(mine, userFork)
  if (mine && userAt) setTime(mine)
  // files too long to read whole: say how much the model reads
  for (const f of cut || []) addMsg('system', `📄 ${f.name} is long: Murmur reads the first ${f.kept.toLocaleString()} of ${f.total.toLocaleString()} characters.`)
  const m = addMsg('assistant', '')
  if (replyFork) setBranch(m, replyFork)
  const body = m.querySelector('.body'); body.classList.add('typing')
  streaming = { m, body, text: '', recalled: [], chats: [] }
  setSendMode(true)
})
M.chat.onRecall(({ recalled, chats, conv }) => { if (streaming && conv === convId) Object.assign(streaming, { recalled, chats }) })
M.chat.onNotice(({ text }) => addMsg('system', text))
M.chat.onStatus(({ text, conv }) => {
  if (conv !== convId) return
  let line = chatBox.querySelector('.status-line')
  if (!text) { line?.remove(); return }
  if (!line) { line = el('div', 'status-line'); chatBox.insertBefore(line, streaming?.m || null) }
  line.textContent = text; scrollDown()
})
M.chat.onToken(({ t, conv }) => {
  if (!streaming || conv !== convId) return
  streaming.text += t
  streaming.body.innerHTML = md(streaming.text.replace(/<note[\s\S]*$/i, '')) // hide a note block while it is being written
  scrollDown()
})
M.chat.onThink(({ t, conv }) => {
  if (!streaming || conv !== convId) return
  if (!streaming.thought) { streaming.thought = thoughtBox('', 0); streaming.body.parentNode.insertBefore(streaming.thought, streaming.body) }
  const box = streaming.thought.querySelector('.thought-text'); box.textContent += t
  if (streaming.thought.open) box.scrollTop = box.scrollHeight
  scrollDown()
})
M.chat.onDone(({ at, thoughtMs, text, saved, sources, error, conv, context, ...rest }) => {
  if (!streaming || conv !== convId) return
  const { m, body, thought } = streaming
  const recalled = rest.recalled || streaming.recalled, chats = rest.chats || streaming.chats
  if (thought) thought.querySelector('summary').textContent = `💭 Thought for ${Math.max(1, Math.round((thoughtMs || 0) / 1000))} s`
  streaming = null
  chatBox.querySelector('.status-line')?.remove()
  setSendMode(false)
  body.classList.remove('typing')
  if (error) {
    // stopped with nothing written: gone, unless it is a branch (its arrows stay, so the other versions can be reached)
    if (error === 'stopped') { if (!body.textContent && !m.querySelector('.branch')) { m.remove(); return } if (body.textContent) { body.innerHTML = md(text || body.innerText); beforeFoot(m, el('div', 'muted small-text', 'stopped')) } else body.textContent = '(stopped)' }
    else { m.classList.add('error'); body.textContent = '⚠ ' + error }
    if (at) { m.dataset.at = at; setTime(m) }
    footFor(m).append(regenOnly(m))
    return
  }
  body.innerHTML = md(text || '(no answer)'); drawDiagrams(body)
  if (recalled?.length || saved?.length || sources?.length || chats?.length) beforeFoot(m, chipsFor({ recalled, saved, sources, chats, at }))
  m._raw = text
  if (at) { m.dataset.at = at; setTime(m) }
  footFor(m).append(actionsFor(m, () => body.innerText, at))
  if (context) showContext(context)
  scrollDown()
  if (saved?.length && drawerOpen) renderNotes()
})

const input = $('#input')
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px' }
input.addEventListener('input', autosize)
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } })
function submit() {
  if (streaming && !input.value.trim() && !pending.length) return M.chat.stop()
  const t = input.value
  if (t.trimStart().startsWith('/') && runSlash(t)) return
  input.value = ''; autosize(); sendChat(t)
}
$('#send').onclick = submit
function setSendMode(busy) {
  $('#send').title = busy ? 'Stop' : 'Send'
  $('#send').innerHTML = busy ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M5 12l14-7-5 14-2-6z"/></svg>'
}
async function newConv() { await M.chat.create(); await loadHistory(); input.focus() }
$('#newChat').onclick = newConv
$('#convTitle').onclick = () => openDrawer('chats')

// ---------- / commands and snippets ----------
// Typed at the start of the box. A list pops up while the name is typed (↑↓, Enter or Tab, Esc); Enter on a full line
// ("/web weather today") runs it. Snippets are the user's own prompts (Settings › Snippets).
const lastOf = (sel) => [...chatBox.querySelectorAll(sel)].at(-1)
const notice = (t) => addMsg('system', t)
const COMMANDS = [
  { name: 'new', hint: 'Start a new conversation', run: () => newConv() },
  { name: 'web', args: 'question', hint: 'Search the web for this message', run: (a) => { if (!a) return 'keep'; setWeb(true); sendChat(a) } },
  { name: 'note', args: 'text', hint: 'Save it as a note, without a reply', run: async (a) => {
    if (!a) return 'keep'
    const n = await M.notes.create({ text: a, source: 'typed' })
    const m = addMsg('system', ''); m.querySelector('.body').replaceChildren(savedChip(n))
    if (drawerOpen) renderNotes()
  } },
  { name: 'remind', args: 'when, what', hint: 'Set a reminder ("tomorrow 9am call mom")', run: (a) => { if (!a) return 'keep'; sendChat('Remind me ' + a) } },
  { name: 'notes', args: 'search', hint: 'Open your notes, or search them', run: (a) => { openDrawer('notes'); $('#noteSearch').value = a; renderNotes() } },
  { name: 'chats', args: 'search', hint: 'Find a conversation', run: (a) => { openDrawer('chats'); $('#chatSearch').value = a; renderChats() } },
  { name: 'regen', hint: 'Write the last reply again', run: () => { const b = lastOf('.msg.assistant')?.querySelector('.ib[title^="Regenerate"]'); b ? b.click() : notice('No reply to write again yet.') } },
  { name: 'edit', hint: 'Edit your last message', run: () => { const m = lastOf('.msg.user'); m ? editMsg(m) : notice('No message to edit yet.') } },
  { name: 'copy', hint: 'Copy the last reply', run: () => { const m = lastOf('.msg.assistant'); if (m) navigator.clipboard.writeText(m._raw || m.querySelector('.body').innerText) } },
  { name: 'read', hint: 'Read the last reply aloud', run: () => lastOf('.msg.assistant')?.querySelector('.ib[title="Read aloud"]')?.click() },
  { name: 'stop', hint: 'Stop the reply, or the reading', run: () => { stopSpeaking(); if (streaming) M.chat.stop() } },
  { name: 'think', args: 'on | off', hint: 'Think before answering (better on hard questions, slower)', run: async (a) => {
    const on = /^(on|yes|1|true)$/i.test(a) ? true : /^(off|no|0|false)$/i.test(a) ? false : !settings.thinking
    settings = await M.settings.set({ thinking: on }); notice(`Thinking before answering: ${on ? 'on' : 'off'}.`)
  } },
  { name: 'snippets', hint: 'Make and change your snippets', run: () => { subTab = 'snippets'; openDrawer('settings') } },
  { name: 'settings', hint: 'Open Settings', run: () => openDrawer('settings') },
  { name: 'help', hint: 'All commands and snippets', run: () => {
    const sn = settings.snippets || []
    notice('**Commands**\n' + COMMANDS.map((c) => `\`/${c.name}${c.args ? ' ' + c.args : ''}\`: ${c.hint}`).join('\n') +
      (sn.length ? '\n\n**Your snippets**\n' + sn.map((x) => `\`/${x.name}\`: ${x.text.replace(/\s+/g, ' ').slice(0, 70)}`).join('\n') : '') +
      '\n\nMake your own in Settings › Snippets.')
  } },
]
const snippets = () => (settings.snippets || []).filter((x) => x?.name && x.text)
async function expandSnippet(sn, typed) {
  let text = sn.text
  if (/\{\{text\}\}/.test(text) && !typed) typed = (await M.clipboardText().catch(() => '')) || ''
  if (/\{\{clipboard\}\}/.test(text)) text = text.replace(/\{\{clipboard\}\}/g, (await M.clipboardText().catch(() => '')) || '')
  const now = new Date()
  text = text.replace(/\{\{date\}\}/g, now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))
    .replace(/\{\{time\}\}/g, now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
  text = /\{\{text\}\}/.test(text) ? text.replace(/\{\{text\}\}/g, typed) : typed ? `${text}\n\n${typed}` : text
  return text
}
// puts the snippet in the box (caret at {{cursor}}), or sends it
async function useSnippet(sn, typed, send) {
  const full = await expandSnippet(sn, typed)
  const at = full.indexOf('{{cursor}}'), text = full.replace('{{cursor}}', '')
  if (send && at < 0) { input.value = ''; autosize(); sendChat(text); return }
  input.value = text; autosize(); input.focus()
  const pos = at < 0 ? text.length : at; input.setSelectionRange(pos, pos)
}
// a whole line typed and sent: true when it was a command or snippet
function runSlash(line) {
  const m = line.trim().match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/)
  if (!m) return false
  const name = m[1].toLowerCase(), arg = (m[2] || '').trim()
  const cmd = COMMANDS.find((c) => c.name === name), sn = !cmd && snippets().find((x) => x.name.toLowerCase() === name)
  if (!cmd && !sn) return false // not one of ours: sent as it is
  closePalette()
  if (sn) { useSnippet(sn, arg, true); return true }
  input.value = ''; autosize()
  Promise.resolve(cmd.run(arg)).then((r) => { if (r === 'keep') { input.value = `/${cmd.name} `; autosize(); input.focus() } })
  return true
}
// the list above the box
const palette = el('div', 'palette'); palette.hidden = true; palette.setAttribute('role', 'listbox')
$('.composer').append(palette)
let palItems = [], palSel = 0
function closePalette() { palette.hidden = true; palItems = [] }
function updatePalette() {
  const m = input.value.match(/^\/([\w-]*)$/)
  if (!m) return closePalette()
  const q = m[1].toLowerCase()
  const all = [...COMMANDS.map((c) => ({ kind: 'cmd', name: c.name, args: c.args, hint: c.hint, c })),
    ...snippets().map((x) => ({ kind: 'snip', name: x.name, hint: x.text.replace(/\{\{\w+\}\}/g, '…').replace(/\s+/g, ' ').slice(0, 60), x }))]
  palItems = [...all.filter((i) => i.name.startsWith(q)), ...all.filter((i) => !i.name.startsWith(q) && i.name.includes(q))]
  if (!palItems.length) return closePalette()
  palSel = Math.min(palSel, palItems.length - 1)
  palette.replaceChildren(...palItems.map((i, k) => {
    const row = el('div', 'pal-row' + (k === palSel ? ' sel' : '')); row.setAttribute('role', 'option')
    row.append(el('b', '', '/' + i.name), el('span', 'pal-args', i.args || ''), el('span', 'pal-hint', i.hint), el('span', 'pal-kind', i.kind === 'snip' ? 'snippet' : ''))
    row.onmousedown = (e) => { e.preventDefault(); palSel = k; choosePalette() }
    return row
  }))
  palette.hidden = false
  palette.querySelector('.sel')?.scrollIntoView({ block: 'nearest' })
}
function choosePalette() {
  const i = palItems[palSel]; if (!i) return
  closePalette()
  if (i.kind === 'snip') {
    if (/\{\{text\}\}/.test(i.x.text)) { input.value = `/${i.name} `; autosize(); return } // waits for the text
    return useSnippet(i.x, '', i.x.send)
  }
  if (i.args) { input.value = `/${i.name} `; autosize(); return }
  input.value = ''; autosize(); i.c.run('')
}
input.addEventListener('input', () => { palSel = 0; updatePalette() })
input.addEventListener('keydown', (e) => {
  if (palette.hidden) return
  const n = palItems.length
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { palSel = (palSel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n; updatePalette() }
  else if (e.key === 'Enter' || e.key === 'Tab') { if (e.shiftKey) return; choosePalette() }
  else if (e.key === 'Escape') closePalette()
  else return
  e.preventDefault(); e.stopImmediatePropagation()
}, true)
input.addEventListener('blur', () => setTimeout(closePalette, 150))

// ---------- web search button ----------
let webOn = false
function setWeb(on) { webOn = on; $('#web').setAttribute('aria-pressed', String(on)); $('#web').title = on ? 'This message will be searched on the web (click to cancel)' : 'Search the web for this message' }
$('#web').onclick = () => setWeb(!webOn)

// ---------- attachments ----------
// Images are shrunk here (longest side 1280 px, JPEG) before they go anywhere; files go to the main process, which reads their text.
let pending = [] // { key, name, kind, thumb?, busy, ready?, error? }
const MAX_FILE = 25 * 1024 * 1024
function renderTray() {
  const tray = $('#tray'); tray.innerHTML = ''; tray.hidden = !pending.length
  for (const p of pending) {
    const a = el('div', 'att' + (p.busy ? ' busy' : '') + (p.error ? ' bad' : ''))
    if (p.thumb) { const i = el('img'); i.src = p.thumb; a.append(i) } else a.append(el('span', 'ficon', (p.name.split('.').pop() || 'file').slice(0, 4)))
    const nm = el('span', 'nm', p.error ? `${p.name}: ${p.error}` : p.busy ? `${p.name} (reading…)` : p.name); nm.title = nm.textContent
    const x = el('button', 'x', '✕'); x.title = 'Remove'; x.onclick = () => { pending = pending.filter((q) => q !== p); renderTray() }
    a.append(nm, x); tray.append(a)
  }
}
async function shrinkImage(file, max, quality) {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k)
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height)
  return c
}
async function addFiles(files) {
  for (const file of files) {
    const p = { key: Math.random(), name: file.name || 'pasted image.png', kind: file.type.startsWith('image/') ? 'image' : 'file', busy: true }
    pending.push(p); renderTray()
    try {
      if (file.size > MAX_FILE) throw new Error('too big (25 MB max)')
      if (p.kind === 'image') {
        const big = await shrinkImage(file, 1280)
        p.thumb = (await shrinkImage(file, 320)).toDataURL('image/jpeg', 0.75); renderTray()
        const bytes = await (await new Promise((r) => big.toBlob(r, 'image/jpeg', 0.88))).arrayBuffer()
        p.ready = await M.attach.add({ name: p.name, kind: 'image', bytes, thumb: p.thumb })
      } else {
        p.ready = await M.attach.add({ name: p.name, kind: 'file', bytes: await file.arrayBuffer() })
      }
    } catch (e) { p.error = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
    p.busy = false; renderTray()
  }
  input.focus()
}
$('#attach').onclick = () => $('#filePick').click()
$('#filePick').onchange = () => { addFiles([...$('#filePick').files]); $('#filePick').value = '' }
input.addEventListener('paste', (e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files) } })
let dragDepth = 0
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('#drop').hidden = false } })
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true } })
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#drop').hidden = true; if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]) })

// ---------- setup ----------
const fmtGB = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : Math.round(b / 1e6) + ' MB')
let setupItems = []
async function renderSetup(force) {
  setupItems = await M.setup.status()
  const missing = setupItems.filter((i) => !i.have)
  if (!force && !missing.some((i) => i.required)) { $('#setup').hidden = true; return }
  $('#setup').hidden = false
  const list = $('#setupList'); list.innerHTML = ''
  for (const i of setupItems) {
    const row = el('div', 'dl' + (i.have ? ' ok' : '')); row.dataset.key = i.key
    const lab = el('label', 'check')
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = !i.have; cb.disabled = i.have || i.busy
    lab.append(cb, el('span', '', i.label + (i.required ? '' : ' (optional)')))
    const st = el('span', 'st', i.have ? 'ready' : i.busy ? 'downloading…' : i.partial ? `paused at ${fmtGB(i.partial)}` : 'not downloaded')
    const bar = el('div', 'bar'); bar.append(el('i'))
    row.append(lab, st, bar); list.append(row)
  }
  $('#setupPause').hidden = !setupItems.some((i) => i.busy)
  $('#setupGo').hidden = !missing.length
  $('#setupLater').textContent = missing.length ? 'Later' : 'Close'
}
$('#setupGo').onclick = async () => {
  const keys = [...$('#setupList').querySelectorAll('.dl')].filter((r) => r.querySelector('input').checked && !r.querySelector('input').disabled).map((r) => r.dataset.key)
  if (!keys.length) return
  await M.setup.download(keys)
  for (const k of keys) { const r = $(`.dl[data-key="${k}"]`); r.querySelector('input').disabled = true; r.querySelector('.st').textContent = 'starting…' }
  $('#setupPause').hidden = false; $('#setupGo').hidden = true
}
$('#setupPause').onclick = async () => { await M.setup.pause(); setTimeout(() => renderSetup(true), 300) }
$('#setupLater').onclick = () => { $('#setup').hidden = true }
M.setup.onProgress(({ key, got, total, done, error, checking }) => {
  const r = $(`.dl[data-key="${key}"]`); if (!r) return
  const st = r.querySelector('.st')
  if (done) { r.className = 'dl ok'; st.textContent = 'ready'; r.querySelector('.bar i').style.width = '100%'; renderSetup(true); return }
  if (error) { r.classList.add('err'); st.textContent = error; renderSetup(true); return }
  if (checking) { st.textContent = 'checking the file…'; r.querySelector('.bar i').style.width = '100%'; return }
  r.querySelector('.bar i').style.width = (total ? (got / total) * 100 : 0) + '%'
  st.textContent = `${fmtGB(got)} / ${fmtGB(total)}`
})

// ---------- microphone ----------
// One recorder; it cuts speech into segments at pauses. Speech is told from noise by the Silero speech detector (in the
// main process) when it is there, else by a loudness gate with an adaptive noise floor.
class Recorder {
  async start({ onSegment, onLevel, silenceMs, maxMs = 28000 }) {
    this.stream = await openMic()
    const useVad = settings.vad === 'silero' && await M.vad.start().catch(() => false)
    this.ctx = new AudioContext({ sampleRate: 16000 })
    await this.ctx.audioWorklet.addModule('worklet.js')
    const src = this.ctx.createMediaStreamSource(this.stream)
    this.node = new AudioWorkletNode(this.ctx, 'tap')
    src.connect(this.node)
    const FRAME_MS = 32, PRE = 10
    let noise = 0.004, speech = [], pre = [], silentFor = 0, voiced = 0, talking = false, chain = Promise.resolve()
    this.flush = () => {
      if (voiced * FRAME_MS >= 350) onSegment(toWav(speech))
      speech = []; silentFor = 0; voiced = 0; talking = false
    }
    const step = (f, loud) => {
      if (speech.length) {
        speech.push(f)
        if (loud) { silentFor = 0; voiced++ } else silentFor += FRAME_MS
        if (silentFor >= silenceMs || speech.length * FRAME_MS >= maxMs) this.flush()
      } else if (loud) {
        speech = [...pre, f]; pre = []; voiced = 1; silentFor = 0
      } else { pre.push(f); if (pre.length > PRE) pre.shift() }
    }
    this.node.port.onmessage = ({ data: f }) => {
      let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]
      const rms = Math.sqrt(s / f.length)
      if (!useVad) {
        const gate = Math.max(Number(settings.vadLevel) || 0.012, noise * 3)
        const loud = rms > gate
        if (!loud) noise = noise * 0.98 + rms * 0.02
        onLevel?.(Math.min(1, rms / (gate * 3)), loud)
        return step(f, loud)
      }
      // frames go through the detector in order; speech starts above 0.5 and holds until it falls under 0.35
      chain = chain.then(async () => {
        if (!this.node) return
        const p = await M.vad.prob(f).catch(() => -1)
        if (p < 0) return step(f, rms > (Number(settings.vadLevel) || 0.012))
        talking = talking ? p > 0.35 : p > 0.5
        onLevel?.(Math.min(1, rms * 25), talking)
        step(f, talking)
      })
    }
  }
  stop(flush = true) {
    if (flush) this.flush?.()
    this.node?.port && (this.node.port.onmessage = null)
    this.stream?.getTracks().forEach((t) => t.stop())
    this.ctx?.close().catch(() => {})
    this.stream = this.ctx = this.node = null
  }
}
function toWav(frames) {
  const n = frames.reduce((a, f) => a + f.length, 0)
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
  let o = 44
  for (const f of frames) for (let i = 0; i < f.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, f[i])) * 0x7fff, true)
  return buf
}
const meter = $('#meter i')
const showLevel = (x) => { meter.style.width = Math.round(x * 100) + '%' }

function earsReady() {
  if (status.ears?.state === 'ready') return true
  if (status.ears?.state === 'sleeping' || status.ears?.state === 'starting') { M.ears.wake(); return true } // it is ready by the time the first words are in
  addMsg('system', status.ears?.state === 'starting' ? 'Whisper is still loading, try again in a moment.' : status.ears?.state === 'missing' ? 'The speech model is not downloaded yet — click the status dots or Settings › Downloads.' : 'Whisper is not running. Check Settings.')
  return false
}
// Opens the chosen mic. If it is gone (unplugged, or Windows gave it a new ID), falls back to the default mic, forgets
// the old choice and says so once, instead of failing with "OverconstrainedError".
async function openMic() {
  const audio = (id) => ({ audio: { deviceId: id ? { exact: id } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
  try { return await navigator.mediaDevices.getUserMedia(audio(settings.micDevice)) } catch (e) {
    if (!settings.micDevice || !['OverconstrainedError', 'NotFoundError'].includes(e.name)) throw e
    const stream = await navigator.mediaDevices.getUserMedia(audio(''))
    settings = await M.settings.set({ ...settings, micDevice: '' }).catch(() => ({ ...settings, micDevice: '' }))
    addMsg('system', "The microphone picked in Settings isn't connected, so Murmur is using the default one. You can pick another in Settings.")
    return stream
  }
}
// Plain words for the browser's mic errors
function micError(e) {
  const say = {
    NotAllowedError: 'Murmur is not allowed to use the microphone. In Windows, open Settings › Privacy & security › Microphone and turn on "Let desktop apps access your microphone".',
    SecurityError: 'Murmur is not allowed to use the microphone. In Windows, open Settings › Privacy & security › Microphone and turn on "Let desktop apps access your microphone".',
    NotFoundError: 'No microphone found. Plug one in, or check that it is turned on in Windows sound settings.',
    OverconstrainedError: 'That microphone isn\'t available. Pick another one in Settings, or choose "System default".',
    NotReadableError: 'The microphone is busy or not responding. Close other apps that use it (calls, recorders), or unplug it and plug it back in.',
    AbortError: 'The microphone stopped unexpectedly. Try again, or unplug it and plug it back in.',
  }[e?.name]
  addMsg('system', 'Microphone: ' + (say || e?.message || e))
}

// Talk: one utterance, sent as a chat message
let talk = null
$('#talk').onclick = async () => {
  if (talk) { talk.stop(true); return }
  if (dict || !earsReady()) return
  const rec = new Recorder()
  talk = rec
  $('#talk').classList.add('live')
  const end = () => { if (talk !== rec) return; talk = null; rec.stop(false); $('#talk').classList.remove('live'); showLevel(0) }
  try {
    await rec.start({
      silenceMs: Number(settings.silenceMs) || 1000,
      onLevel: showLevel,
      onSegment: async (wav) => {
        end()
        input.placeholder = 'Listening…'
        try { const t = await M.ears.transcribe(wav); if (t) sendChat(t) } catch (e) { addMsg('system', e.message) } finally { input.placeholder = 'Message, or click the mic…' }
      },
    })
    input.placeholder = 'Listening… pause to send'
    const origStop = rec.stop.bind(rec)
    rec.stop = (flush) => { origStop(flush); end(); if (!flush) input.placeholder = 'Message, or click the mic…' }
  } catch (e) { end(); micError(e) }
}

// Dictate: keeps listening, every phrase is transcribed in order and added to the live note
let dict = null
async function startDictation() {
  if (dict || !earsReady()) return
  if (talk) talk.stop(false)
  const rec = new Recorder()
  const d = dict = { rec, parts: [], queue: Promise.resolve(), started: Date.now(), timer: null, cancelled: false }
  M.ears.dictating(true)
  $('#dictation').hidden = false; $('#dictate').classList.add('live'); $('#dictText').innerHTML = ''
  const tick = () => { const s = Math.floor((Date.now() - d.started) / 1000); $('#dictTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
  tick(); d.timer = setInterval(tick, 1000)
  try {
    await rec.start({
      silenceMs: Math.max(700, (Number(settings.silenceMs) || 1000) - 200),
      onLevel: showLevel,
      onSegment: (wav) => {
        const slot = el('span', 'pending', '… ')
        $('#dictText').append(slot); $('#dictText').scrollTop = 1e9
        d.queue = d.queue.then(async () => {
          try { const t = await M.ears.transcribe(wav); if (t) { d.parts.push(t); slot.className = ''; slot.textContent = t + ' ' } else slot.remove() } catch (e) { slot.textContent = '[' + e.message + '] ' }
        })
      },
    })
  } catch (e) { endDictation(true); micError(e) }
}
async function endDictation(cancel) {
  const d = dict; if (!d) return
  dict = null
  M.ears.dictating(false)
  d.rec.stop(!cancel)
  clearInterval(d.timer); showLevel(0)
  $('#dictate').classList.remove('live')
  if (cancel) { $('#dictation').hidden = true; return }
  $('#dictStop').disabled = true; $('#dictStop').textContent = 'Saving…'
  await d.queue
  const transcript = d.parts.join(' ').trim()
  const note = transcript ? await M.notes.fromDictation(transcript) : null
  $('#dictation').hidden = true; $('#dictStop').disabled = false; $('#dictStop').textContent = 'Save note'
  if (note) { const m = addMsg('system', ''); m.querySelector('.body').replaceChildren(savedChip(note)) }
  else addMsg('system', 'Nothing was heard, so no note was saved.')
}
$('#dictate').onclick = () => (dict ? endDictation(false) : startDictation())
$('#dictStop').onclick = () => endDictation(false)
$('#dictCancel').onclick = () => endDictation(true)
M.onDictateHotkey(() => (dict ? endDictation(false) : startDictation()))

// Type what I say: keeps listening, each phrase is typed into the app in front (the window stays hidden)
let typing = null
async function toggleTyping() {
  if (typing) { const r = typing; typing = null; r.stop(true); M.type.state(false); return }
  if (dict || talk) return addMsg('system', 'Stop the mic first, then start typing by voice.')
  if (!earsReady()) return
  const rec = new Recorder(); typing = rec
  M.type.state(true)
  let queue = Promise.resolve()
  try {
    await rec.start({
      silenceMs: Math.max(600, (Number(settings.silenceMs) || 1000) - 300),
      onSegment: (wav) => { queue = queue.then(async () => { try { const t = await M.ears.transcribe(wav); if (t) await M.type.text(t) } catch (e) { addMsg('system', e.message) } }) },
    })
  } catch (e) { typing = null; M.type.state(false); micError(e) }
}
M.onTypeHotkey(toggleTyping)

// a screen capture (hotkey, tray or the 📷 button) arrives ready to send
M.attach.onPushed((a) => { pending.push({ key: Math.random(), name: a.name, kind: 'image', thumb: a.thumb, busy: false, ready: a }); renderTray(); input.placeholder = 'Ask about this part of the screen…'; input.focus() })
$('#shot').onclick = () => M.screen.capture()

// ---------- window buttons ----------
$('#min').onclick = () => M.win.minimize()
$('#close').onclick = () => M.win.close()
$('#pin').onclick = async () => { const on = await M.win.pin(); $('#pin').classList.toggle('on', on) }

// ---------- drawer ----------
let drawerOpen = false, lastTab = 'chats'
function openDrawer(tab = lastTab) {
  drawerOpen = true
  $('#drawer').classList.add('open'); $('#drawer').setAttribute('aria-hidden', 'false'); $('#scrim').hidden = false
  showTab(tab)
}
function closeDrawer() { flushNote(); drawerOpen = false; $('#drawer').classList.remove('open'); $('#drawer').setAttribute('aria-hidden', 'true'); $('#scrim').hidden = true }
$('#burger').onclick = () => (drawerOpen ? closeDrawer() : openDrawer())
$('#drawerClose').onclick = closeDrawer
$('#scrim').onclick = closeDrawer
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen) closeDrawer() })
for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => showTab(b.dataset.tab)
function showTab(tab) {
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === tab || (tab === 'note' && b.dataset.tab === 'notes'))
  for (const t of ['chats', 'notes', 'note', 'you', 'about', 'settings']) $('#tab-' + t).hidden = t !== tab
  $('#aboutBtn').classList.toggle('on', tab === 'about')
  lastTab = tab === 'note' ? 'notes' : tab
  if (tab !== 'note') flushNote()
  if (tab === 'chats') renderChats()
  if (tab === 'notes') renderNotes()
  if (tab === 'settings') renderSettings()
  if (tab === 'you') renderYou()
}

// ---------- conversations ----------
async function renderChats() {
  const q = $('#chatSearch').value.trim()
  const list = await M.chat.list(q)
  const box = $('#chatList'); box.innerHTML = ''
  if (!list.length) box.append(el('div', 'empty', q ? 'No conversations match.' : 'No conversations yet.'))
  for (const c of list) {
    const b = el('div', 'note' + (c.id === convId ? ' current' : '')); b.tabIndex = 0; b.setAttribute('role', 'button')
    const t = el('div', 't')
    const acts = el('span', 'acts')
    const ren = el('span', '', 'Rename'); ren.title = 'Rename'
    const del = el('span', '', 'Delete'); del.title = 'Delete'
    acts.append(ren, del)
    t.append(el('span', '', c.title), el('small', '', when(c.updated)), acts)
    b.append(t, el('div', 'p', c.preview))
    b.onclick = () => { openConv(c.id); closeDrawer() }
    b.onkeydown = (e) => { if (e.key === 'Enter') b.onclick() }
    ren.onclick = async (e) => {
      e.stopPropagation()
      const name = el('input'); name.value = c.title
      t.firstChild.replaceWith(name); name.focus(); name.select()
      name.onclick = (ev) => ev.stopPropagation()
      const done = async (keep) => { if (keep) await M.chat.rename(c.id, name.value); renderChats(); if (c.id === convId) loadHistory() }
      name.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false) }
      name.onblur = () => done(true)
    }
    del.onclick = async (e) => {
      e.stopPropagation()
      if (!confirm(`Delete the conversation "${c.title}"?`)) return
      const now = await M.chat.remove(c.id)
      if (now !== convId || c.id === convId) await loadHistory()
      renderChats()
    }
    box.append(b)
  }
  $('#chatCount').textContent = `${list.length} conversation${list.length === 1 ? '' : 's'}`
}
let chatSearchT = null
$('#chatSearch').addEventListener('input', () => { clearTimeout(chatSearchT); chatSearchT = setTimeout(renderChats, 200) })
$('#chatNew').onclick = () => { closeDrawer(); newConv() }

// ---------- notes ----------
const when = (t) => { const d = new Date(t), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) }
const whenFull = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const tagsOf = (text) => [...new Set([...String(text).matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,30})/gu)].map((m) => m[1].toLowerCase()))]
const tasksOf = (text) => { const all = String(text).match(/^\s*[-*] \[[ xX]\]/gm) || []; return { all: all.length, done: all.filter((t) => /\[[xX]\]/.test(t)).length } }
const upcoming = (n) => !!n.remind && !n.reminded
// list previews without the Markdown marks
const plain = (text) => String(text).replace(/^\s*[-*] \[[ xX]\]\s*/gm, '☐ ').replace(/^#{1,4}\s+|^\s*[-*]\s+/gm, '').replace(/[*`]/g, '').replace(/\s+/g, ' ').trim()
let noteFilter = 'all' // all | pinned | remind | trash | #tag
let undoNote = null // the note just moved to Trash, offered back for a few seconds

async function renderNotes() {
  const q = $('#noteSearch').value.trim()
  const all = await M.notes.list()
  const trash = await M.notes.trash()
  // filters: only the ones that have something in them
  const tags = new Map()
  for (const n of all) for (const t of tagsOf(n.text)) tags.set(t, (tags.get(t) || 0) + 1)
  const filters = [['all', 'All'], all.some((n) => n.pinned) && ['pinned', '📌 Pinned'], all.some(upcoming) && ['remind', '⏰ Reminders'],
    ...[...tags].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => ['#' + t, '#' + t]), trash.length && ['trash', `🗑 Trash (${trash.length})`]].filter(Boolean)
  if (!filters.some(([k]) => k === noteFilter)) noteFilter = 'all'
  const bar = $('#noteFilters'); bar.innerHTML = ''
  if (filters.length > 1) for (const [k, label] of filters) { const b = el('button', 'chip' + (k === noteFilter ? ' on' : ''), label); b.onclick = () => { noteFilter = k; renderNotes() }; bar.append(b) }

  const list = $('#noteList'); list.innerHTML = ''
  if (undoNote) {
    const u = el('div', 'undo', `Moved "${undoNote.title}" to Trash.`); const b = el('button', '', 'Undo')
    b.onclick = async () => { const n = await M.notes.restore(undoNote.id); undoNote = null; renderNotes(); if (n) openNote(n.id) }
    u.append(b); list.append(u)
  }
  if (noteFilter === 'trash') {
    for (const n of trash.filter((n) => !q || (n.title + ' ' + n.text).toLowerCase().includes(q.toLowerCase()))) {
      const b = el('div', 'note trashed')
      const t = el('div', 't'); t.append(el('span', '', n.title), el('small', '', 'deleted ' + when(n.deleted)))
      const acts = el('div', 'row'), restore = el('button', 'ghost small', 'Restore'), gone = el('button', 'ghost small danger', 'Delete forever')
      restore.onclick = async () => { await M.notes.restore(n.id); renderNotes() }
      gone.onclick = async () => { if (confirm(`Delete "${n.title}" for good? This can't be undone.`)) { await M.notes.purge(n.id); renderNotes() } }
      acts.append(restore, gone)
      b.append(t, el('div', 'p', n.text.replace(/\s+/g, ' ').slice(0, 160)), acts)
      list.append(b)
    }
    if (trash.length) {
      const empty = el('button', 'ghost small danger', 'Empty Trash')
      empty.onclick = async () => { if (confirm(`Delete all ${trash.length} notes in Trash for good?`)) { await M.notes.purge(); renderNotes() } }
      list.append(empty)
    }
    $('#noteCount').textContent = `${trash.length} in Trash · kept 30 days`
    return
  }

  let shown = all.slice().sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated)
  if (noteFilter === 'pinned') shown = shown.filter((n) => n.pinned)
  else if (noteFilter === 'remind') shown = shown.filter(upcoming).sort((a, b) => a.remind - b.remind)
  else if (noteFilter.startsWith('#')) shown = shown.filter((n) => tagsOf(n.text).includes(noteFilter.slice(1)))
  if (q) {
    // words first, then by meaning; the filter still applies
    const hits = await M.notes.search(q)
    const inFilter = new Map(shown.map((n) => [n.id, n]))
    const words = shown.filter((n) => (n.title + ' ' + n.text).toLowerCase().includes(q.toLowerCase()))
    shown = [...new Set([...words.map((n) => n.id), ...hits.map((h) => h.id)])].map((id) => inFilter.get(id)).filter(Boolean)
  }
  if (!shown.length) list.append(el('div', 'empty', q || noteFilter !== 'all' ? 'No notes match.' : 'No notes yet. Dictate one with the note button, write one with New, or ask the assistant to remember something.'))
  for (const n of shown) {
    const b = el('button', 'note')
    const t = el('div', 't'); t.append(el('span', '', (n.pinned ? '📌 ' : '') + (n.source === 'voice' ? '🎙 ' : '') + n.title), el('small', '', when(n.updated)))
    b.append(t)
    const meta = el('div', 'meta2'), tasks = tasksOf(n.text)
    if (upcoming(n)) meta.append(el('span', 'due', '⏰ ' + whenFull(n.remind)))
    if (tasks.all) meta.append(el('span', '', `☑ ${tasks.done}/${tasks.all}`))
    for (const tg of tagsOf(n.text).slice(0, 4)) meta.append(el('span', 'tag', '#' + tg))
    if (meta.children.length) b.append(meta)
    b.append(el('div', 'p', plain(n.text).slice(0, 200)))
    b.onclick = () => openNote(n.id)
    list.append(b)
  }
  $('#noteCount').textContent = `${all.length} note${all.length === 1 ? '' : 's'}`
}
let searchT = null
$('#noteSearch').addEventListener('input', () => { clearTimeout(searchT); searchT = setTimeout(renderNotes, 250) })
M.notes.onChanged(async () => {
  if (!drawerOpen) return
  if (!$('#tab-notes').hidden) renderNotes()
  // the model titled it, a reminder fired, a summary was added: show it unless the user is typing in it
  if (!$('#tab-note').hidden && currentNote?.id && !dirty && document.activeElement !== $('#noteText') && document.activeElement !== $('#noteTitle')) {
    const n = await M.notes.get(currentNote.id); if (n) { currentNote = n; fillNote() }
  }
})
M.notes.onOpen((id) => openNote(id))
M.notes.onDue(({ id, title }) => addMsg('system', `⏰ Reminder: **${title}**`, { recalled: [{ id, title }] }))

// one note: read view (checklists can be ticked) or editing; every change saves itself
let currentNote = null, editing = false, dirty = false, saveT = null
function inline(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a data-url="${u}">${u}</a>`)
    .replace(/(^|\s)#([\p{L}\p{N}_-]{2,30})/gu, '$1<span class="tag">#$2</span>')
}
function noteView(text) {
  if (!text.trim()) return '<div class="empty">Empty note. Double-click or press Edit to write.</div>'
  return text.split('\n').map((line, i) => {
    let m
    if ((m = line.match(/^\s*[-*] \[([ xX])\]\s?(.*)$/))) { const done = m[1] !== ' '; return `<label class="task${done ? ' done' : ''}"><input type="checkbox" data-line="${i}"${done ? ' checked' : ''}><span>${inline(m[2])}</span></label>` }
    if ((m = line.match(/^#{1,4}\s+(.*)$/))) return `<div class="h">${inline(m[1])}</div>`
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) return `<div class="li">• ${inline(m[1])}</div>`
    if (!line.trim()) return '<div class="gap"></div>'
    return `<div>${inline(line)}</div>`
  }).join('')
}
function fillNote() {
  const n = currentNote
  $('#noteTitle').value = n.title; $('#noteText').value = n.text
  const where = n.source === 'voice' ? 'Dictated' : n.source === 'chat' ? 'From chat' : n.source === 'file' ? 'Imported' : 'Written'
  $('#noteMeta').textContent = n.id ? `${where} · created ${new Date(n.created).toLocaleString()}${n.updated !== n.created ? ' · edited ' + new Date(n.updated).toLocaleString() : ''}${upcoming(n) ? ' · ⏰ ' + whenFull(n.remind) : ''}` : 'New note'
  for (const id of ['#noteDelete', '#noteAsk', '#notePin', '#noteRemind', '#noteAi']) $(id).hidden = !n.id
  $('#notePin').classList.toggle('on', !!n.pinned); $('#notePin').title = n.pinned ? 'Unpin' : 'Pin to the top of the list'
  $('#noteRemind').classList.toggle('on', !!upcoming(n))
  $('#noteView').innerHTML = noteView(n.text)
  // a dictated note keeps the words as they were heard, folded under it
  $('#noteHeard').hidden = !n.transcript || editing; $('#noteHeard').open = false
  $('#noteHeard').querySelector('.heard-text').textContent = n.transcript || ''
}
function setEditing(on) {
  editing = on
  $('#noteText').hidden = !on; $('#noteView').hidden = on
  $('#noteEdit').textContent = on ? 'Done' : 'Edit'
  $('#noteHeard').hidden = on || !currentNote?.transcript
  if (on) $('#noteText').focus(); else $('#noteView').innerHTML = noteView($('#noteText').value)
}
async function openNote(id) {
  await flushNote()
  const n = id ? await M.notes.get(id) : { id: null, title: '', text: '' }
  if (id && !n) return
  currentNote = n
  if (!drawerOpen) openDrawer('note'); else showTab('note')
  $('#noteAiRow').hidden = true; $('#noteRemindRow').hidden = true
  fillNote(); setEditing(!n.id || !n.text.trim())
  if (!n.id) $('#noteTitle').focus()
}
async function flushNote() {
  clearTimeout(saveT)
  if (!dirty || !currentNote) return
  dirty = false
  const title = $('#noteTitle').value, text = $('#noteText').value
  if (!currentNote.id && !title.trim() && !text.trim()) return
  currentNote = currentNote.id ? await M.notes.update({ id: currentNote.id, title, text }) : await M.notes.create({ title, text, source: 'typed' })
  for (const id of ['#noteDelete', '#noteAsk', '#notePin', '#noteRemind', '#noteAi']) $(id).hidden = false
  $('#noteMeta').textContent = 'Saved · ' + new Date(currentNote.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
const changed = () => { dirty = true; clearTimeout(saveT); saveT = setTimeout(flushNote, 700) }
$('#noteTitle').addEventListener('input', changed)
$('#noteText').addEventListener('input', changed)
$('#noteEdit').onclick = async () => { if (editing) await flushNote(); setEditing(!editing) }
$('#noteView').addEventListener('dblclick', (e) => { if (!e.target.closest('input, a')) setEditing(true) })
$('#noteView').addEventListener('click', (e) => { const a = e.target.closest('a[data-url]'); if (a) M.openUrl(a.dataset.url) })
$('#noteView').addEventListener('change', async (e) => {
  const box = e.target.closest('input[data-line]'); if (!box) return
  const lines = $('#noteText').value.split('\n'), i = +box.dataset.line
  lines[i] = lines[i].replace(/\[([ xX])\]/, box.checked ? '[x]' : '[ ]')
  $('#noteText').value = lines.join('\n'); dirty = true; await flushNote()
  $('#noteView').innerHTML = noteView($('#noteText').value)
})
$('#noteNew').onclick = () => openNote(null)
$('#noteBack').onclick = async () => { await flushNote(); showTab('notes') }
$('#notePin').onclick = async () => { await flushNote(); currentNote = await M.notes.update({ id: currentNote.id, pinned: !currentNote.pinned }); fillNote() }
$('#noteRemind').onclick = () => {
  const row = $('#noteRemindRow'); row.hidden = !row.hidden; $('#noteAiRow').hidden = true
  // default: the reminder already set, or tomorrow at 9
  const d = upcoming(currentNote) ? new Date(currentNote.remind) : new Date(Date.now() + 864e5)
  if (!upcoming(currentNote)) d.setHours(9, 0, 0, 0)
  $('#noteRemindAt').value = new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16)
  $('#noteRemindClear').hidden = !upcoming(currentNote)
}
$('#noteRemindSet').onclick = async () => {
  const t = new Date($('#noteRemindAt').value).getTime()
  if (!(t > Date.now())) return ($('#noteRemindAt').style.borderColor = 'var(--danger)')
  $('#noteRemindAt').style.borderColor = ''
  currentNote = await M.notes.update({ id: currentNote.id, remind: t }); $('#noteRemindRow').hidden = true; fillNote()
}
$('#noteRemindClear').onclick = async () => { currentNote = await M.notes.update({ id: currentNote.id, remind: null }); $('#noteRemindRow').hidden = true; fillNote() }
$('#noteAi').onclick = () => { $('#noteAiRow').hidden = !$('#noteAiRow').hidden; $('#noteRemindRow').hidden = true; $('#noteAiState').textContent = '' }
for (const b of document.querySelectorAll('[data-ai]')) b.onclick = async () => {
  await flushNote()
  const state = $('#noteAiState'); state.textContent = 'Working…'
  for (const x of document.querySelectorAll('[data-ai]')) x.disabled = true
  try {
    const r = await M.notes.ai(currentNote.id, b.dataset.ai)
    if (r?.note) { currentNote = r.note; fillNote(); setEditing(false) }
    state.textContent = r?.added ? (b.dataset.ai === 'summary' ? 'Summary added at the top.' : 'To-do list added at the end.') : r?.message || 'Nothing to add.'
  } catch (err) { state.textContent = 'Failed: ' + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }
  for (const x of document.querySelectorAll('[data-ai]')) x.disabled = false
}
$('#noteDelete').onclick = async () => {
  if (!currentNote?.id) return
  await flushNote()
  undoNote = currentNote; await M.notes.remove(currentNote.id); currentNote = null; showTab('notes')
  setTimeout(() => { if (undoNote) { undoNote = null; if (!$('#tab-notes').hidden) renderNotes() } }, 8000)
}
$('#noteAsk').onclick = async () => {
  if (!currentNote) return
  await flushNote(); closeDrawer()
  input.value = `About my note "${currentNote.title}": `; autosize(); input.focus()
}
$('#noteExport').onclick = async () => { const n = await M.notes.exportAll(); if (n) addMsg('system', `Exported ${n} notes as Markdown.`) }
$('#noteImport').onclick = async () => { const n = await M.notes.importFiles(); if (n) { noteFilter = 'all'; renderNotes() } }

// ---------- you: what Murmur has learned ----------
let youProfile = null
async function renderYou(p) {
  youProfile = p || await M.profile.get()
  $('#youLearn').checked = youProfile.learn !== false
  if (document.activeElement !== $('#youPersona')) $('#youPersona').value = youProfile.persona || ''
  $('#youWhen').textContent = youProfile.updated ? 'Last learned ' + new Date(youProfile.updated).toLocaleString() : ''
  const box = $('#youFacts'); box.innerHTML = ''
  if (!youProfile.facts.length) box.append(el('div', 'empty', 'Nothing yet. Just talk; it picks things up as you go.'))
  for (const f of youProfile.facts.slice().reverse()) {
    const row = el('div', 'fact'), x = el('button', 'ghost small', '✕')
    row.append(el('span', '', f.text), x); x.title = 'Forget this'
    x.onclick = async () => renderYou(await M.profile.set({ facts: youProfile.facts.filter((g) => g.id !== f.id) }))
    box.append(row)
  }
  $('#youCount').textContent = youProfile.facts.length ? `(${youProfile.facts.length})` : ''
}
M.profile.onChanged(() => { if (drawerOpen && !$('#tab-you').hidden) renderYou() })
$('#youLearn').onchange = async () => renderYou(await M.profile.set({ learn: $('#youLearn').checked }))
$('#youPersona').addEventListener('change', async () => { await M.profile.set({ persona: $('#youPersona').value }); $('#youState').textContent = 'Saved' })
const addFact = async () => {
  const t = $('#youAdd').value.trim(); if (!t) return
  $('#youAdd').value = ''
  renderYou(await M.profile.set({ facts: [...youProfile.facts, { text: t }] }))
}
$('#youAddBtn').onclick = addFact
$('#youAdd').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFact() })
$('#youReflect').onclick = async () => {
  const b = $('#youReflect'), st = $('#youState'); b.disabled = true; st.textContent = 'Thinking back…'
  try { const r = await M.profile.reflect(); st.textContent = r.ok ? 'Updated' : 'Nothing new to learn yet'; renderYou(r.profile) } catch (err) { st.textContent = 'Failed: ' + err.message }
  b.disabled = false
}
$('#youReset').onclick = async () => {
  if (!confirm('Forget everything Murmur learned about you and its personality with you?')) return
  renderYou(await M.profile.reset('all')); $('#youState').textContent = 'Starting fresh'
}

// ---------- about ----------
$('#aboutBtn').onclick = () => (drawerOpen ? showTab('about') : openDrawer('about'))
$('#tab-about').addEventListener('click', (e) => { const a = e.target.closest('a[data-url]'); if (a) M.openUrl(a.dataset.url) })
$('#aboutRepo').onclick = () => M.openUrl('https://github.com/amon28/murmur/issues')
M.info().then((i) => ($('#aboutVersion').textContent = `Version ${i.version}`))
$('#aboutNews').onclick = () => showChangelog(true)

// ---------- what's new ----------
// After an update it opens once by itself with what changed since the version the user had; ⓘ › What's new and the tray
// menu show the whole list.
async function showChangelog(all) {
  const { version, since, entries } = await M.changelog.get()
  const fresh = since ? entries.filter((e) => e.version !== since && !older(e.version, since)) : []
  const list = all || !fresh.length ? entries : fresh
  if (!list.length) return
  $('#newsTitle').textContent = !all && since ? `Murmur is updated to ${version}` : "What's new in Murmur"
  $('#newsSub').textContent = !all && since ? `What changed since ${since}:` : `You have version ${version}.`
  const box = $('#newsBody'); box.innerHTML = ''
  list.forEach((e, i) => {
    const sec = el('details', 'news-ver'); sec.open = i === 0 || (!all && !!since)
    const sum = el('summary'); sum.append(el('b', '', e.version), el('span', 'muted small-text', e.date ? ' · ' + e.date : ''))
    const body = el('div', 'news-text body'); body.innerHTML = md(e.body)
    sec.append(sum, body); box.append(sec)
  })
  $('#news').hidden = false
  M.changelog.seen()
}
const older = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0); return false }
$('#newsClose').onclick = () => { $('#news').hidden = true; input.focus() }
$('#news').addEventListener('click', (e) => { if (e.target.id === 'news') $('#news').hidden = true })
$('#news').addEventListener('click', onRichClick)
M.changelog.onShow(({ all }) => showChangelog(all))

// ---------- updates ----------
M.update.onReady(({ version }) => {
  const bar = $('#updateBar'); bar.hidden = false
  $('#updateText').textContent = `Murmur ${version} is ready.`
})
$('#updateNow').onclick = () => M.update.install()
$('#updateLater').onclick = () => { $('#updateBar').hidden = true }

// ---------- settings ----------
const FIELDS = [
  ['Chat model', 'llm', 'chat', [
    ['llmMode', 'select', 'Runs on', { options: [['managed', 'llama.cpp started by Murmur'], ['external', 'Another OpenAI-compatible server']] }],
    ['llamaServer', 'file', 'llama-server.exe', { when: 'managed' }],
    ['llmModel', 'file', 'Model (.gguf)', { when: 'managed', list: 'llm' }],
    ['llmDraft', 'file', 'Draft / MTP model (optional, speeds it up)', { when: 'managed' }],
    ['llmVision', 'file', 'Vision file / mmproj (optional, lets it see images)', { when: 'managed' }],
    ['llmCtx', 'number', 'Context size (tokens)', { when: 'managed' }],
    ['llmPort', 'number', 'Port', { when: 'managed' }],
    ['llmArgs', 'textarea', 'Extra llama-server arguments', { when: 'managed' }],
    ['externalUrl', 'text', 'Server URL (…/v1)', { when: 'external' }],
    ['externalModel', 'text', 'Model name', { when: 'external' }],
    ['externalKey', 'password', 'API key (if needed)', { when: 'external' }],
    ['thinking', 'check', 'Think before answering (better on hard questions, slower)', { when: 'managed' }],
    ['temperature', 'number', 'Temperature', { step: 0.05 }],
    ['llmIdleMin', 'number', 'Free its video memory after this many idle minutes (0 = never)', { when: 'managed' }],
    ['webSearch', 'select', 'Web search (through Microsoft Edge)', { options: [['auto', 'When the assistant needs it, or with 🌐'], ['button', 'Only when I press 🌐'], ['off', 'Off']] }],
    ['systemPrompt', 'textarea', 'Personality / instructions'],
  ]],
  ['Whisper (listening)', 'ears', 'listen', [
    ['whisperServer', 'file', 'whisper-server.exe (Vulkan build)'],
    ['whisperModel', 'file', 'Whisper model (.bin)', { list: 'whisper' }],
    ['whisperLang', 'text', 'Language (en, tl, ja… or auto)'],
    ['whisperPort', 'number', 'Port'],
    ['micDevice', 'mic', 'Microphone'],
    ['vad', 'select', 'Telling speech from noise', { options: [['silero', 'Speech detector (Silero, recommended)'], ['level', 'Loudness only']] }],
    ['vadLevel', 'number', 'Loudness gate, when loudness only (lower = more sensitive)', { step: 0.001 }],
    ['whisperHints', 'check', 'Tell Whisper the names in my notes, so it spells them right'],
    ['earsIdleMin', 'number', 'Free its video memory after this many minutes without the mic (0 = never)'],
    ['silenceMs', 'number', 'Pause that ends a sentence (ms)', { step: 50 }],
  ]],
  ['Memory (embeddings)', 'memory', 'memory', [
    ['embedDir', 'folder', 'Models folder'],
    ['embedModel', 'text', 'Model id (folder inside it)'],
    ['embedDtype', 'select', 'Weights', { options: [['q8', 'q8'], ['q4', 'q4'], ['fp16', 'fp16'], ['fp32', 'fp32']] }],
    ['recallCount', 'number', 'Notes brought into a chat (max)'],
    ['recallMin', 'number', 'How close a note must be (0-1)', { step: 0.01 }],
    ['recallChats', 'check', 'Bring up related past conversations too'],
    ['tidyNotes', 'check', 'Organize dictated notes (title, cleaned-up and in order)'],
  ]],
  ['Window', null, 'app', [
    ['alwaysOnTop', 'check', 'Keep on top of other windows'],
    ['hotkeyShow', 'text', 'Show / hide hotkey'],
    ['hotkeyDictate', 'text', 'Dictate hotkey'],
    ['hotkeyScreen', 'text', 'Ask about the screen hotkey'],
    ['hotkeyType', 'text', 'Type what I say (into any app) hotkey'],
    ['closeToTray', 'check', 'Closing keeps Murmur in the tray (reminders still come)'],
    ['startAtLogin', 'check', 'Start with Windows (in the tray)'],
  ]],
  ['Updates', null, 'app', [
    ['autoUpdate', 'check', 'Download new versions by themselves (you choose when to restart)'],
  ]],
]
// The sub-tabs along the top of Settings. All of them stay in one form, so Save keeps every setting.
const SUBTABS = [['chat', 'Chat'], ['listen', 'Listening'], ['memory', 'Memory'], ['snippets', 'Snippets'], ['app', 'App']]
let subTab = 'chat'
let found = { whisper: [], llm: [] }
async function renderSettings() {
  const r = await M.settings.get()
  settings = r.settings; found = r.found
  const mics = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audioinput')
  const form = $('#settingsForm'); form.innerHTML = ''
  const bar = el('div', 'subtabs'); bar.setAttribute('role', 'tablist')
  const show = (id) => {
    subTab = id
    bar.querySelectorAll('button').forEach((b) => { const on = b.dataset.sub === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on) })
    form.querySelectorAll('[data-sub]:not(button)').forEach((n) => { n.hidden = n.dataset.sub !== id })
    form.scrollTop = 0
  }
  for (const [id, label] of SUBTABS) {
    const b = el('button', '', label); b.type = 'button'; b.dataset.sub = id; b.setAttribute('role', 'tab'); b.onclick = () => show(id); bar.append(b)
  }
  form.append(bar)
  for (const [title, key, sub, fields] of FIELDS) {
    const fs = el('fieldset'); fs.dataset.sub = sub; const lg = el('legend', '', title)
    if (key) {
      const st = el('span', 'st'); st.dataset.st = key; lg.append(st)
      const rs = el('button', 'ghost small', 'Restart'); rs.type = 'button'; rs.onclick = () => M.settings.restart(key); lg.append(rs)
    }
    fs.append(lg)
    for (const [name, type, label, opt = {}] of fields) {
      const lab = el('label', type === 'check' ? 'check' : ''); lab.dataset.when = opt.when || ''
      let inp
      if (type === 'select' || type === 'mic') {
        inp = el('select')
        const opts = type === 'mic' ? [['', 'System default'], ...mics.map((m) => [m.deviceId, m.label || 'Microphone'])] : opt.options
        for (const [v, t] of opts) { const o = el('option', '', t); o.value = v; inp.append(o) }
        inp.value = settings[name] ?? ''
        if (type === 'mic' && inp.selectedIndex < 0) inp.value = '' // saved mic not connected: show the default, not a blank box
      } else if (type === 'textarea') { inp = el('textarea'); inp.rows = 3; inp.value = settings[name] ?? '' }
      else if (type === 'check') { inp = el('input'); inp.type = 'checkbox'; inp.checked = !!settings[name] }
      else {
        inp = el('input'); inp.type = type === 'number' ? 'number' : type === 'password' ? 'password' : 'text'
        if (opt.step) inp.step = opt.step
        inp.value = settings[name] ?? ''
        if (opt.list && found[opt.list]?.length) {
          const dl = el('datalist'); dl.id = 'dl-' + name
          for (const p of found[opt.list]) { const o = el('option'); o.value = p; dl.append(o) }
          lab.append(dl); inp.setAttribute('list', dl.id)
        }
      }
      inp.name = name; inp.dataset.type = type
      if (type === 'check') lab.append(inp, el('span', '', label))
      else if (type === 'file' || type === 'folder') {
        const row = el('div', 'pick'); const b = el('button', 'ghost small', 'Browse'); b.type = 'button'
        b.onclick = async () => { const p = await M.settings.pick({ folder: type === 'folder' }); if (p) inp.value = p }
        row.append(inp, b); lab.append(el('span', '', label), row)
      } else lab.append(el('span', '', label), inp)
      fs.append(lab)
    }
    form.append(fs)
  }
  form.append(snippetEditor())
  const hint = el('div', 'hint', 'Changing a model or path restarts only that part. Tip: if another app on this PC already serves the same model (LM Studio, Ollama, another llama-server), pick "Another OpenAI-compatible server" and give its address, to share it instead of loading a second copy.'); hint.dataset.sub = 'chat'; form.append(hint)
  const mode = form.querySelector('[name=llmMode]')
  const sync = () => form.querySelectorAll('label[data-when]').forEach((l) => { l.hidden = !!l.dataset.when && l.dataset.when !== mode.value })
  mode.onchange = sync; sync()
  show(subTab)
  paintStatus(status)
}
$('#settingsSave').onclick = async () => {
  const next = {}
  for (const inp of $('#settingsForm').querySelectorAll('[name]')) {
    const t = inp.dataset.type
    next[inp.name] = t === 'check' ? inp.checked : t === 'number' ? Number(inp.value) : inp.value
  }
  const sn = readSnippets()
  if (sn.error) { $('#settingsSave').textContent = sn.error; setTimeout(() => ($('#settingsSave').textContent = 'Save'), 2500); return }
  next.snippets = sn.list
  settings = await M.settings.set(next)
  $('#settingsSave').textContent = 'Saved'; setTimeout(() => ($('#settingsSave').textContent = 'Save'), 1000)
}
$('#openData').onclick = () => M.settings.openData()
// Settings › Snippets: one row per snippet. Its fields have no name, so the form's own loop leaves them to readSnippets.
function snippetEditor() {
  const fs = el('fieldset', 'snippets'); fs.dataset.sub = 'snippets'
  fs.append(el('legend', '', 'Snippets'))
  fs.append(el('div', 'hint', 'Type / and the name in the chat. {{text}} is what you type after the name (or the clipboard, if nothing), {{clipboard}}, {{date}} and {{time}} are filled in, {{cursor}} is where typing goes on.'))
  const list = el('div', 'snip-list')
  const row = (x = { name: '', text: '', send: true }) => {
    const r = el('div', 'snip-row')
    const name = el('input'); name.placeholder = 'name'; name.value = x.name; name.dataset.snip = 'name'
    const text = el('textarea'); text.rows = 3; text.placeholder = 'The prompt, e.g. Summarize this:\n\n{{text}}'; text.value = x.text; text.dataset.snip = 'text'
    const send = el('label', 'check'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = x.send !== false; cb.dataset.snip = 'send'
    send.append(cb, el('span', '', 'Send right away'))
    const del = el('button', 'ghost small', 'Delete'); del.type = 'button'; del.onclick = () => r.remove()
    const top = el('div', 'snip-top'); top.append(el('span', 'slash', '/'), name, send, del)
    r.append(top, text); list.append(r)
    return r
  }
  for (const x of settings.snippets || []) row(x)
  const add = el('button', 'ghost small', '+ Add snippet'); add.type = 'button'; add.onclick = () => row().querySelector('input').focus()
  fs.append(list, add)
  return fs
}
function readSnippets() {
  const list = [], seen = new Set()
  for (const r of $('#settingsForm').querySelectorAll('.snip-row')) {
    const name = r.querySelector('[data-snip=name]').value.trim().replace(/^\//, '').toLowerCase(), text = r.querySelector('[data-snip=text]').value
    if (!name && !text.trim()) continue
    if (!/^[\w-]+$/.test(name)) return { error: 'A snippet needs a name (letters, numbers, -)' }
    if (COMMANDS.some((c) => c.name === name)) return { error: `/${name} is a command already` }
    if (seen.has(name)) return { error: `Two snippets are called /${name}` }
    if (!text.trim()) return { error: `/${name} has no text` }
    seen.add(name); list.push({ name, text, send: r.querySelector('[data-snip=send]').checked })
  }
  return { list }
}

// ---------- start ----------
;(async () => {
  settings = (await M.settings.get()).settings
  $('#pin').classList.toggle('on', !!settings.alwaysOnTop)
  input.placeholder = 'Message, or click the mic…'
  await loadHistory()
  await renderSetup(false) // only shows itself when a required model is missing
  input.focus()
  // the first start after an update: what's new
  const cl = await M.changelog.get()
  if (cl.since) showChangelog(false)
})()
$('#dots').onclick = () => { if (Object.values(status).some((s) => s.state === 'missing')) renderSetup(true) }
$('#openSetup').onclick = () => { closeDrawer(); renderSetup(true) }
