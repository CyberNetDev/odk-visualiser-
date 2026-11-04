// Two-level cache for heavy OData downloads: memory (LRU, by size) + gzip files on disk (survive restarts).
// Entries are stored as the gzipped JSON body that is sent to the browser, so a cache hit costs
// no JSON.stringify and no compression: the buffer is written to the socket as-is.
//
// One entry = one table of one form with one filter, on one ODK server. Entries are shared between
// users of the same server; server.js checks each user's access to the form before serving one.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

class DataCache {
  constructor({ dir, persist = true, memoryMB = 256, diskMB = 2048 } = {}) {
    this.dir = dir;
    this.persist = persist;
    this.memMax = memoryMB * 1024 * 1024;
    this.diskMax = diskMB * 1024 * 1024;
    this.index = new Map();    // key -> meta
    this.mem = new Map();      // key -> gzip Buffer (Map order = LRU order)
    this.memBytes = 0;
    this.inflight = new Map(); // key -> Promise (one download per key at a time, whoever asks)
    this.auxMem = new Map();   // key -> gzip Buffer of side data (memory-only mode)
    if (persist) this.load();
  }

  // Side data of an entry, never sent to the browser (e.g. ids of the submissions a repeat table covers)
  async setAux(key, obj) {
    const buf = await gzip(JSON.stringify(obj), { level: 6 });
    if (!this.persist) { this.auxMem.set(key, buf); return; }
    try { await writeAtomic(this.file(key, 'aux.gz'), buf); } catch (e) { console.warn('cache: écriture impossible :', e.message); }
  }
  async aux(key) {
    let buf = this.persist ? await fs.promises.readFile(this.file(key, 'aux.gz')).catch(() => null) : this.auxMem.get(key);
    if (!buf) return null;
    try { return JSON.parse((await gunzip(buf)).toString('utf8')); } catch { return null; }
  }

  static key(parts) {
    return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
  }

  file(key, ext) { return path.join(this.dir, `${key}.${ext}`); }

  // Rebuild the index from the *.meta.json files written next to each *.json.gz
  load() {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith('.meta.json')) continue;
        const key = f.slice(0, -'.meta.json'.length);
        try {
          const meta = JSON.parse(fs.readFileSync(this.file(key, 'meta.json'), 'utf8'));
          if (fs.existsSync(this.file(key, 'json.gz'))) this.index.set(key, meta);
          else fs.rmSync(this.file(key, 'meta.json'), { force: true });
        } catch { fs.rmSync(this.file(key, 'meta.json'), { force: true }); }
      }
      for (const f of fs.readdirSync(this.dir)) {
        // orphan data files or interrupted writes
        if (f.endsWith('.tmp') || (f.endsWith('.json.gz') && !this.index.has(f.slice(0, -'.json.gz'.length)))
          || (f.endsWith('.aux.gz') && !this.index.has(f.slice(0, -'.aux.gz'.length)))) fs.rmSync(path.join(this.dir, f), { force: true });
      }
    } catch (e) { console.warn('cache: lecture du dossier impossible :', e.message); }
  }

  meta(key) { return this.index.get(key) || null; }

  remember(key, buf) {
    const old = this.mem.get(key);
    if (old) { this.memBytes -= old.length; this.mem.delete(key); }
    this.mem.set(key, buf);
    this.memBytes += buf.length;
    while (this.memBytes > this.memMax && this.mem.size > 1) {
      const [k, b] = this.mem.entries().next().value;
      this.mem.delete(k); this.memBytes -= b.length;
      if (!this.persist) { this.index.delete(k); this.auxMem.delete(k); } // memory-only mode: evicted = gone
    }
  }

  // gzip Buffer of the stored JSON payload
  async body(key) {
    const m = this.index.get(key);
    if (!m) return null;
    let buf = this.mem.get(key);
    if (buf) { this.mem.delete(key); this.mem.set(key, buf); }
    else if (this.persist) {
      try { buf = await fs.promises.readFile(this.file(key, 'json.gz')); this.remember(key, buf); }
      catch { this.delete(key); return null; }
    } else return null;
    m.hits = (m.hits || 0) + 1;
    m.lastAccess = Date.now();
    return buf;
  }

  async payload(key) {
    const buf = await this.body(key);
    return buf ? JSON.parse((await gunzip(buf)).toString('utf8')) : null;
  }

  async set(key, meta, payload) {
    const json = JSON.stringify(payload);
    const buf = await gzip(json, { level: 6 });
    const old = this.index.get(key);
    const m = {
      hits: 0, ...old, ...meta, key,
      bytes: buf.length, rawBytes: Buffer.byteLength(json), lastAccess: Date.now(),
      version: (old?.version || 0) + 1,
    };
    this.index.set(key, m);
    this.remember(key, buf);
    if (this.persist) {
      try {
        await writeAtomic(this.file(key, 'json.gz'), buf);
        await writeAtomic(this.file(key, 'meta.json'), JSON.stringify(m));
        this.enforceDisk();
      } catch (e) { console.warn('cache: écriture impossible :', e.message); }
    }
    return m;
  }

  // update metadata only (e.g. "still up to date at 10:42")
  touch(key, patch) {
    const m = this.index.get(key);
    if (!m) return null;
    Object.assign(m, patch);
    if (this.persist) writeAtomic(this.file(key, 'meta.json'), JSON.stringify(m)).catch(() => {});
    return m;
  }

  enforceDisk() {
    let total = 0;
    for (const m of this.index.values()) total += m.bytes || 0;
    if (total <= this.diskMax) return;
    const byAge = [...this.index.values()].sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0));
    for (const m of byAge) {
      if (total <= this.diskMax * 0.9) break;
      if (this.inflight.has(m.key)) continue;
      total -= m.bytes || 0;
      this.delete(m.key);
    }
  }

  delete(key) {
    const b = this.mem.get(key);
    if (b) { this.memBytes -= b.length; this.mem.delete(key); }
    this.index.delete(key);
    this.auxMem.delete(key);
    if (this.persist) {
      fs.rmSync(this.file(key, 'json.gz'), { force: true });
      fs.rmSync(this.file(key, 'meta.json'), { force: true });
      fs.rmSync(this.file(key, 'aux.gz'), { force: true });
    }
  }

  clear(predicate = () => true) {
    let n = 0;
    for (const m of [...this.index.values()]) if (predicate(m)) { this.delete(m.key); n++; }
    return n;
  }

  // Runs fn once per key: concurrent callers share the same promise
  once(key, fn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = Promise.resolve().then(fn).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  totals() {
    let disk = 0, raw = 0;
    for (const m of this.index.values()) { disk += m.bytes || 0; raw += m.rawBytes || 0; }
    return { entries: this.index.size, memBytes: this.memBytes, memMax: this.memMax, diskBytes: this.persist ? disk : 0, diskMax: this.persist ? this.diskMax : 0, rawBytes: raw, persist: this.persist };
  }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.promises.writeFile(tmp, data, { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}

module.exports = { DataCache, gunzip };
