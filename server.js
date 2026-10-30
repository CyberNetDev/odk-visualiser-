// ODK Visualizer — zero-dependency Node (>=18) server.
// - Each user signs in from the app with THEIR OWN ODK Central account (server URL + e-mail + password).
//   The password is sent once to Central and never stored; the server keeps only Central's session
//   token in memory, linked to an HttpOnly cookie. Users see only the projects their account can see.
// - Proxies the Central API / OData feed (avoids CORS) and pages through results.
// - Caches heavy downloads (cache.js): memory + gzip files on disk, shared between users of the same
//   ODK server after checking each user's access, stale-while-revalidate, incremental refresh
//   (only new/edited submissions, via __system/updatedAt) and gzip/ETag responses.
// - Stores saved visualizations and field transformations per ODK server in data/*.json.
// - Serves the frontend from /public.
// Every setting is optional (see .env.example): nothing is required to start the app.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const demo = require('./demo-data');
const { extractLabels, csvChoices } = require('./xform');
const zlib = require('node:zlib');
const { DataCache, gunzip } = require('./cache');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
// Data cache: entries younger than CACHE_MINUTES are served as-is; older ones are served immediately
// and refreshed in the background; beyond CACHE_MAX_STALE_HOURS the refresh is awaited.
const CACHE_MINUTES = Number(process.env.CACHE_MINUTES || 5);
const CACHE_MAX_STALE_HOURS = Number(process.env.CACHE_MAX_STALE_HOURS || 24);
const CACHE_FULL_REFRESH_HOURS = Number(process.env.CACHE_FULL_REFRESH_HOURS || 12); // full reload even if deltas work
const CACHE_PERSIST = !/^(0|false|no)$/i.test(process.env.CACHE_PERSIST || 'true');
const CACHE_MEMORY_MB = Number(process.env.CACHE_MEMORY_MB || 256);
const CACHE_DISK_MB = Number(process.env.CACHE_DISK_MB || 2048);
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 1000);
// Pre-fill the server field on the login screen (ODK_URL kept for compatibility)
const DEFAULT_SERVER = normalizeServer(process.env.ODK_DEFAULT_URL || process.env.ODK_URL || '');
// true = users cannot change the server (only DEFAULT_SERVER is used)
const LOCK_SERVER = /^(1|true|yes)$/i.test(process.env.ODK_LOCK_URL || '') && !!DEFAULT_SERVER;
// Optional allow-list of Central servers users may connect to (comma separated)
const ALLOWED_SERVERS = (process.env.ALLOWED_SERVERS || '').split(',').map(normalizeServer).filter(Boolean);
const ALLOW_DEMO = !/^(0|false|no)$/i.test(process.env.ALLOW_DEMO || 'true');
// Secure cookie: auto (when served over HTTPS / behind a proxy sending X-Forwarded-Proto), or force with true/false
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'auto').toLowerCase();
const COOKIE = 'odkvis_sid';

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const FAV_FILE = path.join(DATA_DIR, 'visualizations.json');
const TRANSFORMS_FILE = path.join(DATA_DIR, 'transforms.json');
const dataCache = new DataCache({ dir: process.env.CACHE_DIR || path.join(DATA_DIR, 'cache'), persist: CACHE_PERSIST, memoryMB: CACHE_MEMORY_MB, diskMB: CACHE_DISK_MB });

// ---------------------------------------------------------------- env loader
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

// Accepts "central.org", "https://central.org/", "https://central.org/#/projects/3" ... → "https://central.org"
function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    let p = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
    return `${u.protocol}//${u.host}${p}`;
  } catch { return ''; }
}

// ---------------------------------------------------------------- user sessions
// sid -> { server, email, name, token, expiresAt, demo }
const sessions = new Map();

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function isSecure(req) {
  if (COOKIE_SECURE === 'true') return true;
  if (COOKIE_SECURE === 'false') return false;
  return req.socket.encrypted || /https/i.test(req.headers['x-forwarded-proto'] || '');
}
function setSessionCookie(req, res, sid, expires) {
  const parts = [`${COOKIE}=${sid || ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(sid ? `Expires=${new Date(expires).toUTCString()}` : 'Max-Age=0');
  if (isSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function getSession(req) {
  const sid = parseCookies(req)[COOKIE];
  const s = sid && sessions.get(sid);
  if (!s) return null;
  if (new Date(s.expiresAt).getTime() < Date.now()) { sessions.delete(sid); return null; }
  return { sid, ...s };
}
setInterval(() => { for (const [k, s] of sessions) if (new Date(s.expiresAt).getTime() < Date.now()) sessions.delete(k); }, 10 * 60_000).unref();

// very small brute-force protection on /api/login: max 10 failed attempts per IP per 10 minutes
const failures = new Map();
function recentFailures(ip) {
  const list = (failures.get(ip) || []).filter(t => Date.now() - t < 10 * 60_000);
  failures.set(ip, list);
  return list;
}

async function fetchWithTimeout(url, opts = {}, ms = 20_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

async function login(body) {
  if (body.demo) {
    if (!ALLOW_DEMO) throw httpError(403, 'Le mode démo est désactivé sur ce serveur.');
    return { server: 'demo', email: 'demo', name: 'Démo', token: null, demo: true, expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() };
  }
  const server = LOCK_SERVER ? DEFAULT_SERVER : normalizeServer(body.server);
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  if (!server) throw httpError(400, 'Adresse du serveur ODK Central invalide.');
  if (!email || !password) throw httpError(400, 'E-mail et mot de passe obligatoires.');
  if (ALLOWED_SERVERS.length && !ALLOWED_SERVERS.includes(server)) throw httpError(403, 'Ce serveur ODK Central n\'est pas autorisé sur cette installation.');

  let res;
  try {
    res = await fetchWithTimeout(`${server}/v1/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    throw httpError(502, `Impossible de joindre ${server} (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}). Vérifiez l'adresse.`);
  }
  if (res.status === 401) throw httpError(401, 'E-mail ou mot de passe incorrect.');
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('json')) throw httpError(502, `Ce serveur ne répond pas comme ODK Central (HTTP ${res.status}). Vérifiez l'adresse.`);
  const s = await res.json();
  if (!s.token) throw httpError(502, 'Réponse inattendue du serveur ODK Central.');

  let name = email;
  try {
    const me = await fetchWithTimeout(`${server}/v1/users/current`, { headers: { Authorization: `Bearer ${s.token}` } }, 10_000);
    if (me.ok) name = (await me.json()).displayName || email;
  } catch { /* optional */ }
  return { server, email, name, token: s.token, expiresAt: s.expiresAt, demo: false };
}

async function logout(sess) {
  if (!sess) return;
  sessions.delete(sess.sid);
  if (sess.token) {
    fetchWithTimeout(`${sess.server}/v1/sessions/${sess.token}`, { method: 'DELETE', headers: { Authorization: `Bearer ${sess.token}` } }, 5000).catch(() => {});
  }
}

// ---------------------------------------------------------------- ODK Central client (per session)
async function central(sess, target, { raw = false } = {}) {
  const url = target.startsWith('http') ? target : `${sess.server}${target}`;
  if (!url.startsWith(sess.server + '/')) throw httpError(400, 'Requête hors du serveur ODK connecté refusée.');
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${sess.token}` } }, 120_000);
  } catch (e) {
    throw httpError(502, `Serveur ODK injoignable (${e.cause?.code || e.message}).`);
  }
  if (res.status === 401) {
    sessions.delete(sess.sid);
    const err = httpError(401, 'Session ODK expirée, reconnectez-vous.'); err.relogin = true; throw err;
  }
  if (res.status === 403) throw httpError(403, 'Votre compte ODK n\'a pas accès à cette ressource.');
  if (!res.ok) {
    const body = await res.text();
    throw httpError(res.status, `ODK Central ${res.status} : ${body.slice(0, 300)}`);
  }
  return raw ? res.text() : res.json();
}

const enc = encodeURIComponent;

// Page through an OData entity set and return all rows.
async function fetchAllOData(sess, basePath, query) {
  const rows = [];
  let skip = 0;
  let next = null;
  for (let guard = 0; guard < 10000; guard++) {
    const params = new URLSearchParams({ ...query, $top: String(PAGE_SIZE), $count: 'true' });
    if (skip) params.set('$skip', String(skip));
    const page = next ? await central(sess, next) : await central(sess, `${basePath}?${params}`);
    const value = page.value || [];
    rows.push(...value);
    const total = page['@odata.count'];
    if (page['@odata.nextLink']) { next = page['@odata.nextLink']; continue; }
    next = null;
    if (value.length < PAGE_SIZE || (total != null && rows.length >= total)) break;
    skip += PAGE_SIZE;
  }
  return rows;
}

// ---------------------------------------------------------------- small per-user memo (labels, fields, tables, access checks)
const memo = new Map();
async function memoize(key, fn, ms = CACHE_MINUTES * 60_000) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value;
  const value = await fn();
  memo.set(key, { at: Date.now(), value });
  if (memo.size > 1000) memo.delete(memo.keys().next().value);
  return value;
}

// A user may read a cached form only if their own ODK account can open it (re-checked every 2 minutes)
async function ensureAccess(sess, pid, fid) {
  if (sess.demo) return;
  await memoize(`${sess.server}|${sess.email}|access|${pid}|${fid}`, () => central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}`), 120_000);
}

const formNames = new Map(); // server|pid|fid -> form title (for the cache panel)
const noDelta = new Set();   // servers that refused incremental queries (Central < 1.3)
const scopeOf = sess => (sess.demo ? 'demo' : sess.server);

function buildFilter(table, q) {
  // On sub-tables (repeats) Central filters through the parent submission: $root/Submissions/__system/...
  const sys = table === 'Submissions' ? '__system' : '$root/Submissions/__system';
  const filters = [];
  if (q.from) filters.push(`${sys}/submissionDate ge ${new Date(q.from).toISOString()}`);
  if (q.to) filters.push(`${sys}/submissionDate lt ${new Date(new Date(q.to).getTime() + 86400000).toISOString()}`);
  if (q.reviewState) {
    const states = q.reviewState.split(',').filter(x => /^(null|received|hasIssues|edited|approved|rejected)$/.test(x));
    if (states.length) filters.push('(' + states.map(x => x === 'null' || x === 'received' ? `${sys}/reviewState eq null` : `${sys}/reviewState eq '${x}'`).join(' or ') + ')');
  }
  return filters.join(' and ');
}

// Where the rows come from: ODK Central (OData) or the demo dataset
function sourceFor(sess, pid, fid, params) {
  if (sess.demo) {
    return {
      fetch: async table => ({ rows: demo.data(fid, table, params).rows, filtered: true }),
      rootSig: async () => `total:${demo.data(fid, 'Submissions', {}).rows.length}`,
      changedSince: async () => 0,
      count: async () => demo.data(fid, 'Submissions', params).rows.length,
      delta: null,
    };
  }
  const svc = `/v1/projects/${enc(pid)}/forms/${enc(fid)}.svc`;
  const count = async (table, filter) => {
    const qs = new URLSearchParams({ $top: '1', $count: 'true' });
    if (filter) qs.set('$filter', filter);
    const r = await central(sess, `${svc}/${table}?${qs}`);
    return r['@odata.count'] ?? (r.value || []).length;
  };
  const changed = iso => `(__system/submissionDate gt ${iso} or __system/updatedAt gt ${iso})`;
  return {
    async fetch(table, filter) {
      try { return { rows: await fetchAllOData(sess, `${svc}/${table}`, filter ? { $filter: filter } : {}), filtered: true }; }
      catch (e) {
        // older Central versions don't support $root on sub-tables: load everything, the browser filters via the parent
        if (!filter || table === 'Submissions' || e.status === 401 || e.status === 403) throw e;
        return { rows: await fetchAllOData(sess, `${svc}/${table}`, {}), filtered: false };
      }
    },
    // Fingerprint of the form: total + number of submissions per review state. Catches deletions and
    // review-state changes, which a filter on __system/updatedAt may not reveal.
    async rootSig() {
      const states = ['null', "'received'", "'hasIssues'", "'edited'", "'approved'", "'rejected'"];
      const [total, ...per] = await Promise.all([count('Submissions', ''), ...states.map(x => count('Submissions', `__system/reviewState eq ${x}`).catch(() => '?'))]);
      return `total:${total};` + states.map((x, i) => `${x}:${per[i]}`).join(';');
    },
    changedSince: iso => count('Submissions', changed(iso)),
    count,
    delta: (filter, iso) => fetchAllOData(sess, `${svc}/Submissions`, { $filter: filter ? `(${filter}) and ${changed(iso)}` : changed(iso) }),
  };
}

// Brings a cache entry up to date. mode 'auto': cheap check first (2 tiny count queries), then only the
// new/edited submissions (main table) or a full reload (repeats, deletions...). mode 'full': full reload.
function refreshEntry(key, ctx, mode = 'auto') {
  return dataCache.once(key, async () => {
    const { src, table, filter } = ctx;
    const m = dataCache.meta(key);
    const t0 = Date.now();
    const full = async reason => {
      const [res, rootSig] = await Promise.all([src.fetch(table, filter), src.rootSig().catch(() => null)]);
      const ms = Date.now() - t0;
      console.log(`cache: ${ctx.fid}/${table} chargement complet (${reason}) : ${res.rows.length} lignes en ${ms} ms`);
      return dataCache.set(key, {
        server: ctx.server, pid: ctx.pid, fid: ctx.fid, table, filter, params: ctx.params,
        at: t0, dataAt: t0, fullAt: t0, rows: res.rows.length, rootSig, fetchMs: ms, mode: 'full',
        last: { kind: 'full', reason, rows: res.rows.length, ms },
      }, { rows: res.rows, filtered: res.filtered });
    };
    if (!m || mode === 'full') return full(m ? 'demandé' : 'premier chargement');
    if (t0 - (m.fullAt || 0) > CACHE_FULL_REFRESH_HOURS * 3600e3) return full('rechargement complet périodique');
    if (noDelta.has(ctx.server)) return full('serveur sans requêtes incrémentales');
    const since = new Date((m.at || 0) - 120_000).toISOString(); // 2 min overlap: clock skew, uploads in progress
    try {
      const [changed, rootSig] = await Promise.all([src.changedSince(since), src.rootSig()]);
      if (changed === 0 && rootSig === m.rootSig) {
        return dataCache.touch(key, { at: t0, checks: (m.checks || 0) + 1, last: { kind: 'check', ms: Date.now() - t0 } });
      }
      if (table !== 'Submissions' || !src.delta || !changed) return full(changed ? `${changed} soumission(s) nouvelle(s) ou modifiée(s)` : 'suppression ou changement d\'état de revue');
      const delta = await src.delta(filter, since);
      const old = await dataCache.payload(key);
      if (!old) return full('cache illisible');
      const byId = new Map(old.rows.map(r => [r.__id, r]));
      let added = 0, updated = 0;
      for (const r of delta) { if (byId.has(r.__id)) updated++; else added++; byId.set(r.__id, r); }
      const rows = [...byId.values()];
      // deletions or rows leaving the filter (e.g. now "rejected") are invisible to a delta: verify the total
      if ((await src.count('Submissions', filter)) !== rows.length) return full('suppression ou changement d\'état détecté');
      const ms = Date.now() - t0;
      console.log(`cache: ${ctx.fid}/${table} incrémental : +${added} nouvelles, ${updated} modifiées en ${ms} ms`);
      return dataCache.set(key, { ...m, at: t0, dataAt: t0, rows: rows.length, rootSig, fetchMs: ms, mode: 'delta', last: { kind: 'delta', added, updated, ms } }, { rows, filtered: old.filtered });
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      if (e.status === 400 || e.status === 501) noDelta.add(ctx.server); // no filter on __system/updatedAt
      return full('requête incrémentale refusée');
    }
  });
}

async function serveData(req, res, sess, pid, fid, q) {
  const table = q.table || 'Submissions';
  if (!/^[\w.\-]+$/.test(table)) throw httpError(400, 'Nom de table invalide');
  await ensureAccess(sess, pid, fid);
  const params = { from: q.from || '', to: q.to || '', reviewState: q.reviewState || '' };
  const filter = buildFilter(table, params);
  const scope = scopeOf(sess);
  const key = DataCache.key([scope, String(pid), fid, table, filter]);
  const ctx = { src: sourceFor(sess, pid, fid, params), table, filter, server: scope, pid: String(pid), fid, params };
  let m = dataCache.meta(key), state;
  const age = m ? Date.now() - m.at : Infinity;
  if (q.refresh) { await refreshEntry(key, ctx, q.refresh === 'full' ? 'full' : 'auto'); state = 'refreshed'; }
  else if (!m) { await refreshEntry(key, ctx); state = 'miss'; }
  else if (age > CACHE_MAX_STALE_HOURS * 3600e3 || (age > CACHE_MINUTES * 60e3 && q.wait === '1')) { await refreshEntry(key, ctx); state = 'refreshed'; }
  else if (age > CACHE_MINUTES * 60e3) {
    refreshEntry(key, ctx).catch(e => console.warn('cache: actualisation en arrière-plan :', e.message));
    state = 'stale';
  } else if (q.wait === '1' && dataCache.inflight.has(key)) { await dataCache.inflight.get(key); state = 'refreshed'; }
  else state = 'hit';
  let buf = await dataCache.body(key);
  if (!buf) { await refreshEntry(key, ctx, 'full'); buf = await dataCache.body(key); state = 'miss'; }
  m = dataCache.meta(key);
  const etag = `"${key.slice(0, 12)}-${m.version}"`;
  const h = {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-cache', ETag: etag, Vary: 'Accept-Encoding, Cookie',
    'X-Cache': state, 'X-Checked-At': String(m.at), 'X-Data-At': String(m.dataAt), 'X-Rows': String(m.rows),
    'X-Refreshing': dataCache.inflight.has(key) ? '1' : '0', 'X-Cache-Key': key,
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': buf.length });
    return res.end(buf);
  }
  const raw = await gunzip(buf);
  res.writeHead(200, { ...h, 'Content-Length': raw.length });
  res.end(raw);
}

// Cache panel: entries of the user's ODK server, for projects the account can see
async function cacheEntries(sess) {
  const scope = scopeOf(sess);
  const allowed = new Set((await api.projects(sess)).map(p => String(p.id)));
  return [...dataCache.index.values()]
    .filter(m => m.server === scope && allowed.has(String(m.pid)))
    .map(m => ({
      key: m.key, projectId: m.pid, formId: m.fid, formName: formNames.get(`${scope}|${m.pid}|${m.fid}`) || m.fid,
      table: m.table, params: m.params || {}, rows: m.rows, bytes: m.bytes, rawBytes: m.rawBytes,
      at: m.at, dataAt: m.dataAt, fullAt: m.fullAt, hits: m.hits || 0, checks: m.checks || 0, mode: m.mode,
      fetchMs: m.fetchMs, last: m.last, lastAccess: m.lastAccess, refreshing: dataCache.inflight.has(m.key),
    }))
    .sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0));
}

// ---------------------------------------------------------------- data source API
const api = {
  async projects(sess) {
    if (sess.demo) return demo.projects();
    const list = await central(sess, '/v1/projects');
    return list.filter(p => !p.archived).map(p => ({ id: p.id, name: p.name }));
  },

  async forms(sess, pid) {
    const list = sess.demo
      ? demo.forms(pid)
      : (await central(sess, `/v1/projects/${enc(pid)}/forms`)).map(f => ({ id: f.xmlFormId, name: f.name || f.xmlFormId, submissions: f.submissions, state: f.state }));
    for (const f of list) formNames.set(`${scopeOf(sess)}|${pid}|${f.id}`, f.name);
    return list;
  },

  // Tables in the OData service: "Submissions" plus one per repeat group.
  async tables(sess, pid, fid) {
    if (sess.demo) return demo.tables(fid);
    const xml = await memoize(`${sess.server}|${sess.email}|meta|${pid}|${fid}`, () => central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}.svc/$metadata`, { raw: true }));
    const names = [...xml.matchAll(/<EntitySet\s+Name="([^"]+)"/g)].map(m => m[1]);
    return names.length ? names : ['Submissions'];
  },

  async fields(sess, pid, fid) {
    if (sess.demo) return demo.fields(fid);
    const list = await memoize(`${sess.server}|${sess.email}|fields|${pid}|${fid}`, () => central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}/fields?odata=true`));
    return list
      .filter(f => f.type !== 'structure')
      .map(f => ({ path: f.path.replace(/^\//, ''), name: f.name, type: f.type, selectMultiple: !!f.selectMultiple, repeat: f.type === 'repeat' }));
  },

  // Question & choice labels from the XForm (+ CSV attachments for select_one_from_file / entity lists)
  async labels(sess, pid, fid) {
    const key = `${sess.server}|${sess.email}|labels|${pid}|${fid}`;
    return memoize(key, async () => {
      const xml = sess.demo ? demo.formXml(fid) : await central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}.xml`, { raw: true });
      const L = extractLabels(xml);
      for (const ex of L.externals) {
        if (!/\.csv$/i.test(ex.file)) continue;
        try {
          const csv = sess.demo ? demo.attachment(ex.file)
            : await central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}/attachments/${enc(ex.file)}`, { raw: true });
          L.choices[ex.path] = csvChoices(csv, ex.valueRef, ex.labelRef);
          for (const v of Object.values(L.choices[ex.path])) for (const lang of Object.keys(v)) if (lang && !L.languages.includes(lang)) L.languages.push(lang);
        } catch (e) { console.warn(`labels: ${ex.file}: ${e.message}`); }
      }
      delete L.externals;
      return L;
    });
  },
};

// ---------------------------------------------------------------- saved visualizations (scoped to the ODK server)
function readFavs() {
  try { return JSON.parse(fs.readFileSync(FAV_FILE, 'utf8')); } catch { return []; }
}
function writeFavs(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FAV_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FAV_FILE);
}
const favServer = v => v.server || 'demo';

// Field transformations (derived fields, display formats), shared per form on the same ODK server
function readTransforms() { try { return JSON.parse(fs.readFileSync(TRANSFORMS_FILE, 'utf8')); } catch { return []; } }
function writeTransforms(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TRANSFORMS_FILE + '.tmp', JSON.stringify(list, null, 2));
  fs.renameSync(TRANSFORMS_FILE + '.tmp', TRANSFORMS_FILE);
}
const TRANSFORM_KINDS = ['number', 'bins', 'recode', 'text', 'date', 'datepart', 'duration', 'formula', 'display'];
function cleanTransform(body) {
  const t = { ...body };
  for (const k of ['server', 'pid', 'fid', 'owner', 'ownerName', 'updatedAt', 'mine', 'local']) delete t[k];
  if (!TRANSFORM_KINDS.includes(t.kind)) throw httpError(400, 'Type de transformation inconnu');
  t.name = String(t.name || '').slice(0, 120);
  if (JSON.stringify(t).length > 64000) throw httpError(413, 'Transformation trop volumineuse');
  return t;
}

// ---------------------------------------------------------------- http plumbing
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = type.startsWith('application/json') ? JSON.stringify(body) : body;
  const h = { 'Content-Type': type, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  if (typeof data === 'string' && data.length > 16384 && /\bgzip\b/.test(res.req?.headers['accept-encoding'] || '')) {
    const gz = zlib.gzipSync(data);
    res.writeHead(status, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': gz.length });
    return res.end(gz);
  }
  res.writeHead(status, h);
  res.end(data);
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 2e6) throw httpError(413, 'Requête trop volumineuse'); }
  try { return data ? JSON.parse(data) : {}; } catch { throw httpError(400, 'JSON invalide'); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

// Libraries are bundled into public/vendor by the Docker build. If missing (plain `node server.js`), use the CDN.
const VENDOR_CDN = {
  '/vendor/echarts.min.js': 'https://cdnjs.cloudflare.com/ajax/libs/echarts/5.5.1/echarts.min.js',
  '/vendor/leaflet.min.js': 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  '/vendor/leaflet.min.css': 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
};

function serveStatic(req, res, pathname) {
  if (VENDOR_CDN[pathname] && !fs.existsSync(path.join(PUBLIC_DIR, pathname))) {
    res.writeHead(302, { Location: VENDOR_CDN[pathname] });
    return res.end();
  }
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const q = Object.fromEntries(url.searchParams);
    let m;

    if (!p.startsWith('/api/')) return serveStatic(req, res, p);
    if (p === '/api/health') return send(res, 200, { ok: true });

    // CSRF guard for state-changing calls: require same-origin JSON requests
    if (req.method !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) {
      return send(res, 415, { error: 'Content-Type application/json requis' });
    }

    // ---------- public auth endpoints
    if (p === '/api/config') {
      return send(res, 200, { defaultServer: DEFAULT_SERVER, lockServer: LOCK_SERVER, allowedServers: ALLOWED_SERVERS, allowDemo: ALLOW_DEMO });
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
      if (recentFailures(ip).length >= 10) return send(res, 429, { error: 'Trop de tentatives échouées. Réessayez dans quelques minutes.' });
      let s;
      try { s = await login(await readBody(req)); } catch (e) { if (e.status === 401) recentFailures(ip).push(Date.now()); throw e; }
      failures.delete(ip);
      const sid = crypto.randomBytes(32).toString('base64url');
      sessions.set(sid, s);
      setSessionCookie(req, res, sid, s.expiresAt);
      console.log(`login ${s.email} @ ${s.server}`);
      return send(res, 200, { server: s.server, email: s.email, name: s.name, demo: s.demo, expiresAt: s.expiresAt });
    }
    const sess = getSession(req);
    if (p === '/api/logout' && req.method === 'POST') {
      await logout(sess); setSessionCookie(req, res, null);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/me') {
      if (!sess) return send(res, 401, { error: 'Non connecté', relogin: true });
      return send(res, 200, { server: sess.server, email: sess.email, name: sess.name, demo: sess.demo, expiresAt: sess.expiresAt });
    }

    // ---------- everything below requires a session
    if (!sess) return send(res, 401, { error: 'Veuillez vous connecter à ODK Central.', relogin: true });

    if (p === '/api/projects') return send(res, 200, await api.projects(sess));
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/forms$/))) return send(res, 200, await api.forms(sess, m[1]));
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/forms\/([^/]+)\/tables$/))) return send(res, 200, await api.tables(sess, m[1], decodeURIComponent(m[2])));
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/forms\/([^/]+)\/fields$/))) return send(res, 200, await api.fields(sess, m[1], decodeURIComponent(m[2])));
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/forms\/([^/]+)\/labels$/))) return send(res, 200, await api.labels(sess, m[1], decodeURIComponent(m[2])));
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/forms\/([^/]+)\/data$/))) return await serveData(req, res, sess, m[1], decodeURIComponent(m[2]), q);

    // Field transformations of a form: readable by anyone who can open the form, editable by their author
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/forms\/([^/]+)\/transforms(?:\/([\w-]{6,64}))?$/))) {
      const [pid, fid, id] = [m[1], decodeURIComponent(m[2]), m[3]];
      await ensureAccess(sess, pid, fid);
      const scope = scopeOf(sess);
      const list = readTransforms();
      const mine = t => ({ ...t, mine: t.owner === sess.email });
      const same = t => t.server === scope && String(t.pid) === String(pid) && t.fid === fid;
      if (!id && req.method === 'GET') return send(res, 200, list.filter(same).map(mine));
      if (!id && req.method === 'POST') {
        const t = cleanTransform(await readBody(req));
        if (!/^[\w-]{6,64}$/.test(t.id || '') || list.some(x => x.id === t.id)) t.id = crypto.randomUUID();
        const item = { ...t, server: scope, pid: String(pid), fid, owner: sess.email, ownerName: sess.name, updatedAt: new Date().toISOString() };
        list.push(item); writeTransforms(list);
        return send(res, 201, mine(item));
      }
      const i = list.findIndex(t => t.id === id && same(t));
      if (i < 0) return send(res, 404, { error: 'Transformation introuvable' });
      if (list[i].owner !== sess.email) return send(res, 403, { error: `Seul son auteur (${list[i].ownerName || list[i].owner}) peut modifier ou supprimer ce champ. Créez-en une copie.` });
      if (req.method === 'PUT') {
        const t = cleanTransform(await readBody(req));
        list[i] = { ...t, id, server: scope, pid: String(pid), fid, owner: sess.email, ownerName: sess.name, updatedAt: new Date().toISOString() };
        writeTransforms(list); return send(res, 200, mine(list[i]));
      }
      if (req.method === 'DELETE') { list.splice(i, 1); writeTransforms(list); return send(res, 200, { ok: true }); }
    }

    // Data cache panel
    if (p === '/api/cache' && req.method === 'GET') {
      return send(res, 200, {
        settings: { freshMinutes: CACHE_MINUTES, maxStaleHours: CACHE_MAX_STALE_HOURS, fullRefreshHours: CACHE_FULL_REFRESH_HOURS, incremental: !noDelta.has(scopeOf(sess)) },
        totals: dataCache.totals(), entries: await cacheEntries(sess),
      });
    }
    if (p === '/api/cache' && req.method === 'DELETE') {
      const keys = new Set((await cacheEntries(sess)).filter(e => !e.refreshing).map(e => e.key));
      return send(res, 200, { deleted: dataCache.clear(x => keys.has(x.key)) });
    }
    if ((m = p.match(/^\/api\/cache\/([0-9a-f]{32})(\/refresh)?$/))) {
      const meta = dataCache.meta(m[1]);
      if (!meta || meta.server !== scopeOf(sess)) return send(res, 404, { error: 'Entrée de cache introuvable' });
      await ensureAccess(sess, meta.pid, meta.fid);
      if (m[2] && req.method === 'POST') {
        const body = await readBody(req);
        const ctx = { src: sourceFor(sess, meta.pid, meta.fid, meta.params || {}), table: meta.table, filter: meta.filter, server: meta.server, pid: meta.pid, fid: meta.fid, params: meta.params || {} };
        await refreshEntry(m[1], ctx, body.full ? 'full' : 'auto');
        return send(res, 200, (await cacheEntries(sess)).find(e => e.key === m[1]) || {});
      }
      if (!m[2] && req.method === 'DELETE') { dataCache.delete(m[1]); return send(res, 200, { ok: true }); }
    }

    // Saved visualizations: visible to everyone connected to the same ODK server, editable by their owner.
    if (p === '/api/visualizations') {
      if (req.method === 'GET') {
        // only list visualizations whose project this account can access
        const allowed = new Set((await api.projects(sess)).map(p => String(p.id)));
        return send(res, 200, readFavs().filter(v => favServer(v) === sess.server && (!v.projectId || allowed.has(String(v.projectId))))
          .map(({ id, name, type, updatedAt, owner, ownerName }) => ({ id, name, type, updatedAt, owner, ownerName, mine: owner === sess.email })));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const list = readFavs();
        const item = { ...body, id: crypto.randomUUID(), server: sess.server, owner: sess.email, ownerName: sess.name, updatedAt: new Date().toISOString() };
        list.push(item); writeFavs(list);
        return send(res, 201, item);
      }
    }
    if ((m = p.match(/^\/api\/visualizations\/([\w-]+)$/))) {
      const list = readFavs();
      const i = list.findIndex(v => v.id === m[1] && favServer(v) === sess.server);
      if (i < 0) return send(res, 404, { error: 'Visualisation introuvable sur ce serveur ODK.' });
      if (req.method === 'GET') return send(res, 200, { ...list[i], mine: list[i].owner === sess.email });
      if (list[i].owner && list[i].owner !== sess.email) return send(res, 403, { error: 'Seul son auteur peut modifier ou supprimer cette visualisation. Utilisez « Enregistrer sous ».' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        list[i] = { ...body, id: m[1], server: sess.server, owner: sess.email, ownerName: sess.name, updatedAt: new Date().toISOString() };
        writeFavs(list); return send(res, 200, list[i]);
      }
      if (req.method === 'DELETE') { list.splice(i, 1); writeFavs(list); return send(res, 200, { ok: true }); }
    }
    send(res, 404, { error: 'Endpoint inconnu' });
  } catch (err) {
    if (!err.status || err.status >= 500) console.error(err.message);
    send(res, err.status && err.status < 600 ? err.status : 500, { error: err.message, relogin: !!err.relogin });
  }
});

// never let a stray promise take the whole server down
process.on('unhandledRejection', e => console.error('Erreur non gérée :', e && e.message ? e.message : e));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));

server.listen(PORT, () => {
  console.log(`ODK Visualizer running on http://localhost:${PORT}`);
  console.log(LOCK_SERVER ? `Login limited to ${DEFAULT_SERVER}` : 'Users sign in to their ODK Central server from the app');
  const t = dataCache.totals();
  console.log(`Cache: ${CACHE_PERSIST ? `disque (${t.entries} entrées, ${(t.diskBytes / 1048576).toFixed(1)} Mo)` : 'mémoire seulement'}, frais ${CACHE_MINUTES} min, max ${CACHE_MEMORY_MB} Mo en mémoire`);
});
