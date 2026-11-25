// npm test: the pure helpers in lib.js and the vector store
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const L = require('../lib')
const { VecStore } = require('../vecstore')

test('splitArgs keeps quoted paths together', () => {
  assert.deepEqual(L.splitArgs('-m "C:\\My Models\\a.gguf" -ngl 99'), ['-m', 'C:\\My Models\\a.gguf', '-ngl', '99'])
  assert.deepEqual(L.splitArgs('  '), [])
  assert.deepEqual(L.splitArgs('a ""'), ['a', ''])
})
test('dropSpecArgs removes the draft flags and their values', () => {
  assert.deepEqual(L.dropSpecArgs(['-np', '2', '--spec-type', 'draft-mtp', '--spec-draft-n-max', '2', '-fa', 'on']), ['-np', '2', '-fa', 'on'])
})
test('argValue', () => { assert.equal(L.argValue(['-np', '2'], '-np', '--parallel'), '2'); assert.equal(L.argValue(['-x'], '-np'), undefined) })

test('parseWhen reads the model\'s reminder times', () => {
  assert.equal(L.parseWhen('2026-11-26 09:00'), new Date(2026, 10, 26, 9, 0).getTime())
  assert.equal(L.parseWhen('2026-11-26 9pm'), new Date(2026, 10, 26, 21, 0).getTime())
  assert.equal(L.parseWhen('2026-11-26T12:30 AM'), new Date(2026, 10, 26, 0, 30).getTime())
  assert.equal(L.parseWhen('2026-11-26'), new Date(2026, 10, 26, 9, 0).getTime()) // no time: 9:00
  assert.ok(Number.isNaN(L.parseWhen('tomorrow')))
  assert.ok(Number.isNaN(L.parseWhen(undefined)))
})

test('extractNoteBlocks finds blocks and cleans the reply', () => {
  const r = L.extractNoteBlocks('Got it.\n<note title="Cabin code">The gate code is 4417.</note>')
  assert.equal(r.text, 'Got it.')
  assert.deepEqual(r.blocks, [{ type: 'note', title: 'Cabin code', remind: undefined, body: 'The gate code is 4417.' }])
  const m = L.extractNoteBlocks('Done <note title="Call Mark" remind="2026-11-26 09:00">Call Mark.</note-add>')
  assert.equal(m.blocks[0].remind, '2026-11-26 09:00'); assert.equal(m.text, 'Done')
  const a = L.extractNoteBlocks('Added. <note-add ref="n2">Also eggs.')
  assert.deepEqual(a.blocks, [{ type: 'add', ref: 'n2', body: 'Also eggs.' }]); assert.equal(a.text, 'Added.')
  assert.equal(L.extractNoteBlocks('<search>x</search>Hello').text, 'Hello')
  assert.equal(L.extractNoteBlocks('a </note> b').text, 'a  b')
})

test('fitWindow keeps its start until the history overflows, then jumps', () => {
  const sizes = Array(10).fill(100)
  assert.equal(L.fitWindow(sizes, 0, 2000), 0) // fits: stays
  assert.equal(L.fitWindow(sizes, 3, 2000), 3) // keeps the start it had
  const s = L.fitWindow(sizes, 0, 900) // 1000 > 900: trim to 60% (540) -> 5 messages
  assert.equal(s, 5)
  assert.equal(L.fitWindow([...sizes, 100], s, 900), s) // next turn: still fits, same start
  assert.equal(L.fitWindow(Array(50).fill(1), 0, 1e9), 26) // too many messages: down to 24
  assert.equal(L.fitWindow([5000], 0, 100), 1) // one huge message: nothing fits
})

test('shareFileChars: short files keep theirs, long ones share the rest', () => {
  assert.deepEqual(L.shareFileChars([100, 50000, 50000], 10100), [100, 5000, 5000])
  assert.deepEqual(L.shareFileChars([10, 20], 1000), [10, 20])
  assert.deepEqual(L.shareFileChars([], 1000), [])
})

test('intent fallback words', () => {
  assert.equal(L.intentByWords('remind me at 5 to call mom').intent, 'remind')
  assert.equal(L.intentByWords('save that').intent, 'save')
  assert.equal(L.intentByWords('show my tapsilog note').intent, 'show_note')
  assert.equal(L.intentByWords('how are you').intent, 'chat')
  assert.equal(L.intentByWords('what did we talk about yesterday').past, true)
})
test('the previous reply goes to the intent check only for short pointing messages', () => {
  assert.match(L.intentUserText('save that', 'Tokyo is the capital.'), /previous reply/)
  assert.doesNotMatch(L.intentUserText('And of France? One word.', 'Tokyo.'), /previous reply/)
})

test('whisperHints picks names, not sentence starts', () => {
  const h = L.whisperHints(['The user has a cat named Mochi.', 'Works at Accenture in Makati.', 'Tita Baby lives in Cebu'])
  for (const w of ['Mochi', 'Accenture', 'Makati', 'Cebu']) assert.ok(h.includes(w), w)
  assert.ok(!/\bThe\b/.test(h))
  assert.ok(L.whisperHints(Array(100).fill('Met Alexander Hamilton today')).length <= 180)
})

test('versions and the changelog', () => {
  assert.ok(L.newerVersion('0.8.0', '0.7.2')); assert.ok(L.newerVersion('0.10.0', '0.9.9')); assert.ok(!L.newerVersion('0.7.2', '0.7.2'))
  const c = L.parseChangelog('# Changelog\n\n## 0.8.0 — 2026-11-25\n- a\n- b\n\n## 0.7.2 - 2026-11-25\n- c\n')
  assert.deepEqual(c.map((e) => e.version), ['0.8.0', '0.7.2']); assert.equal(c[0].body, '- a\n- b'); assert.equal(c[1].date, '2026-11-25')
  const real = L.parseChangelog(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'))
  assert.equal(real[0].version, require('../package.json').version, 'CHANGELOG.md starts with this version')
})

test('VecStore: append, delete, reload, survive a cut-off write, import json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'murmur-vec-'))
  const v = (x) => Array.from({ length: 8 }, (_, i) => Math.sin(i + x))
  const file = path.join(dir, 'v.bin')
  let s = new VecStore(file)
  s.setMany([['a', v(1)], ['b', v(2)]]); s.deleteMany(['a']); s.setMany([['b', v(3)]])
  s = new VecStore(file)
  assert.deepEqual(s.keys(), ['b']); assert.ok(Math.abs(s.get('b')[2] - Math.sin(5)) < 1e-6)
  fs.appendFileSync(file, Buffer.from([7, 0, 1]))
  s = new VecStore(file); assert.deepEqual(s.keys(), ['b'])
  fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ x: v(4) }))
  const t = new VecStore(path.join(dir, 't.bin')); assert.equal(t.importJson(path.join(dir, 'old.json')), 1)
  assert.ok(fs.existsSync(path.join(dir, 'old.json.old')))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('settleIntent checks the model against the words', () => {
  assert.equal(L.settleIntent("What was the keeper's name in the story?", { intent: 'show_note', past: true }).intent, 'chat')
  assert.equal(L.settleIntent("What was the keeper's name in the story?", { intent: 'show_note', past: true }).past, false)
  assert.equal(L.settleIntent('pull up the adobo recipe I saved', { intent: 'show_note' }).intent, 'show_note')
  assert.equal(L.settleIntent('And of France? One word.', { intent: 'chat', past: true }).past, false)
  assert.equal(L.settleIntent('do you remember my name?', { intent: 'chat', past: true }).past, true)
  assert.equal(L.settleIntent('what did we talk about yesterday', { intent: 'chat', past: false }).past, true)
  assert.equal(L.settleIntent('hello there friend', { intent: 'nonsense' }).intent, 'chat')
})
