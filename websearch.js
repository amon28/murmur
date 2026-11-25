// Web search through the Microsoft Edge that every Windows PC already has (headless, driven by playwright-core, nothing to download).
// Bing, Brave and Google are asked at once and merged, then the best pages are read.
const { chromium } = require('playwright-core')
const dns = require('node:dns/promises')
const net = require('node:net')

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'
const ENGINES = {
  bing: {
    url: 'https://www.bing.com/search?q={q}&setlang=en', weight: 1.1, wait: 'li.b_algo',
    items: 'li.b_algo', title: 'h2', link: 'h2 a[href^="http"], a[href^="http"]', snippet: '.b_caption p, .b_algoSlug, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4',
  },
  brave: {
    url: 'https://search.brave.com/search?q={q}', weight: 1.0, wait: 'div[data-type="web"]',
    items: 'div[data-type="web"]', title: '.search-snippet-title, div.title', link: 'a.l1, a[href^="http"]', snippet: '.generic-snippet .content, div.content',
  },
  google: {
    url: 'https://www.google.com/search?q={q}&hl=en', weight: 1.3, wait: 'div#search div.g, div[data-hveid]',
    items: 'div.g, div[data-hveid]', title: 'h3', link: 'a[href^="http"]', snippet: 'div.VwiC3b, span.aCOpRe, div[data-sncf]',
  },
}
const BLOCKED = ['just a moment', 'attention required', 'captcha', 'unusual traffic', 'are you a robot', 'verify you are human']

let browser = null, context = null, starting = null, idleTimer = null

async function ensure() {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(close, 5 * 60 * 1000) // Edge is closed again after 5 quiet minutes
  if (context) return context
  if (starting) return starting
  starting = (async () => {
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--disable-blink-features=AutomationControlled'], timeout: 20000 })
    } catch (e) {
      throw new Error('Microsoft Edge could not be started for web search (' + String(e.message).split('\n')[0] + ')')
    }
    context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US', viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' } })
    // every page the browser goes to is checked, redirects and frames included, not only the first address:
    // a public page that redirects to the router or a local server is stopped there. Pictures, fonts and video are skipped.
    await context.route('**/*', async (route) => {
      const req = route.request(), type = req.resourceType()
      if (['image', 'font', 'media'].includes(type)) return route.abort()
      if (req.isNavigationRequest() || type === 'document') { const why = await unsafe(req.url()); if (why) return route.abort('blockedbyclient') }
      return route.continue()
    })
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }) })
    return context
  })().finally(() => { starting = null })
  return starting
}

async function close() {
  clearTimeout(idleTimer)
  const b = browser
  browser = context = null
  try { await b?.close() } catch {}
}

function unwrap(url) {
  try {
    const u = new URL(url)
    if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
      const v = u.searchParams.get('u') // "a1" + base64url of the target
      if (v?.startsWith('a1')) return Buffer.from(v.slice(2), 'base64url').toString('utf8')
    }
    if (u.hostname.endsWith('google.com') && u.pathname === '/url') return u.searchParams.get('q') || url
  } catch {}
  return url
}

async function searchEngine(name, query, max) {
  const cfg = ENGINES[name]
  const ctx = await ensure()
  const page = await ctx.newPage()
  try {
    await page.goto(cfg.url.replace('{q}', encodeURIComponent(query)), { waitUntil: 'domcontentloaded', timeout: 15000 })
    const title = (await page.title()).toLowerCase()
    if (BLOCKED.some((m) => title.includes(m))) return []
    await page.waitForSelector(cfg.wait, { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(400) // the first result can appear before the rest
    const rows = await page.evaluate(({ cfg, max }) => {
      const out = []
      for (const item of document.querySelectorAll(cfg.items)) {
        const h = item.querySelector(cfg.title), a = item.querySelector(cfg.link), s = item.querySelector(cfg.snippet)
        const title = h ? h.innerText.trim() : '', url = a ? a.href : ''
        if (title && url.startsWith('http')) out.push({ title, url, snippet: s ? s.innerText.trim() : '' })
        if (out.length >= max) break
      }
      return out
    }, { cfg, max })
    return rows.map((r) => ({ ...r, url: unwrap(r.url), engine: name }))
  } catch { return [] } finally { await page.close().catch(() => {}) }
}

// Asks every engine at once and merges: a page found by several engines, or high up, ranks first.
async function search(query, { max = 6 } = {}) {
  // an engine that shows a consent or bot page would otherwise hold everything up until its own timeouts run out
  const capped = (n) => Promise.race([searchEngine(n, query, 8), new Promise((r) => setTimeout(() => r([]), 7000))])
  const lists = await Promise.all(Object.keys(ENGINES).map(capped))
  const merged = new Map()
  lists.forEach((list) => list.forEach((r, i) => {
    let key; try { const u = new URL(r.url); key = (u.hostname.replace(/^www\./, '') + u.pathname).replace(/\/$/, '').toLowerCase() } catch { return }
    if (/(^|\.)(google|bing|brave)\.com$/.test(new URL(r.url).hostname)) return // the engines' own links
    const score = ENGINES[r.engine].weight / (i + 1)
    const m = merged.get(key)
    if (m) { m.score += score; if (!m.snippet && r.snippet) m.snippet = r.snippet } else merged.set(key, { ...r, score })
  }))
  if (!merged.size) throw new Error('no results (the search engines may have asked for a captcha)')
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, max)
}

// Pages on this PC or the local network are never opened (a model could otherwise point the browser at a router or a local
// server). A name that cannot be looked up is not opened either. Answers are kept a few minutes per host name.
const PRIVATE = (a) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a) || a === '::1' || a === '::' || /^f[cd]|^fe80/i.test(a) || /^::ffff:(127|10|192\.168|169\.254|0)\./i.test(a)
const hostCheck = new Map()
async function unsafe(url) {
  let u; try { u = new URL(url) } catch { return 'bad address' }
  if (!/^https?:$/.test(u.protocol)) return 'not a web page'
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (/^localhost$|\.localhost$|\.local$|\.internal$|\.lan$/i.test(host)) return 'local address'
  if (net.isIP(host)) return PRIVATE(host) ? 'local address' : null
  const hit = hostCheck.get(host)
  if (hit && Date.now() - hit.at < 5 * 60e3) return hit.why
  let why = null
  try { if ((await dns.lookup(host, { all: true })).some(({ address }) => PRIVATE(address))) why = 'local address' } catch { why = 'address not found' }
  hostCheck.set(host, { why, at: Date.now() })
  return why
}

async function read(url, { maxChars = 4000, timeoutMs = 15000 } = {}) {
  const why = await unsafe(url)
  if (why) return { url, error: why }
  const ctx = await ensure()
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForTimeout(900)
    const title = await page.title()
    if (BLOCKED.some((m) => title.toLowerCase().includes(m))) return { url, title, error: 'blocked by a security check' }
    // main text without menus, headers and footers when the page marks them
    const text = await page.evaluate(() => {
      const root = document.querySelector('article, main, [role=main]') || document.body
      const clone = root.cloneNode(true)
      clone.querySelectorAll('nav, header, footer, aside, script, style, noscript, form, [role=navigation], [aria-hidden=true]').forEach((n) => n.remove())
      return (clone.innerText || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim()
    })
    return { url: page.url(), title, text: text.slice(0, maxChars) }
  } catch (e) { return { url, error: String(e.message).split('\n')[0] } } finally { await page.close().catch(() => {}) }
}

// search, then read the top pages in parallel: what the chat model gets to look at
async function research(query, { pages = 3 } = {}) {
  const results = await search(query)
  const opened = await Promise.all(results.slice(0, pages).map((r) => read(r.url, { maxChars: 3500, timeoutMs: 10000 })))
  return results.map((r, i) => ({ ...r, text: opened[i]?.text || '' }))
}

module.exports = { search, read, research, close, unsafe }
