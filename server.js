// ODK Visualizer — zero-dependency Node (>=18) server.
// - Each user signs in from the app with THEIR OWN ODK Central account (server URL + e-mail + password).
//   The password is sent once to Central and never stored; the server keeps only Central's session
//   token in memory, linked to an HttpOnly cookie. Users see only the projects their account can see.
// - Proxies the Central API / OData feed (avoids CORS), pages through results, caches them per user.
// - Stores saved visualizations per ODK server in data/visualizations.json.
// - Serves the frontend from /public.
// Every setting is optional (see .env.example): nothing is required to start the app.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const demo = require('./demo-data');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const CACHE_MINUTES = Number(process.env.CACHE_MINUTES || 5);
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

// ---------------------------------------------------------------- cache (per server + user, since permissions differ)
const cache = new Map();
async function cached(key, fn, force) {
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MINUTES * 60_000) return hit;
  const value = await fn();
  const entry = { at: Date.now(), value };
  cache.set(key, entry);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return entry;
}

// ---------------------------------------------------------------- data source API
const api = {
  async projects(sess) {
    if (sess.demo) return demo.projects();
    const list = await central(sess, '/v1/projects');
    return list.filter(p => !p.archived).map(p => ({ id: p.id, name: p.name }));
  },

  async forms(sess, pid) {
    if (sess.demo) return demo.forms(pid);
    const list = await central(sess, `/v1/projects/${enc(pid)}/forms`);
    return list.map(f => ({ id: f.xmlFormId, name: f.name || f.xmlFormId, submissions: f.submissions, state: f.state }));
  },

  // Tables in the OData service: "Submissions" plus one per repeat group.
  async tables(sess, pid, fid) {
    if (sess.demo) return demo.tables(fid);
    const xml = await central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}.svc/$metadata`, { raw: true });
    const names = [...xml.matchAll(/<EntitySet\s+Name="([^"]+)"/g)].map(m => m[1]);
    return names.length ? names : ['Submissions'];
  },

  async fields(sess, pid, fid) {
    if (sess.demo) return demo.fields(fid);
    const list = await central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}/fields?odata=true`);
    return list
      .filter(f => f.type !== 'structure')
      .map(f => ({ path: f.path.replace(/^\//, ''), name: f.name, type: f.type, selectMultiple: !!f.selectMultiple, repeat: f.type === 'repeat' }));
  },

  async data(sess, pid, fid, q) {
    const table = q.table || 'Submissions';
    if (!/^[\w.\-]+$/.test(table)) throw httpError(400, 'Nom de table invalide');
    if (sess.demo) return demo.data(fid, table, q);
    const filters = [];
    if (q.from) filters.push(`__system/submissionDate ge ${new Date(q.from).toISOString()}`);
    if (q.to) filters.push(`__system/submissionDate lt ${new Date(new Date(q.to).getTime() + 86400000).toISOString()}`);
    if (q.reviewState) {
      const states = q.reviewState.split(',').filter(s => /^(null|received|hasIssues|edited|approved|rejected)$/.test(s));
      if (states.length) filters.push('(' + states.map(s => s === 'null' || s === 'received' ? '__system/reviewState eq null' : `__system/reviewState eq '${s}'`).join(' or ') + ')');
    }
    const query = {};
    if (filters.length && table === 'Submissions') query.$filter = filters.join(' and ');
    const key = `${sess.server}|${sess.email}|${pid}|${fid}|${table}|${query.$filter || ''}`;
    const hit = await cached(key, () => fetchAllOData(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}.svc/${table}`, query), q.refresh === '1');
    return { rows: hit.value, fetchedAt: hit.at };
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

// ---------------------------------------------------------------- http plumbing
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
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
    if ((m = p.match(/^\/api\/projects\/([^/]+)\/forms\/([^/]+)\/data$/))) return send(res, 200, await api.data(sess, m[1], decodeURIComponent(m[2]), q));

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

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));

server.listen(PORT, () => {
  console.log(`ODK Visualizer running on http://localhost:${PORT}`);
  console.log(LOCK_SERVER ? `Login limited to ${DEFAULT_SERVER}` : 'Users sign in to their ODK Central server from the app');
});
