// A small vector store on disk: key -> Float32 vector, kept in one binary file that is only ever appended to.
// Record: u16 key length, key (utf8), u16 dims, dims x f32 (little endian). dims 0 = the key was removed.
// When more than half the file is dead records it is rewritten once (temp file + rename, so a crash never loses it).
const fs = require('node:fs')

class VecStore {
  constructor(file) {
    this.file = file
    this.map = new Map()
    this.dead = 0
    this.load()
  }
  load() {
    let buf
    try { buf = fs.readFileSync(this.file) } catch { return }
    let o = 0, good = 0
    while (o + 4 <= buf.length) {
      const kl = buf.readUInt16LE(o)
      if (o + 2 + kl + 2 > buf.length) break
      const key = buf.toString('utf8', o + 2, o + 2 + kl)
      const dims = buf.readUInt16LE(o + 2 + kl)
      const start = o + 4 + kl, end = start + dims * 4
      if (end > buf.length) break // a record cut off by a crash: ignore it and what follows
      if (dims) {
        if (this.map.has(key)) this.dead++
        this.map.set(key, new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + end)))
      } else if (this.map.delete(key)) this.dead += 2
      else this.dead++
      o = end; good = o
    }
    if (good < buf.length) { try { fs.truncateSync(this.file, good) } catch {} }
    if (this.dead > this.map.size) this.compact()
  }
  static record(key, vec) {
    const k = Buffer.from(key, 'utf8')
    const dims = vec ? vec.length : 0
    const b = Buffer.alloc(4 + k.length + dims * 4)
    b.writeUInt16LE(k.length, 0); k.copy(b, 2); b.writeUInt16LE(dims, 2 + k.length)
    for (let i = 0; i < dims; i++) b.writeFloatLE(vec[i], 4 + k.length + i * 4)
    return b
  }
  has(key) { return this.map.has(key) }
  get(key) { return this.map.get(key) }
  keys() { return [...this.map.keys()] }
  get size() { return this.map.size }
  // many at once, one write: [[key, vector], ...]
  setMany(entries) {
    if (!entries.length) return
    const parts = []
    for (const [k, v] of entries) { if (this.map.has(k)) this.dead++; const f = Float32Array.from(v); this.map.set(k, f); parts.push(VecStore.record(k, f)) }
    fs.appendFileSync(this.file, Buffer.concat(parts))
  }
  deleteMany(keys) {
    const parts = []
    for (const k of keys) if (this.map.delete(k)) { this.dead += 2; parts.push(VecStore.record(k, null)) }
    if (!parts.length) return
    fs.appendFileSync(this.file, Buffer.concat(parts))
    if (this.dead > this.map.size) this.compact()
  }
  clear() { this.map.clear(); this.dead = 0; this.compact() }
  compact() {
    const tmp = this.file + '.tmp'
    const parts = []
    for (const [k, v] of this.map) parts.push(VecStore.record(k, v))
    fs.writeFileSync(tmp, Buffer.concat(parts))
    fs.renameSync(tmp, this.file)
    this.dead = 0
  }
  // the JSON file of version 0.7.1 and earlier, read once
  importJson(jsonFile) {
    let old
    try { old = JSON.parse(fs.readFileSync(jsonFile, 'utf8')) } catch { return 0 }
    const entries = Object.entries(old || {}).filter(([, v]) => Array.isArray(v) && v.length)
    entries.forEach(([k, v]) => this.map.set(k, Float32Array.from(v)))
    this.compact()
    try { fs.renameSync(jsonFile, jsonFile + '.old') } catch {}
    return entries.length
  }
}
module.exports = { VecStore }
