// Murmur's pure helpers: no Electron, no files, so they can be tested with `npm test` (node:test).

// splits a command line the way cmd does for simple cases: spaces separate, double quotes group
function splitArgs(s) {
  const out = []; let cur = '', q = false, any = false
  for (const ch of String(s || '')) {
    if (ch === '"') { q = !q; any = true } else if (/\s/.test(ch) && !q) { if (any) out.push(cur); cur = ''; any = false } else { cur += ch; any = true }
  }
  if (any) out.push(cur)
  return out
}
// the MTP / draft flags need the draft model: without it they are dropped (with their values)
function dropSpecArgs(a) {
  const out = []
  for (let i = 0; i < a.length; i++) { if (/^--spec-/.test(a[i])) { i++; continue } out.push(a[i]) }
  return out
}
function argValue(a, ...names) { const i = a.findIndex((x) => names.includes(x)); return i >= 0 ? a[i + 1] : undefined }

function firstWords(t) { const w = String(t || '').trim().split(/\s+/).slice(0, 7).join(' '); return w ? w + (String(t).trim().split(/\s+/).length > 7 ? '…' : '') : 'Untitled note' }

const STOP = new Set('the and for with that this what when where which from have about into your mine note notes show open read find give tell more some please there their them they would could should just like make made also want'.split(' '))
function keyWords(q) { return [...new Set(String(q).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3 && !STOP.has(w)))] }

// the model's reminder time, "2026-10-28 09:00" or looser ("2026-10-28 9am", "2026-10-28T9:30 PM"); no time means 9:00
function parseWhen(s) {
  const m = String(s || '').match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T,]+(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?/i)
  if (!m) return NaN
  let h = m[4] ? +m[4] : 9
  if (m[6]) h = (h % 12) + (/^p/i.test(m[6]) ? 12 : 0)
  return new Date(+m[1], m[2] - 1, +m[3], h, +(m[5] || 0)).getTime()
}

// Note blocks the model writes into a reply. Returns the reply without them and the blocks in order.
// A closing tag the model mixed up (</note-add> after <note …>) or left out still ends the block.
function extractNoteBlocks(reply) {
  const blocks = []
  let text = String(reply || '').replace(/<search>[\s\S]*?<\/search>/gi, '')
  text = text.replace(/<note-add\s+ref="([^"]*)"\s*>([\s\S]*?)(?:<\/note[^>]*>|$)|<note\s+([^>]*)>([\s\S]*?)(?:<\/note[^>]*>|$)/gi, (_, ref, addBody, attrs, body) => {
    if (ref != null) blocks.push({ type: 'add', ref, body: addBody.trim() })
    else blocks.push({ type: 'note', title: (attrs.match(/title="([^"]*)"/)?.[1] || '').trim(), remind: attrs.match(/remind="([^"]*)"/)?.[1], body: body.trim() })
    return ''
  })
  return { text: text.replace(/<\/?note[^>]*>/gi, '').trim(), blocks }
}

// About how many characters a model token is for Gemma on mixed English text (rounded down, to be safe)
const CHARS_PER_TOKEN = 3.2
// History window: which messages from `start` on still fit in `budget` characters. When they no longer fit, the start
// jumps forward so the window is only `keep` full: the start then stays put for many turns, so the prompt prefix (and the
// server's cache of it) stays the same, instead of the oldest message falling off on every turn.
function fitWindow(sizes, start, budget, { keep = 0.6, maxMessages = 40, keepMessages = 24 } = {}) {
  start = Math.min(Math.max(0, start || 0), sizes.length)
  const total = (from) => sizes.slice(from).reduce((a, b) => a + b, 0)
  if (total(start) <= budget && sizes.length - start <= maxMessages) return start
  let s = start, t = total(s)
  while (s < sizes.length && (t > budget * keep || sizes.length - s > keepMessages)) { t -= sizes[s]; s++ }
  return s
}

// How many characters of each attached file go to the model: they share `total`; short files keep all of theirs
function shareFileChars(lengths, total) {
  const out = lengths.map(() => 0)
  let left = total, open = lengths.map((_, i) => i)
  while (open.length) {
    const each = Math.floor(left / open.length)
    const small = open.filter((i) => lengths[i] <= each)
    if (!small.length) { open.forEach((i) => { out[i] = each }); break }
    small.forEach((i) => { out[i] = lengths[i]; left -= lengths[i] })
    open = open.filter((i) => !small.includes(i))
  }
  return out
}

// What a message is for (see readIntent in main.js). Kept here so the eval script uses the very same prompt.
const INTENT = `You read a message a user sent to their note-taking assistant and decide what they want. Answer with JSON only, like
{"intent": "chat", "topic": "laptop fan", "past": false}
intent is one of:
- "save": they want something kept for later, said outright or not: remember, note, hold onto, keep, don't let me forget, save that (the previous reply), or details clearly meant to be stored (a list, a code, an address, a plan, a recipe they will need again).
- "remind": they want to be told about something at a certain time or date.
- "show_note": they want to see, read or get back something they saved before.
- "chat": anything else: questions, talk, requests, telling about their day. A fact mentioned in passing is "chat".
topic: 1-4 words on what it is about (for show_note: the note to look for).
past: true only when they ask about an earlier, separate conversation ("what did we talk about…", "did I tell you…", "you said last time…"). A follow-up to what is being talked about right now ("and France?", "why?", "tell me more") is not past.
Examples:
"the gate code at mom's is 4417, I'll need it next week" -> save
"ugh my phone battery drains so fast" -> chat
"hold onto this recipe for me" -> save
"save that" -> save
"I need to buy eggs and garlic for Saturday" -> save
"call Tita at 6 tonight, don't let me forget" -> remind
"wake me up tomorrow 7am for the dentist" -> remind
"what was in my tapsilog note?" -> show_note
"how do I make tapsilog?" -> chat
"and of France?" -> chat, past false
"what did we talk about yesterday?" -> chat, past true`
const INTENT_SCHEMA = {
  type: 'object',
  properties: { intent: { type: 'string', enum: ['save', 'remind', 'show_note', 'chat'] }, topic: { type: 'string', maxLength: 40 }, past: { type: 'boolean' } },
  required: ['intent', 'topic', 'past'],
}
// the previous reply only helps for short messages that point back at it ("save that", "remember this")
const POINTS_BACK = /\b(that|this|it|those|these|above)\b/i
function intentUserText(text, lastReply) {
  const ctx = lastReply && String(text).length < 80 && POINTS_BACK.test(text) ? `(The assistant's previous reply, for context: "${String(lastReply).replace(/\s+/g, ' ').slice(0, 300)}")\n` : ''
  return `${ctx}Message: "${String(text).slice(0, 1500)}"`
}
const ASK_PAST = /\b(yesterday|last (time|night|week|month)|earlier today|the other day|we (talked|discussed|spoke|chatted)|remember (when|what|that time)|did i (tell|say|mention|ask)|you (said|told me|mentioned))\b/i
const ASK_NOTE = /\b(get|show|open|read|find|retrieve|pull up|look up|display|see|check|give me|what('?s| is| was) in|what did i (save|note|write))\b[\s\S]*\bnotes?\b|\bmy notes?\b|\bnotes? (on|about|for)\b/i
const SAVE_NOTE = /\b(save|remember|remind|note (that|this|down|it)|write (it |this |that )?down|take (a )?note|add (it |this |that )?to|make (a )?note|jot|update (the |my )?note|keep (this|that|it))\b/i
// the word lists, for when the model cannot be asked
function intentByWords(text) {
  const save = SAVE_NOTE.test(text), show = ASK_NOTE.test(text)
  return { intent: save ? (/\bremind/i.test(text) ? 'remind' : 'save') : show ? 'show_note' : 'chat', topic: '', past: ASK_PAST.test(text), by: 'words' }
}

// The model's answer, checked against the words: "show_note" only when the message speaks of something saved (else a
// question about the story just told would look for a note), and "past" only when it hints at an earlier time (else a
// follow-up like "and France?" would pull in old conversations). The word lists alone already count.
const NOTE_HINT = /\b(notes?|saved?|list|recipe|wrote|written|jotted|kept|stored)\b/i
const PAST_HINT = /\b(remember|before|earlier|last|ago|told|said|talked|discuss\w*|mention\w*|yesterday|again|previous\w*|other day|back when|we were|this morning|asked you)\b/i
function settleIntent(text, j) {
  const words = intentByWords(text)
  let intent = ['save', 'remind', 'show_note', 'chat'].includes(j?.intent) ? j.intent : words.intent
  if (intent === 'show_note' && !NOTE_HINT.test(text) && words.intent !== 'show_note') intent = 'chat'
  const past = words.past || (!!j?.past && PAST_HINT.test(text))
  return { intent, topic: String(j?.topic || '').slice(0, 60), past }
}

// Proper nouns worth telling Whisper about, so names come out spelled right: capitalised words that are not at the start
// of a sentence, from the profile facts and note titles. Returns a short comma list.
function whisperHints(texts, max = 180) {
  const seen = new Map()
  for (const t of texts) {
    for (const m of String(t).matchAll(/(?<![.!?]\s|^)\b(\p{Lu}[\p{Ll}\p{N}'-]{2,}(?:\s\p{Lu}[\p{Ll}'-]{2,})?)/gu)) {
      const w = m[1]; if (/^(The|This|That|They|There|When|What|Murmur|User|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/.test(w)) continue
      seen.set(w, (seen.get(w) || 0) + 1)
    }
  }
  let out = ''
  for (const [w] of [...seen].sort((a, b) => b[1] - a[1])) { if ((out + ', ' + w).length > max) break; out = out ? out + ', ' + w : w }
  return out
}

// "0.8.0" > "0.7.2"
function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) }
  return false
}
// CHANGELOG.md -> [{ version, date, body }], newest first ("## 0.8.0 — 2026-11-25")
function parseChangelog(md) {
  const out = []
  for (const part of String(md).split(/^## /m).slice(1)) {
    const [head, ...rest] = part.split('\n')
    const m = head.match(/^(\d+\.\d+\.\d+)\s*(?:[—-]\s*(.*))?$/)
    if (m) out.push({ version: m[1], date: (m[2] || '').trim(), body: rest.join('\n').trim() })
  }
  return out
}

// ---------- recall ----------
// Greetings, thanks and okays: nothing in memory is about them, so they never bring up notes or past talks
const SMALL_TALK = new Set(('hi hello hey hiya heya yo sup there thanks thank you ty thx tysm ok okay okey k kk cool nice great awesome ' +
  'perfect got it sure yes yeah yep yup no nope nah bye goodbye see later good morning afternoon evening night so much a lot very ' +
  'murmur again welcome np alright').split(' '))
function smallTalk(q) {
  const w = String(q || '').toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean)
  return w.length > 0 && w.length <= 6 && w.every((x) => SMALL_TALK.has(x) || /^(?:ha)+h?$|^he(?:he)+$|^hm+$|^lo+l$|^x+d$/.test(x))
}
// The score a match must reach. With EmbeddingGemma 2, unrelated text still scores about 0.6 against anything, and short
// messages reach 0.67-0.69, above the fixed minimum; real matches stand far above the rest (+0.18 and more over the
// typical score, measured on real notes and chats). So a match must also beat this message's typical (median) score by
// `margin`, once there are enough items to tell what typical is.
function noiseFloor(scores, min, margin = 0.12, enough = 6) {
  if (!margin || scores.length < enough) return min
  const s = [...scores].sort((a, b) => a - b)
  return Math.max(min, s[s.length >> 1] + margin)
}

// ---------- branches ----------
// A conversation keeps one list, `messages`: the branch on screen. Where branches part, the first message of the shown
// branch carries `fork = { tails, at }`: every branch from that point on as its own list of messages, with the shown
// one's place left null (it is the rest of `messages`) and `at` its number. A branch put away keeps its own forks inside
// it, so branches within branches come back as they were.
const stripFork = (m) => { const { fork, ...rest } = m; return rest }
// Starts a new branch at position i: the messages from i on are put away (as a branch of the fork already there, or of
// a new one) and cut from `list`. Returns the fork for the new branch's first message, which the caller adds.
function forkAt(list, i) {
  const tail = list.splice(i)
  const f = tail[0]?.fork
  const tails = f ? f.tails.slice() : [null]
  tails[f ? f.at : 0] = [stripFork(tail[0]), ...tail.slice(1)]
  tails.push(null)
  return { tails, at: tails.length - 1 }
}
// Shows branch k of the fork whose first message is at position i. False when there is no such branch.
function switchFork(list, i, k) {
  const f = list[i]?.fork
  if (!f || !Number.isInteger(k) || k < 0 || k >= f.tails.length || k === f.at || !f.tails[k]?.length) return false
  const tails = f.tails.slice()
  tails[f.at] = [stripFork(list[i]), ...list.slice(i + 1)]
  const next = tails[k]; tails[k] = null
  list.splice(i, list.length - i, { ...next[0], fork: { tails, at: k } }, ...next.slice(1))
  return true
}
// Every message of the conversation, in all its branches (for its attachments)
function allMessages(list, out = []) {
  for (const m of list) {
    out.push(m)
    for (const t of m.fork?.tails || []) if (t) allMessages(t, out)
  }
  return out
}

module.exports = { smallTalk, noiseFloor, forkAt, switchFork, allMessages, settleIntent, NOTE_HINT, PAST_HINT, splitArgs, dropSpecArgs, argValue, firstWords, keyWords, STOP, parseWhen, extractNoteBlocks, CHARS_PER_TOKEN, fitWindow, shareFileChars, INTENT, INTENT_SCHEMA, intentUserText, intentByWords, ASK_PAST, ASK_NOTE, SAVE_NOTE, whisperHints, newerVersion, parseChangelog }
