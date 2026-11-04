// ODK Visualizer — zero-dependency Node (>=18) server.
// - Each user signs in from the app with THEIR OWN account on their data platform: ODK Central, IASO
//   (Bluesquare) or CommCare HQ (connectors/). The password is sent once to the platform and never
//   stored; the server keeps only the platform's session token (or API key) in memory, linked to an
//   HttpOnly cookie. Users see only the projects their account can see.
// - Proxies the platform APIs (avoids CORS), pages through results and turns every platform's records
//   into the same row shape (the one of ODK Central's OData feed).
// - Caches heavy downloads (cache.js): memory + gzip files on disk, stale-while-revalidate, incremental
//   refresh (only new/edited submissions) and gzip/ETag responses. ODK entries are shared between users
//   of the same server after checking each user's access; IASO and CommCare entries are per user
//   (those platforms restrict submissions by org unit / location).
// - Stores saved visualizations and field transformations per server in data/*.json.
// - Serves the frontend from /public.
// Every setting is optional (see .env.example): nothing is required to start the app.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

loadEnv(path.join(__dirname, '.env'));

const { DataCache, gunzip } = require('./cache');
const { ALL: CONNECTORS, PRESETS } = require('./connectors');
const { httpError } = require('./connectors/common');

const PORT = Number(process.env.PORT || 3000);
// Data cache: entries younger than CACHE_MINUTES are served as-is; older ones are served immediately
// and refreshed in the background; beyond CACHE_MAX_STALE_HOURS the refresh is awaited.
const CACHE_MINUTES = Number(process.env.CACHE_MINUTES || 5);
const CACHE_MAX_STALE_HOURS = Number(process.env.CACHE_MAX_STALE_HOURS || 24);
const CACHE_FULL_REFRESH_HOURS = Number(process.env.CACHE_FULL_REFRESH_HOURS || 12); // full reload even if deltas work
const CACHE_PERSIST = !/^(0|false|no)$/i.test(process.env.CACHE_PERSIST || 'true');
const CACHE_MEMORY_MB = Number(process.env.CACHE_MEMORY_MB || 256);
const CACHE_DISK_MB = Number(process.env.CACHE_DISK_MB || 2048);
// Platforms offered on the login screen, in this order (comma separated: odk, iaso, commcare)
const PLATFORMS = (process.env.PLATFORMS || 'odk,iaso,commcare').split(',').map(s => s.trim().toLowerCase()).filter(p => CONNECTORS[p]);
if (!PLATFORMS.length) PLATFORMS.push('odk');
// Per platform: server pre-filled on the login screen, and optional lock (users cannot change it).
// ODK_URL kept for compatibility.
const ENV = { odk: 'ODK', iaso: 'IASO', commcare: 'COMMCARE' };
const SERVERS = Object.fromEntries(PLATFORMS.map(p => {
  const C = CONNECTORS[p];
  const def = C.normalizeServer(process.env[`${ENV[p]}_DEFAULT_URL`] || (p === 'odk' ? process.env.ODK_URL : '') || '');
  return [p, { defaultServer: def, lockServer: /^(1|true|yes)$/i.test(process.env[`${ENV[p]}_LOCK_URL`] || '') && !!def }];
}));
// Optional allow-list of servers users may connect to (comma separated, any platform)
const ALLOWED_SERVERS = (process.env.ALLOWED_SERVERS || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedServer = (C, server) => !ALLOWED_SERVERS.length || ALLOWED_SERVERS.some(a => C.normalizeServer(a) === server);
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

// ---------------------------------------------------------------- user sessions
// sid -> { platform, server, email (= login: e-mail or username), name, token, expiresAt, demo }
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

const connectorOf = sess => CONNECTORS[(sess && sess.platform) || 'odk'];
// What the browser learns about the session (never the token)
const me = s => ({ platform: s.platform || 'odk', platformLabel: s.demo ? 'Démo' : connectorOf(s).label, features: s.demo ? CONNECTORS.odk.features : connectorOf(s).features,
  server: s.server, email: s.email, name: s.name, demo: s.demo, expiresAt: s.expiresAt });

async function login(body) {
  if (body.demo) {
    if (!ALLOW_DEMO) throw httpError(403, 'Le mode démo est désactivé sur ce serveur.');
    return { platform: 'odk', server: 'demo', email: 'demo', name: 'Démo', token: null, demo: true, expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() };
  }
  const platform = String(body.platform || 'odk').toLowerCase();
  if (!PLATFORMS.includes(platform)) throw httpError(403, 'Cette plateforme n\'est pas activée sur cette installation.');
  const C = CONNECTORS[platform];
  const conf = SERVERS[platform];
  const server = conf.lockServer ? conf.defaultServer : C.normalizeServer(body.server);
  if (!server) throw httpError(400, `Adresse du serveur ${C.label} invalide.`);
  if (!allowedServer(C, server)) throw httpError(403, `Ce serveur ${C.label} n'est pas autorisé sur cette installation.`);
  const s = await C.login({ server, email: body.email, password: String(body.password || '') });
  return { platform, server, demo: false, ...s };
}

async function logout(sess) {
  if (!sess) return;
  sessions.delete(sess.sid);
  if (!sess.demo) await connectorOf(sess).logout(sess).catch(() => {});
}

// Saved visualizations and transformations are shared per server ("scope"); ODK keeps its historical
// scope (the server URL) so existing data stays visible.
const scopeOf = sess => (sess.demo ? 'demo' : (sess.platform || 'odk') === 'odk' ? sess.server : `${sess.platform}:${sess.server}`);
// Cached rows: shared per server for ODK (project-level rights), per user elsewhere
const cacheScope = sess => (sess.demo || connectorOf(sess).sharedCache !== false ? scopeOf(sess) : `${scopeOf(sess)}|${sess.email}`);

const formNames = new Map(); // scope|pid|fid -> form title (for the cache panel)

function ensureAccess(sess, pid, fid) { return connectorOf(sess).access(sess, pid, fid); }

// Brings a cache entry up to date. mode 'auto': cheap check first (small count queries), then only the
// new/edited submissions, or a full reload (deletions, platforms without incremental queries...).
// mode 'full': full reload. Repeat tables of IASO/CommCare are updated incrementally too: their rows carry
// __root (id of the submission) and the entry remembers which submissions it covers (cache aux file).
function refreshEntry(key, ctx, mode = 'auto') {
  return dataCache.once(key, async () => {
    const { src, table, filter, C } = ctx;
    const m = dataCache.meta(key);
    const t0 = Date.now();
    const full = async reason => {
      const [res, rootSig] = await Promise.all([src.fetch(table, filter), src.rootSig().catch(() => null)]);
      const ms = Date.now() - t0;
      console.log(`cache: ${ctx.fid}/${table} chargement complet (${reason}) : ${res.rows.length} lignes en ${ms} ms`);
      const meta = await dataCache.set(key, {
        server: ctx.server, platform: C.id, pid: ctx.pid, fid: ctx.fid, table, filter, params: ctx.params,
        at: t0, dataAt: t0, fullAt: t0, rows: res.rows.length, rootSig, fetchMs: ms, mode: 'full',
        last: { kind: 'full', reason, rows: res.rows.length, ms },
      }, { rows: res.rows, filtered: res.filtered });
      if (res.roots) await dataCache.setAux(key, { roots: res.roots });
      return meta;
    };
    if (!m || mode === 'full') return full(m ? 'demandé' : 'premier chargement');
    if (t0 - (m.fullAt || 0) > CACHE_FULL_REFRESH_HOURS * 3600e3) return full('rechargement complet périodique');
    if (!C.incremental(ctx.server)) return full('serveur sans requêtes incrémentales');
    const since = new Date((m.at || 0) - 120_000).toISOString(); // 2 min overlap: clock skew, uploads in progress
    try {
      const [changed, rootSig] = await Promise.all([src.changedSince(since), src.rootSig()]);
      if (changed === 0 && rootSig === m.rootSig) {
        return dataCache.touch(key, { at: t0, checks: (m.checks || 0) + 1, last: { kind: 'check', ms: Date.now() - t0 } });
      }
      const child = table !== 'Submissions';
      if ((child && !src.childDelta) || !src.delta || !changed) return full(changed ? `${changed} soumission(s) nouvelle(s) ou modifiée(s)` : 'suppression ou changement d\'état de revue');
      const [delta, old, aux] = await Promise.all([src.delta(filter, since, table), dataCache.payload(key), child ? dataCache.aux(key) : null]);
      if (!old || (child && !aux)) return full('cache illisible');
      let rows, added = 0, updated = 0, covered;
      if (!child) {
        const byId = new Map(old.rows.map(r => [r.__id, r]));
        for (const r of delta.rows) { if (byId.has(r.__id)) updated++; else added++; byId.set(r.__id, r); }
        rows = [...byId.values()];
        covered = rows.length;
      } else {
        // replace the repeat rows of every changed submission
        const changedRoots = new Set(delta.roots);
        const kept = old.rows.filter(r => !changedRoots.has(r.__root));
        updated = old.rows.length - kept.length;
        added = delta.rows.length;
        rows = [...kept, ...delta.rows];
        const roots = new Set(aux.roots);
        for (const id of delta.roots) roots.add(id);
        aux.roots = [...roots];
        covered = roots.size;
      }
      // deletions or rows leaving the filter (e.g. now "rejected") are invisible to a delta: verify the total
      if ((await src.count('Submissions', filter)) !== covered) return full('suppression ou changement d\'état détecté');
      const ms = Date.now() - t0;
      console.log(`cache: ${ctx.fid}/${table} incrémental : +${added} nouvelles, ${updated} modifiées en ${ms} ms`);
      const meta = await dataCache.set(key, { ...m, at: t0, dataAt: t0, rows: rows.length, rootSig, fetchMs: ms, mode: 'delta', last: { kind: 'delta', added, updated, ms } }, { rows, filtered: old.filtered });
      if (child) await dataCache.setAux(key, aux);
      return meta;
    } catch (e) {
      if (e.status === 401 || e.status === 403) throw e;
      if (e.status === 400 || e.status === 501) C.refuseIncremental(ctx.server); // e.g. no filter on __system/updatedAt
      return full('requête incrémentale refusée');
    }
  });
}

function contextFor(sess, pid, fid, table, q) {
  const C = connectorOf(sess);
  const params = { from: q.from || '', to: q.to || '', reviewState: C.features.reviewState ? q.reviewState || '' : '' };
  const filter = C.filterKey(table, params);
  const scope = cacheScope(sess);
  return { key: DataCache.key([scope, String(pid), fid, table, filter]), ctx: { C, src: C.source(sess, pid, fid, params), table, filter, server: scope, pid: String(pid), fid, params } };
}

async function serveData(req, res, sess, pid, fid, q) {
  const table = q.table || 'Submissions';
  if (!/^[\w.\-]+$/.test(table)) throw httpError(400, 'Nom de table invalide');
  await ensureAccess(sess, pid, fid);
  const { key, ctx } = contextFor(sess, pid, fid, table, q);
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

// Cache panel: entries of the user's server (and, for IASO/CommCare, of the user), for projects the
// account can see
async function cacheEntries(sess) {
  const scope = cacheScope(sess), fscope = scopeOf(sess);
  const allowed = new Set((await api.projects(sess)).map(p => String(p.id)));
  return [...dataCache.index.values()]
    .filter(m => m.server === scope && allowed.has(String(m.pid)))
    .map(m => ({
      key: m.key, projectId: m.pid, formId: m.fid, formName: formNames.get(`${fscope}|${m.pid}|${m.fid}`) || m.fid,
      table: m.table, params: m.params || {}, rows: m.rows, bytes: m.bytes, rawBytes: m.rawBytes,
      at: m.at, dataAt: m.dataAt, fullAt: m.fullAt, hits: m.hits || 0, checks: m.checks || 0, mode: m.mode,
      fetchMs: m.fetchMs, last: m.last, lastAccess: m.lastAccess, refreshing: dataCache.inflight.has(m.key),
    }))
    .sort((a, b) => (b.lastAccess || 0) - (a.lastAccess || 0));
}

// ---------------------------------------------------------------- data source API (dispatched to the connector)
const api = {
  projects: sess => connectorOf(sess).projects(sess),
  async forms(sess, pid) {
    const list = await connectorOf(sess).forms(sess, pid);
    for (const f of list) formNames.set(`${scopeOf(sess)}|${pid}|${f.id}`, f.name);
    return list;
  },
  tables: (sess, pid, fid) => connectorOf(sess).tables(sess, pid, fid),
  fields: (sess, pid, fid) => connectorOf(sess).fields(sess, pid, fid),
  labels: (sess, pid, fid) => connectorOf(sess).labels(sess, pid, fid),
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

// Field transformations (derived fields, display formats), shared per form on the same server
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
  let sess = null;
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
      const platforms = PLATFORMS.map(id => ({ id, label: CONNECTORS[id].label, ...SERVERS[id], presets: PRESETS[id] || [] }));
      // defaultServer / lockServer: ODK values, for older frontends
      return send(res, 200, { platforms, defaultServer: SERVERS.odk?.defaultServer || '', lockServer: !!SERVERS.odk?.lockServer, allowedServers: ALLOWED_SERVERS, allowDemo: ALLOW_DEMO });
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
      console.log(`login ${s.email} @ ${s.platform} ${s.server}`);
      return send(res, 200, me(s));
    }
    sess = getSession(req);
    if (p === '/api/logout' && req.method === 'POST') {
      await logout(sess); setSessionCookie(req, res, null);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/me') {
      if (!sess) return send(res, 401, { error: 'Non connecté', relogin: true });
      return send(res, 200, me(sess));
    }

    // ---------- everything below requires a session
    if (!sess) return send(res, 401, { error: 'Veuillez vous connecter.', relogin: true });

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
        settings: { freshMinutes: CACHE_MINUTES, maxStaleHours: CACHE_MAX_STALE_HOURS, fullRefreshHours: CACHE_FULL_REFRESH_HOURS, incremental: sess.demo || connectorOf(sess).incremental(cacheScope(sess)), perUser: !sess.demo && connectorOf(sess).sharedCache === false, platform: connectorOf(sess).label },
        totals: dataCache.totals(), entries: await cacheEntries(sess),
      });
    }
    if (p === '/api/cache' && req.method === 'DELETE') {
      const keys = new Set((await cacheEntries(sess)).filter(e => !e.refreshing).map(e => e.key));
      return send(res, 200, { deleted: dataCache.clear(x => keys.has(x.key)) });
    }
    if ((m = p.match(/^\/api\/cache\/([0-9a-f]{32})(\/refresh)?$/))) {
      const meta = dataCache.meta(m[1]);
      if (!meta || meta.server !== cacheScope(sess)) return send(res, 404, { error: 'Entrée de cache introuvable' });
      await ensureAccess(sess, meta.pid, meta.fid);
      if (m[2] && req.method === 'POST') {
        const body = await readBody(req);
        const C = connectorOf(sess);
        const ctx = { C, src: C.source(sess, meta.pid, meta.fid, meta.params || {}), table: meta.table, filter: meta.filter, server: meta.server, pid: meta.pid, fid: meta.fid, params: meta.params || {} };
        await refreshEntry(m[1], ctx, body.full ? 'full' : 'auto');
        return send(res, 200, (await cacheEntries(sess)).find(e => e.key === m[1]) || {});
      }
      if (!m[2] && req.method === 'DELETE') { dataCache.delete(m[1]); return send(res, 200, { ok: true }); }
    }

    // Saved visualizations: visible to everyone connected to the same server, editable by their owner.
    if (p === '/api/visualizations') {
      if (req.method === 'GET') {
        // only list visualizations whose project this account can access
        const allowed = new Set((await api.projects(sess)).map(p => String(p.id)));
        return send(res, 200, readFavs().filter(v => favServer(v) === scopeOf(sess) && (!v.projectId || allowed.has(String(v.projectId))))
          .map(({ id, name, type, updatedAt, owner, ownerName }) => ({ id, name, type, updatedAt, owner, ownerName, mine: owner === sess.email })));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const list = readFavs();
        const item = { ...body, id: crypto.randomUUID(), server: scopeOf(sess), owner: sess.email, ownerName: sess.name, updatedAt: new Date().toISOString() };
        list.push(item); writeFavs(list);
        return send(res, 201, item);
      }
    }
    if ((m = p.match(/^\/api\/visualizations\/([\w-]+)$/))) {
      const list = readFavs();
      const i = list.findIndex(v => v.id === m[1] && favServer(v) === scopeOf(sess));
      if (i < 0) return send(res, 404, { error: 'Visualisation introuvable sur ce serveur.' });
      if (req.method === 'GET') return send(res, 200, { ...list[i], mine: list[i].owner === sess.email });
      if (list[i].owner && list[i].owner !== sess.email) return send(res, 403, { error: 'Seul son auteur peut modifier ou supprimer cette visualisation. Utilisez « Enregistrer sous ».' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        list[i] = { ...body, id: m[1], server: scopeOf(sess), owner: sess.email, ownerName: sess.name, updatedAt: new Date().toISOString() };
        writeFavs(list); return send(res, 200, list[i]);
      }
      if (req.method === 'DELETE') { list.splice(i, 1); writeFavs(list); return send(res, 200, { ok: true }); }
    }
    send(res, 404, { error: 'Endpoint inconnu' });
  } catch (err) {
    if (!err.status || err.status >= 500) console.error(err.message);
    if (err.relogin && sess) sessions.delete(sess.sid); // the platform refused the token: sign in again
    send(res, err.status && err.status < 600 ? err.status : 500, { error: err.message, relogin: !!err.relogin });
  }
});

// never let a stray promise take the whole server down
process.on('unhandledRejection', e => console.error('Erreur non gérée :', e && e.message ? e.message : e));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));

server.listen(PORT, () => {
  console.log(`ODK Visualizer running on http://localhost:${PORT}`);
  console.log(`Plateformes : ${PLATFORMS.map(p => CONNECTORS[p].label + (SERVERS[p].lockServer ? ` (limitée à ${SERVERS[p].defaultServer})` : '')).join(', ')}`);
  const t = dataCache.totals();
  console.log(`Cache: ${CACHE_PERSIST ? `disque (${t.entries} entrées, ${(t.diskBytes / 1048576).toFixed(1)} Mo)` : 'mémoire seulement'}, frais ${CACHE_MINUTES} min, max ${CACHE_MEMORY_MB} Mo en mémoire`);
});
