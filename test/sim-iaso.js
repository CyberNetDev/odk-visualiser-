// IASO API simulator, written from the IASO source code (github.com/BLSQ/iaso) to test the connector
// without a real server. Usage: node test/sim-iaso.js [port]   (default 4610; the "S3" file host is port+1)
//
// Accounts: admin / admin123 (everything), agent / agent123 (restricted to the "Borgou" département),
//           lecteur / lecteur123 (no "submissions" permission → 403 on /api/instances/)
// Simulator controls (no auth): POST /sim/add?form=11&n=5, /sim/edit?id=, /sim/delete?id=, /sim/throttle,
//                               GET /sim/stats (instances served since last call)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.argv[2] || 4610);
const FILES_PORT = PORT + 1;
const FIX = path.join(__dirname, 'fixtures');
const XML = { 11: fs.readFileSync(path.join(FIX, 'menage.xml'), 'utf8'), 12: fs.readFileSync(path.join(FIX, 'supervision.xml'), 'utf8') };
const DESCRIPTOR = { 101: JSON.parse(fs.readFileSync(path.join(FIX, 'menage.descriptor.json'), 'utf8')), 102: JSON.parse(fs.readFileSync(path.join(FIX, 'supervision.descriptor.json'), 'utf8')) };

// ------------------------------------------------------------------ deterministic data
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = a => a[Math.floor(rnd() * a.length)];

const TYPES = [
  { id: 1, name: 'Pays', short_name: 'Pays', depth: 0 },
  { id: 2, name: 'Département', short_name: 'Département', depth: 1 },
  { id: 3, name: 'Zone sanitaire', short_name: 'Zone sanitaire', depth: 2 },
  { id: 4, name: 'Formation sanitaire', short_name: 'FOSA', depth: 3 },
];
const OU = new Map();
let ouId = 1000;
const addOU = (name, type, parent, lat, lon) => { const o = { id: ouId++, name, type, parent_id: parent ? parent.id : null, lat, lon }; OU.set(o.id, o); return o; };
const benin = addOU('Bénin', 1, null, 9.3, 2.3);
const DEPTS = {};
for (const [d, zones] of Object.entries({ Borgou: ['Parakou-N\'Dali', 'Tchaourou'], Atlantique: ['Allada', 'Ouidah'], Zou: ['Abomey', 'Bohicon'] })) {
  const dep = DEPTS[d] = addOU(d, 2, benin, 7 + rnd() * 3, 1.8 + rnd());
  for (const z of zones) {
    const zone = addOU(z, 3, dep, dep.lat + rnd() - 0.5, dep.lon + rnd() - 0.5);
    for (let k = 1; k <= 3; k++) addOU(`CS ${z} ${k}`, 4, zone, zone.lat + (rnd() - 0.5) / 5, zone.lon + (rnd() - 0.5) / 5);
  }
}
const FOSAS = [...OU.values()].filter(o => o.type === 4);
const ancestors = o => { const out = []; for (let n = o; n; n = OU.get(n.parent_id)) out.unshift(n); return out; };
const under = (o, root) => ancestors(o).some(a => a.id === root.id);

const USERS = {
  admin: { pw: 'admin123', first_name: 'Awa', last_name: 'Diallo', id: 1, perms: true, root: null },
  agent: { pw: 'agent123', first_name: 'Koffi', last_name: 'Mensah', id: 2, perms: true, root: DEPTS.Borgou },
  lecteur: { pw: 'lecteur123', first_name: '', last_name: '', id: 3, perms: false, root: null },
};
const SUBMITTERS = [USERS.admin, USERS.agent, { id: 4, username: 'enq3', first_name: 'Ibrahim', last_name: 'Sanni' }];

const NOW = Date.UTC(2026, 9, 31, 12);
const instances = [];
let instId = 5000;
const PRENOMS = ['Aïcha', 'Moussa', 'Fatou', 'Jean', 'Mariam', 'Paul', 'Rachidatou', 'Serge', 'Nafissatou', 'Yao'];

function recordMenage(created) {
  const nb = 1 + Math.floor(rnd() * 5);
  const membres = Array.from({ length: nb }, () => ({
    prenom: pick(PRENOMS), age: String(Math.floor(rnd() * 70)), sexe: pick(['f', 'm']),
    vaccins: Array.from({ length: Math.floor(rnd() * 3) }, () => ({ antigene: pick(['bcg', 'penta', 'rr']) })),
  }));
  const fosa = pick(FOSAS);
  return {
    fosa,
    tree: {
      debut: new Date(created - 1200e3).toISOString(), fin: new Date(created).toISOString(),
      date_visite: new Date(created).toISOString().slice(0, 10),
      menage: {
        chef: pick(PRENOMS) + ' ' + pick(['Diallo', 'Hounkpè', 'Adjovi', 'Bio']), taille: String(nb), milieu: pick(['urbain', 'rural']),
        biens: ['radio', 'tele', 'moto', 'velo'].filter(() => rnd() < 0.4).join(' '),
        revenu: String(Math.round(rnd() * 150000) / 1), gps: rnd() < 0.9 ? `${(fosa.lat + (rnd() - 0.5) / 20).toFixed(6)} ${(fosa.lon + (rnd() - 0.5) / 20).toFixed(6)} 120 5` : '',
      },
      membres,
      nb_enfants: String(membres.filter(m => +m.age < 5).length), merci: '',
      meta: { instanceID: 'uuid:' + crypto.randomUUID() },
    },
  };
}
function recordSupervision(created) {
  return { fosa: pick(FOSAS), tree: { jour: new Date(created).toISOString().slice(0, 10), eau: pick(['oui', 'non']), lits: String(Math.floor(rnd() * 40)), remarques: rnd() < 0.3 ? 'RAS' : '', meta: { instanceID: 'uuid:' + crypto.randomUUID() } } };
}
function addInstance(form, created) {
  const r = form === 11 ? recordMenage(created) : recordSupervision(created);
  const by = rnd() < 0.03 ? null : pick(SUBMITTERS);
  const inst = {
    id: instId++, uuid: r.tree.meta.instanceID.slice(5), form_id: form, tree: r.tree,
    org_unit: rnd() < 0.02 ? null : r.fosa,
    created_at: created + 3600e3 * rnd(), source_created_at: rnd() < 0.1 ? null : created, updated_at: created + 3600e3,
    period: form === 12 ? new Date(created).toISOString().slice(0, 7).replace('-', '') : null,
    status: pick(['READY', 'READY', 'READY', 'EXPORTED', 'DUPLICATED']),
    validation_status: pick([null, 'APPROVED', 'APPROVED', 'PENDING', 'REJECTED']),
    created_by: by && { username: by.username || Object.keys(USERS).find(k => USERS[k] === by), first_name: by.first_name, last_name: by.last_name },
    location: rnd() < 0.7 ? { lat: r.fosa.lat + (rnd() - 0.5) / 30, lon: r.fosa.lon + (rnd() - 0.5) / 30, alt: 100 } : null,
    deleted: false, version: form === 11 ? '2026010101' : '3',
  };
  instances.push(inst);
  return inst;
}
for (let i = 0; i < 1200; i++) addInstance(11, NOW - Math.floor(rnd() * 300) * 86400e3);
for (let i = 0; i < 150; i++) addInstance(12, NOW - Math.floor(rnd() * 200) * 86400e3);

// IASO's flat_parse_xml_soup: leaf names as keys, groups dropped, first-level repeats as lists, deeper repeats
// flattened (repeat_groups only lists the repeats found outside repeats); every value is the element text.
const REPEAT_GROUPS = { 11: ['membres'], 12: [] };
function flatten(node, repeatGroups, out = {}) {
  for (const [k, v] of Object.entries(node)) {
    if (repeatGroups.includes(k) && Array.isArray(v)) { out[k] = v.map(item => flatten(item, repeatGroups, {})); continue; }
    if (Array.isArray(v)) { for (const item of v) flatten(item, repeatGroups, out); continue; }
    if (v && typeof v === 'object') { flatten(v, repeatGroups, out); continue; }
    out[k] = v == null ? '' : String(v);
  }
  return out;
}

const ts = ms => (ms == null ? null : ms / 1000);
function asDict(i) {
  const fc = flatten(i.tree, REPEAT_GROUPS[i.form_id]);
  fc._version = i.version;
  const ou = i.org_unit;
  return {
    uuid: i.uuid, export_id: null, file_name: `${i.uuid}.xml`, file_content: fc, file_url: `http://localhost:${PORT}/media/instances/${i.uuid}.xml`,
    id: i.id, form_id: i.form_id, form_name: i.form_id === 11 ? 'Enquête ménage' : 'Supervision FOSA',
    created_at: ts(i.created_at), updated_at: ts(i.updated_at), source_created_at: ts(i.source_created_at), source_updated_at: null,
    org_unit: ou ? {
      name: ou.name, short_name: ou.name, id: ou.id, source: 'Pyramide', source_id: 1, source_ref: null, parent_id: ou.parent_id,
      org_unit_type_id: ou.type, org_unit_type_name: TYPES[ou.type - 1].name, org_unit_type_depth: TYPES[ou.type - 1].depth,
      created_at: 1700000000, updated_at: 1700000000, aliases: null, validation_status: 'VALID',
      latitude: ou.lat, longitude: ou.lon, altitude: 0, has_geo_json: false, version: 1, opening_date: null, closed_date: null,
    } : null,
    latitude: i.location ? i.location.lat : null, longitude: i.location ? i.location.lon : null, altitude: i.location ? i.location.alt : null,
    period: i.period, project_name: 'Santé communautaire', project_color: '#1f77b4', project_id: 1,
    status: i.status, validation_status: i.validation_status, workflow: null, correlation_id: null,
    created_by: i.created_by, last_modified_by: null,
  };
}
function smallOU(o) {
  return { id: o.id, name: o.name, parent_id: o.parent_id, validation_status: 'VALID', parent_name: o.parent_id ? OU.get(o.parent_id).name : null,
    source: 'Pyramide', source_ref: null, org_unit_type_name: TYPES[o.type - 1].name, search_index: 0, parent: o.parent_id ? smallOU(OU.get(o.parent_id)) : null, creator: null };
}

// ------------------------------------------------------------------ HTTP
const tokens = new Map(); // access token → username
let served = 0, throttle = false;
const day = s => { if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw Object.assign(new Error(`Parameter must be a valid ISO date (yyyy-MM-dd), received '${s}'`), { status: 400 }); return Date.parse(s + 'T00:00:00Z'); };

function jwt(username) {
  const b = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ token_type: 'access', exp: Math.floor(Date.now() / 1000) + 3650 * 86400, user_id: USERS[username].id, jti: crypto.randomUUID() })}.${crypto.randomBytes(16).toString('base64url')}`;
  tokens.set(t, username);
  return t;
}

const FORMS = [
  { id: 11, name: 'Enquête ménage', form_id: 'enquete_menage', version: { id: 101, version_id: '2026010101', file: `http://localhost:${FILES_PORT}/iaso-media/forms/enquete_menage_2026010101.xml?X-Amz-Signature=abc`, xls_file: null } },
  { id: 12, name: 'Supervision FOSA', form_id: 'supervision', version: { id: 102, version_id: '3', file: `/media/forms/supervision_3.xml`, xls_file: null } },
];
const POSSIBLE = {
  11: [{ name: 'date_visite', label: 'Date de la visite', type: 'date' }, { name: 'chef', label: 'Nom du chef de ménage', type: 'text' }, { name: 'ancienne_question', label: 'Question retirée (version 1)', type: 'integer' }],
  12: [{ name: 'jour', label: 'Jour de la supervision', type: 'date' }],
};

function visibleInstances(user) {
  return instances.filter(i => !user.root || (i.org_unit && under(i.org_unit, user.root)));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const q = u.searchParams;
  const json = (o, c = 200, h = {}) => { res.writeHead(c, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  let body = '';
  for await (const c of req) body += c;
  try {
    // --- simulator controls
    if (p === '/sim/stats') { const s = served; served = 0; return json({ served: s, instances: instances.length }); }
    if (p === '/sim/throttle') { throttle = true; return json({ ok: true }); }
    if (p === '/sim/add') { const form = Number(q.get('form') || 11); const out = []; for (let k = 0; k < Number(q.get('n') || 1); k++) out.push(addInstance(form, Date.now()).id); return json({ added: out }); }
    if (p === '/sim/edit') { const i = instances.find(x => x.id === Number(q.get('id'))); i.tree.menage ? (i.tree.menage.chef = 'MODIFIÉ ' + i.id) : (i.tree.remarques = 'MODIFIÉ'); if (i.tree.membres) i.tree.membres.push({ prenom: 'Nouveau', age: '1', sexe: 'f', vaccins: [] }); i.updated_at = Date.now(); return json({ ok: true }); }
    if (p === '/sim/delete') { const i = instances.find(x => x.id === Number(q.get('id'))); i.deleted = true; i.updated_at = Date.now(); return json({ ok: true }); }

    if (p === '/api/token/' && req.method === 'POST') {
      let b; try { b = JSON.parse(body); } catch { return json({ detail: 'JSON parse error' }, 400); }
      const us = USERS[b.username];
      if (!us || us.pw !== b.password) return json({ detail: 'No active account found with the given credentials' }, 401);
      return json({ refresh: crypto.randomBytes(20).toString('hex'), access: jwt(b.username) });
    }
    if (p.startsWith('/media/forms/')) return json({ detail: 'Authentication credentials were not provided.' }, 403); // private media
    const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
    const username = tokens.get(auth);
    if (!username) return json({ detail: 'Given token not valid for any token type', code: 'token_not_valid' }, 401);
    const user = USERS[username];
    if (throttle) { throttle = false; return json({ detail: 'Request was throttled.' }, 429, { 'Retry-After': '1' }); }

    if (p === '/api/profiles/me/') return json({ id: user.id, first_name: user.first_name, user_name: username, last_name: user.last_name, email: `${username}@iaso.test`, language: 'fr' });
    if (p === '/api/projects/') return json({ projects: [{ id: 1, name: 'Santé communautaire', app_id: 'org.sante.communautaire', forms: [11, 12] }] });
    if (p === '/api/forms/') {
      if (q.get('projectsIds') && q.get('projectsIds') !== '1') return json({ forms: [] });
      return json({ forms: FORMS.map(f => ({ id: f.id, name: f.name, form_id: f.form_id, instances_count: instances.filter(i => i.form_id === f.id && !i.deleted).length, projects: [{ id: 1, name: 'Santé communautaire' }] })) });
    }
    let m;
    if ((m = p.match(/^\/api\/forms\/(\d+)\/$/))) {
      const f = FORMS.find(x => x.id === Number(m[1]));
      if (!f) return json({ detail: 'Not found.' }, 404);
      return json({ id: f.id, name: f.name, form_id: f.form_id, latest_form_version: f.version, possible_fields: POSSIBLE[f.id], org_unit_types: [TYPES[3]], period_type: f.id === 12 ? 'MONTH' : null, projects: [{ id: 1 }] });
    }
    if ((m = p.match(/^\/api\/formversions\/(\d+)\/$/))) {
      const d = DESCRIPTOR[m[1]];
      if (!d) return json({ detail: 'Not found.' }, 404);
      return json(q.get('fields') === 'descriptor' ? { descriptor: d } : { id: Number(m[1]), descriptor: d });
    }
    if (p === '/api/v2/orgunittypes/') return json({ orgUnitTypes: q.get('project') === '1' ? TYPES.map(t => ({ ...t, projects: [{ id: 1 }], sub_unit_types: [] })) : [] });
    if (p === '/api/orgunits/') {
      const searches = JSON.parse(q.get('searches') || '[]');
      const ids = new Set();
      for (const s of searches) for (const x of String(s.search || '').replace(/^ids:/, '').split(',')) if (x) ids.add(Number(x));
      const list = [...ids].map(id => OU.get(id)).filter(Boolean).filter(o => !user.root || under(o, user.root) || ancestors(user.root).some(a => a.id === o.id));
      const limit = Number(q.get('limit') || 0);
      if (!limit) return json({ orgUnits: list.map(smallOU) });
      return json({ count: list.length, counts: [], orgunits: list.slice(0, limit).map(smallOU), has_next: list.length > limit, has_previous: false, page: 1, pages: Math.max(1, Math.ceil(list.length / limit)), limit });
    }
    if (p === '/api/instances/') {
      if (!user.perms) return json({ detail: 'You do not have permission to perform this action.' }, 403);
      let list = visibleInstances(user);
      const formIds = (q.get('form_ids') || q.get('form_id') || '').split(',').filter(Boolean).map(Number);
      if (formIds.length) list = list.filter(i => formIds.includes(i.form_id));
      list = q.get('showDeleted') === 'true' ? list.filter(i => i.deleted) : list.filter(i => !i.deleted);
      const created = i => i.source_created_at ?? i.created_at;
      if (q.get('dateFrom')) { const t = day(q.get('dateFrom')); list = list.filter(i => created(i) >= t); }
      if (q.get('dateTo')) { const t = day(q.get('dateTo')) + 86400e3 - 1; list = list.filter(i => created(i) <= t); }
      if (q.get('modificationDateFrom')) { const t = day(q.get('modificationDateFrom')); list = list.filter(i => i.updated_at >= t); }
      const order = (q.get('order') || 'updated_at').split(',')[0];
      const desc = order.startsWith('-'), key = order.replace(/^-/, '');
      list = [...list].sort((a, b) => ((a[key] ?? 0) - (b[key] ?? 0)) * (desc ? -1 : 1) || (a.id - b.id));
      const limit = Number(q.get('limit') || 0);
      const fields = q.get('fields') ? new Set(q.get('fields').split(',')) : null;
      const shape = i => { const d = asDict(i); return fields ? Object.fromEntries(Object.entries(d).filter(([k]) => fields.has(k))) : d; };
      if (!limit) return json({ instances: list.slice(0, 50).map(shape) }); // small dict branch (not used)
      const pages = Math.max(1, Math.ceil(list.length / limit));
      let page = Number(q.get('page') || 1);
      if (page > pages) page = pages; // IASO clamps to the last page
      const slice = list.slice((page - 1) * limit, page * limit);
      if (fields === null || fields.has('file_content')) served += slice.length;
      return json({ count: list.length, instances: slice.map(shape), has_next: page < pages, has_previous: page > 1, page, pages, limit });
    }
    json({ detail: 'Not found.' }, 404);
  } catch (e) { json({ detail: e.message }, e.status || 500); }
});
server.listen(PORT, () => console.log(`IASO simulé sur http://localhost:${PORT} (fichiers sur ${FILES_PORT})`));

// "S3" host for form files: signed URL, refuses an Authorization header like S3 does
http.createServer((req, res) => {
  if (req.headers.authorization) { res.writeHead(400, { 'Content-Type': 'application/xml' }); return res.end('<Error><Code>InvalidArgument</Code><Message>Only one auth mechanism allowed</Message></Error>'); }
  if (req.url.startsWith('/iaso-media/forms/enquete_menage')) { res.writeHead(200, { 'Content-Type': 'application/xml' }); return res.end(XML[11]); }
  res.writeHead(404); res.end();
}).listen(FILES_PORT);
