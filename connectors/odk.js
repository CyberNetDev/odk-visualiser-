// ODK Central connector: REST API (/v1) + OData feed of each form.
// Also serves the demo dataset (same shape as ODK Central).

const demo = require('../demo-data');
const { extractLabels, csvChoices } = require('../xform');
const { httpError, fetchWithTimeout, normalizeServer, memoize, enc } = require('./common');

const PAGE_SIZE = Number(process.env.PAGE_SIZE || 1000);
const META_MS = Number(process.env.CACHE_MINUTES || 5) * 60_000;

const SYSTEM_FIELDS = [
  { path: '__system/submissionDate', name: 'Date de soumission', type: 'dateTime', system: true },
  { path: '__system/submitterName', name: 'Enquêteur', type: 'string', system: true },
  { path: '__system/reviewState', name: 'État de revue', type: 'string', system: true },
  { path: '__system/deviceId', name: 'Appareil', type: 'string', system: true },
  { path: '__system/formVersion', name: 'Version du formulaire', type: 'string', system: true },
];

const noDelta = new Set(); // servers that refused incremental queries (Central < 1.3)

async function central(sess, target, { raw = false } = {}) {
  const url = target.startsWith('http') ? target : `${sess.server}${target}`;
  if (!url.startsWith(sess.server + '/')) throw httpError(400, 'Requête hors du serveur ODK connecté refusée.');
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${sess.token}` } }, 120_000);
  } catch (e) {
    throw httpError(502, `Serveur ODK injoignable (${e.cause?.code || e.message}).`);
  }
  if (res.status === 401) { const err = httpError(401, 'Session ODK expirée, reconnectez-vous.'); err.relogin = true; throw err; }
  if (res.status === 403) throw httpError(403, 'Votre compte ODK n\'a pas accès à cette ressource.');
  if (!res.ok) {
    const body = await res.text();
    throw httpError(res.status, `ODK Central ${res.status} : ${body.slice(0, 300)}`);
  }
  return raw ? res.text() : res.json();
}

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

const userKey = sess => `odk|${sess.server}|${sess.email}`;

module.exports = {
  id: 'odk',
  label: 'ODK Central',
  features: { reviewState: true },
  normalizeServer: s => normalizeServer(s, /\/v1$/),

  async login({ server, email, password }) {
    email = String(email || '').trim();
    if (!email || !password) throw httpError(400, 'E-mail et mot de passe obligatoires.');
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
    if (!res.ok || !ct.includes('json')) throw httpError(502, `Ce serveur ne répond pas comme ODK Central (HTTP ${res.status}). Vérifiez l'adresse et la plateforme choisie.`);
    const s = await res.json();
    if (!s.token) throw httpError(502, 'Réponse inattendue du serveur ODK Central.');
    let name = email;
    try {
      const me = await fetchWithTimeout(`${server}/v1/users/current`, { headers: { Authorization: `Bearer ${s.token}` } }, 10_000);
      if (me.ok) name = (await me.json()).displayName || email;
    } catch { /* optional */ }
    return { email, name, token: s.token, expiresAt: s.expiresAt };
  },

  async logout(sess) {
    if (sess.token) fetchWithTimeout(`${sess.server}/v1/sessions/${sess.token}`, { method: 'DELETE', headers: { Authorization: `Bearer ${sess.token}` } }, 5000).catch(() => {});
  },

  // A user may read a cached form only if their own ODK account can open it (re-checked every 2 minutes)
  async access(sess, pid, fid) {
    if (sess.demo) return;
    await memoize(`${userKey(sess)}|access|${pid}|${fid}`, () => central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}`), 120_000);
  },

  async projects(sess) {
    if (sess.demo) return demo.projects();
    const list = await central(sess, '/v1/projects');
    return list.filter(p => !p.archived).map(p => ({ id: p.id, name: p.name }));
  },

  async forms(sess, pid) {
    if (sess.demo) return demo.forms(pid);
    return (await central(sess, `/v1/projects/${enc(pid)}/forms`)).map(f => ({ id: f.xmlFormId, name: f.name || f.xmlFormId, submissions: f.submissions, state: f.state }));
  },

  // Tables in the OData service: "Submissions" plus one per repeat group.
  async tables(sess, pid, fid) {
    if (sess.demo) return demo.tables(fid);
    const xml = await memoize(`${userKey(sess)}|meta|${pid}|${fid}`, () => central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}.svc/$metadata`, { raw: true }), META_MS);
    const names = [...xml.matchAll(/<EntitySet\s+Name="([^"]+)"/g)].map(m => m[1]);
    return names.length ? names : ['Submissions'];
  },

  async fields(sess, pid, fid) {
    const list = sess.demo ? demo.fields(fid)
      : await memoize(`${userKey(sess)}|fields|${pid}|${fid}`, () => central(sess, `/v1/projects/${enc(pid)}/forms/${enc(fid)}/fields?odata=true`), META_MS);
    return [
      ...list.filter(f => f.type !== 'structure')
        .map(f => ({ path: f.path.replace(/^\//, ''), name: f.name, type: f.type, selectMultiple: !!f.selectMultiple, repeat: f.type === 'repeat' })),
      ...SYSTEM_FIELDS,
    ];
  },

  // Question & choice labels from the XForm (+ CSV attachments for select_one_from_file / entity lists)
  async labels(sess, pid, fid) {
    return memoize(`${sess.demo ? 'demo' : userKey(sess)}|labels|${pid}|${fid}`, async () => {
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
    }, META_MS);
  },

  // OData $filter for the date range and review state. On sub-tables (repeats) Central filters through
  // the parent submission: $root/Submissions/__system/...
  filterKey(table, q) {
    const sys = table === 'Submissions' ? '__system' : '$root/Submissions/__system';
    const filters = [];
    if (q.from) filters.push(`${sys}/submissionDate ge ${new Date(q.from).toISOString()}`);
    if (q.to) filters.push(`${sys}/submissionDate lt ${new Date(new Date(q.to).getTime() + 86400000).toISOString()}`);
    if (q.reviewState) {
      const states = q.reviewState.split(',').filter(x => /^(null|received|hasIssues|edited|approved|rejected)$/.test(x));
      if (states.length) filters.push('(' + states.map(x => x === 'null' || x === 'received' ? `${sys}/reviewState eq null` : `${sys}/reviewState eq '${x}'`).join(' or ') + ')');
    }
    return filters.join(' and ');
  },

  incremental: scope => !noDelta.has(scope),
  refuseIncremental: scope => noDelta.add(scope),

  // Where the rows come from: ODK Central (OData) or the demo dataset
  source(sess, pid, fid, params) {
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
      // only the main table can be updated incrementally (sub-tables: full reload)
      delta: async (filter, iso) => ({ rows: await fetchAllOData(sess, `${svc}/Submissions`, { $filter: filter ? `(${filter}) and ${changed(iso)}` : changed(iso) }) }),
      childDelta: false,
    };
  },
};
