// npm run eval:intent — scores the intent check (lib.js INTENT) on labelled messages, with the same request Murmur makes.
// Starts its own llama-server from Murmur's settings (port 8099; --cpu keeps it off the graphics card), or uses
// --url http://127.0.0.1:PORT/v1 [--key KEY].
// Run it after any change to the intent prompt. Prints every miss and the score per intent.
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process')
const L = require('../lib')

const CASES = [
  // [message, intent, past, previous reply (optional)]
  ['the gate code at the cabin is 4417, I need it next week', 'save', false],
  ['remember that my passport expires in March 2027', 'save', false],
  ['hold onto this: wifi is Pinoy-5G, password tuna-sandwich-42', 'save', false],
  ['save that', 'save', false, 'Sinigang: tamarind broth, pork ribs, kangkong, radish.'],
  ['keep this recipe for me', 'save', false, 'Adobo: chicken, soy sauce, vinegar, garlic, bay leaf, pepper.'],
  ['I need eggs, garlic, rice and fish sauce for Saturday', 'save', false],
  ["don't let me forget Mark's birthday is June 3", 'save', false],
  ['note down: dentist is Dr. Santos at 0917 555 0123', 'save', false],
  ['jot this down, the parking spot is B2-17', 'save', false],
  ['add milk to my shopping list', 'save', false],
  ['my locker combination is 12 34 08, write it down', 'save', false],
  ['the plan for the trip: fly Friday, ferry Saturday, back Monday', 'save', false],
  ['remind me tomorrow at 9 to call the plumber', 'remind', false],
  ['ping me at 4pm to stretch', 'remind', false],
  ['call Tita at 6 tonight, dont let me forget', 'remind', false],
  ['wake me up at 7am for the dentist', 'remind', false],
  ['remind me to water the plants', 'remind', false],
  ['in 20 minutes remind me to take the rice off', 'remind', false],
  ['set a reminder for Friday 3pm: submit the report', 'remind', false],
  ['remind me on the 30th to pay rent', 'remind', false],
  ['what was in my tapsilog note?', 'show_note', false],
  ['get my gate code note', 'show_note', false],
  ['show me the shopping list', 'show_note', false],
  ['open my note about the trip', 'show_note', false],
  ['what did I save about the wifi?', 'show_note', false],
  ['read me my notes on the dentist', 'show_note', false],
  ['pull up the adobo recipe I saved', 'show_note', false],
  ['what is the capital of Japan?', 'chat', false],
  ['And of France? One word.', 'chat', false, 'Tokyo.'],
  ['why?', 'chat', false, 'Because the boiling point drops at altitude.'],
  ['tell me more', 'chat', false, 'Mitochondria make most of the cell\'s energy.'],
  ['how do I make tapsilog?', 'chat', false],
  ['ugh my phone battery drains so fast', 'chat', false],
  ['I had a long day at work', 'chat', false],
  ['my laptop is overheating again', 'chat', false],
  ['what time is it in Tokyo?', 'chat', false],
  ['write me a short poem about rain', 'chat', false],
  ['translate "good morning" to Japanese', 'chat', false],
  ['is it going to rain tomorrow in Manila?', 'chat', false],
  ['thanks, that helps', 'chat', false],
  ['explain how vaccines work, simply', 'chat', false],
  ['can you summarize that in one line', 'chat', false, 'A long explanation about tides and the moon.'],
  ['I went to the gym today', 'chat', false],
  ['my sister Ana is visiting next week', 'chat', false],
  ['what should I cook tonight?', 'chat', false],
  ['what did we talk about yesterday?', 'chat', true],
  ['did I tell you about my new job?', 'chat', true],
  ['you said something about a good ramen place last time', 'chat', true],
  ['remember when we talked about my laptop fan?', 'chat', true],
  ['what was that movie you recommended the other day?', 'chat', true],
  ['last week we discussed my diet, any update?', 'chat', true],
  ['what did I ask you this morning?', 'chat', true],
  ['and the other one?', 'chat', false, 'The first option is the Pixel 9.'],
  ['ok and in Celsius', 'chat', false, 'It is 86°F.'],
  ['how many cups in a liter', 'chat', false],
  ['the meeting moved to 3', 'chat', false],
  ['who won the game last night?', 'chat', false],
  ['what is 15% of 2400', 'chat', false],
  ['save the world, said the hero. who said that?', 'chat', false],
  ['do you remember my name?', 'chat', true],
]

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let url = arg('--url'), key = arg('--key') || '', proc = null
  if (!url) {
    const data = process.env.MURMUR_DATA || path.join(process.env.APPDATA || '', 'Murmur')
    const s = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8'))
    key = 'eval-' + Math.random().toString(36).slice(2)
    // --cpu: leave the graphics card alone (slower)
    const gpu = process.argv.includes('--cpu') ? ['-ngl', '0', '-t', '6'] : ['-ngl', '99', '-fa', 'on']
    const args = ['-m', s.llmModel, '--host', '127.0.0.1', '--port', '8099', '-c', '4096', ...gpu, '--jinja', '-np', '1', '--reasoning', 'off', '--api-key', key]
    proc = spawn(s.llamaServer, args, { cwd: path.dirname(s.llamaServer), windowsHide: true, stdio: 'ignore' })
    url = 'http://127.0.0.1:8099/v1'
    for (let i = 0; i < 120; i++) { try { if ((await fetch(url.replace('/v1', '/health'))).ok) break } catch {} await sleep(1000) }
  }
  const ask = async (text, last) => {
    const r = await fetch(url + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: 'murmur', temperature: 0, max_tokens: 40, cache_prompt: true, chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: L.INTENT_SCHEMA } },
        messages: [{ role: 'system', content: L.INTENT }, { role: 'user', content: L.intentUserText(text, last) }] }),
    })
    const j = await r.json(); const out = j.choices?.[0]?.message?.content || ''
    return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1))
  }
  let ok = 0, okPast = 0, ms = 0, changed = 0
  const per = {}
  try {
    for (const [text, want, wantPast, last] of CASES) {
      const t = Date.now()
      let got; try { got = await ask(text, last) } catch (e) { got = { intent: 'ERROR ' + e.message, past: null } }
      ms += Date.now() - t
      const fin = got.intent?.startsWith('ERROR') ? { intent: got.intent, past: false } : L.settleIntent(text, got)
      const past = fin.past
      const hit = fin.intent === want, hitPast = past === wantPast
      if (fin.intent !== got.intent || !!got.past !== past) changed++
      per[want] = per[want] || [0, 0]; per[want][1]++; if (hit) per[want][0]++
      ok += hit; okPast += hitPast
      if (!hit || !hitPast) console.log(`MISS  "${text}"  want ${want}${wantPast ? '+past' : ''}  got ${fin.intent}${past ? '+past' : ''} (model said ${got.intent}${got.past ? '+past' : ''})`)
    }
  } finally { proc?.kill() }
  console.log(`\nintent ${ok}/${CASES.length}  past ${okPast}/${CASES.length}  avg ${Math.round(ms / CASES.length)} ms  (word checks changed ${changed} model answers)`)
  for (const [k, [a, b]] of Object.entries(per)) console.log(`  ${k.padEnd(10)} ${a}/${b}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
