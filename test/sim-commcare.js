// CommCare HQ API simulator, written from the CommCare HQ source code (github.com/dimagi/commcare-hq,
// corehq/apps/api) to test the connector without a real server. Usage: node test/sim-commcare.js [port] (4620)
//
// Accounts: enqueteur@demo.org with API key "cle-api-123" (Authorization: ApiKey user:key) or password
//           "motdepasse" (Basic); superviseur@demo.org / key "cle-sup" (no "edit data" permission → 403)
// Simulator controls: POST /sim/add?n=, /sim/edit?id=, /sim/archive?id=, /sim/throttle ; GET /sim/stats

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.argv[2] || 4620);
const DOMAIN = 'demo-nutrition';
const APP_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const XMLNS = 'http://openrosa.org/formdesigner/5B3A1C9E-NUTRI';
const XMLNS2 = 'http://openrosa.org/formdesigner/77AA-ENREG';
const MAX_WINDOW = 10000; // Elasticsearch max_result_window: offset + limit beyond this is refused

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = a => a[Math.floor(rnd() * a.length)];

const USERS = {
  'enqueteur@demo.org': { key: 'cle-api-123', pw: 'motdepasse', first_name: 'Mariama', last_name: 'Bah', id: 'u1', edit: true },
  'superviseur@demo.org': { key: 'cle-sup', pw: 'sup', first_name: 'Ousmane', last_name: 'Kane', id: 'u2', edit: false },
};
const MOBILE = ['aminata', 'boubacar', 'coumba', 'demba'];

// questions as returned by Form.get_questions(langs, include_triggers, include_groups, include_translations)
const q = (value, type, tag, fr, en, extra = {}) => ({ label: fr, label_ref: `${value.split('/').pop()}-label`, tag, value, repeat: null, group: null, type,
  relevant: null, required: false, constraint: null, comment: null, hashtagValue: value.replace('/data/', '#form/'), setvalue: null, is_group: type === 'Group' || type === 'Repeat' || type === 'FieldList',
  translations: en === undefined ? {} : { fr, en }, ...extra });
const opt = (value, fr, en) => ({ label: fr, label_ref: `${value}-label`, value, translations: { fr, en } });
const QUESTIONS = [
  q('/data/info', 'Trigger', 'trigger', 'Bienvenue', 'Welcome'),
  q('/data/date_visite', 'Date', 'input', 'Date de la visite', 'Visit date'),
  q('/data/nom_mere', 'Text', 'input', 'Nom de la mère', "Mother's name"),
  q('/data/age_mere', 'Int', 'input', 'Âge de la mère', "Mother's age"),
  q('/data/village', 'Select', 'select1', 'Village', 'Village', { options: [opt('kanel', 'Kanel', 'Kanel'), opt('matam', 'Matam', 'Matam'), opt('ourossogui', 'Ourossogui', 'Ourossogui')] }),
  q('/data/menage', 'Group', 'group', 'Ménage', 'Household'),
  q('/data/menage/eau', 'Select', 'select1', "Source d'eau", 'Water source', { group: '/data/menage', options: [opt('robinet', 'Robinet', 'Tap'), opt('puits', 'Puits', 'Well'), opt('riviere', 'Rivière', 'River')] }),
  q('/data/menage/equipements', 'MSelect', 'select', 'Équipements', 'Equipment', { group: '/data/menage', options: [opt('moustiquaire', 'Moustiquaire', 'Bed net'), opt('latrine', 'Latrine', 'Latrine'), opt('radio', 'Radio', 'Radio')] }),
  q('/data/enfants', 'Repeat', 'repeat', 'Enfants de moins de 5 ans', 'Children under 5'),
  q('/data/enfants/prenom', 'Text', 'input', 'Prénom', 'First name', { repeat: '/data/enfants', group: '/data/enfants' }),
  q('/data/enfants/age_mois', 'Int', 'input', 'Âge (mois)', 'Age (months)', { repeat: '/data/enfants', group: '/data/enfants' }),
  q('/data/enfants/muac', 'Double', 'input', 'Périmètre brachial (mm)', 'MUAC (mm)', { repeat: '/data/enfants', group: '/data/enfants' }),
  q('/data/enfants/etat', 'Select', 'select1', 'État nutritionnel', 'Nutrition status', { repeat: '/data/enfants', group: '/data/enfants', options: [opt('normal', 'Normal', 'Normal'), opt('mam', 'Malnutrition modérée', 'Moderate'), opt('mas', 'Malnutrition sévère', 'Severe')] }),
  q('/data/gps', 'Geopoint', 'input', 'Position', 'Location'),
  { tag: 'hidden', value: '/data/score', repeat: null, group: null, type: 'DataBindOnly', calculate: "count(/data/enfants[etat='mas'])", relevant: null, constraint: null, comment: null, setvalue: null },
  { tag: 'hidden', value: '/data/case/update/statut', repeat: null, group: null, type: 'DataBindOnly', calculate: null, relevant: null, constraint: null, comment: null, setvalue: null },
];
const QUESTIONS2 = [
  q('/data/nom', 'Text', 'input', 'Nom', 'Name'),
  q('/data/sexe', 'Select', 'select1', 'Sexe', 'Sex', { options: [opt('f', 'Féminin', 'Female'), opt('m', 'Masculin', 'Male')] }),
];
const APPS = [
  { id: APP_ID, name: 'Nutrition communautaire', version: 57, is_released: true, built_on: null, build_comment: null, built_from_app_id: null, versions: [],
    modules: [
      { name: { fr: 'Suivi des ménages', en: 'Household follow-up' }, case_type: 'menage', case_properties: [], unique_id: 'm1',
        forms: [{ xmlns: XMLNS, name: { fr: 'Visite à domicile', en: 'Home visit' }, questions: QUESTIONS, unique_id: 'f0a1b2c3' }] },
      { name: { fr: 'Enregistrement', en: 'Registration' }, case_type: 'menage', case_properties: [], unique_id: 'm2',
        forms: [{ xmlns: XMLNS2, name: { fr: 'Nouveau ménage', en: 'New household' }, questions: QUESTIONS2, unique_id: 'f9e8d7c6' }] },
    ] },
  { id: 'b0000000000000000000000000000002', name: 'Application test (vide)', version: 1, modules: [] },
];

// ------------------------------------------------------------------ forms (ES documents)
const forms = [];
const T0 = Date.UTC(2026, 3, 1);
const iso6 = ms => new Date(ms).toISOString().replace('Z', '') + String(Math.floor(rnd() * 1000)).padStart(3, '0') + 'Z'; // microseconds
let bulkIndexed = null;
function makeForm(received, { bulk = false } = {}) {
  const n = Math.floor(rnd() * 4);
  const enfants = Array.from({ length: n }, () => ({ prenom: pick(['Awa', 'Modou', 'Fatou', 'Ibou', 'Khady']), age_mois: String(Math.floor(rnd() * 59)), muac: String(100 + Math.floor(rnd() * 70)), etat: pick(['normal', 'normal', 'mam', 'mas']) }));
  const user = pick(MOBILE);
  const id = crypto.randomUUID();
  const meta = { '@xmlns': 'http://openrosa.org/jr/xforms', appVersion: 'CommCare Android, version "2.54.1"', deviceID: 'dev-' + user, instanceID: id,
    timeStart: new Date(received - 900e3).toISOString(), timeEnd: new Date(received - 60e3).toISOString(), userID: 'id-' + user, username: user,
    location: rnd() < 0.85 ? { '#text': `${(15.5 + rnd()).toFixed(6)} ${(-13.5 + rnd()).toFixed(6)} 25.0 8.0`, '@xmlns': 'http://commcarehq.org/xforms' } : '' };
  const formData = {
    '#type': 'data', '@name': 'Visite à domicile', '@uiVersion': '1', '@version': '57', '@xmlns': XMLNS,
    info: '', date_visite: new Date(received).toISOString().slice(0, 10), nom_mere: pick(['Aïssatou', 'Rokhaya', 'Binta']) + ' ' + pick(['Sow', 'Diop', 'Ba']),
    age_mere: String(16 + Math.floor(rnd() * 30)), village: pick(['kanel', 'matam', 'ourossogui']),
    menage: { eau: pick(['robinet', 'puits', 'riviere']), equipements: ['moustiquaire', 'latrine', 'radio'].filter(() => rnd() < 0.5).join(' ') },
    // CommCare quirk: a repeat with one entry is an object, not a list
    ...(n ? { enfants: n === 1 ? enfants[0] : enfants } : {}),
    gps: rnd() < 0.8 ? `${(15.5 + rnd()).toFixed(6)} ${(-13.5 + rnd()).toFixed(6)} 30 5` : '',
    score: String(enfants.filter(e => e.etat === 'mas').length),
    case: { '@case_id': crypto.randomUUID(), '@date_modified': new Date(received).toISOString(), '@user_id': 'id-' + user, '@xmlns': 'http://commcarehq.org/case/transaction/v2', update: { statut: 'suivi' } },
    meta,
  };
  const indexed = bulk ? (bulkIndexed ||= iso6(received + 5000)) : iso6(received + 5000);
  const doc = { id, xmlns: XMLNS, app_id: APP_ID, form: formData, metadata: { ...meta, app_build_version: 57, commcare_version: '2.54.1', location: meta.location ? meta.location['#text'] : null },
    received_on: iso6(received), server_modified_on: iso6(received + 1000), indexed_on: indexed, edited_on: null, build_id: 'build57', archived: false,
    type: 'data', version: '57', uiversion: '1', domain: DOMAIN, initial_processing_complete: true, problem: null, attachments: {}, is_phone_submission: true, edited_by_user_id: null, submit_ip: '10.0.0.1' };
  forms.push(doc);
  return doc;
}
// 1500 forms share the same indexed_on (bulk re-index), to exercise the keyset paging
for (let i = 0; i < 11800; i++) makeForm(T0 + i * 1000 * 60 * 17, { bulk: i >= 2000 && i < 3500 });
for (let i = 0; i < 40; i++) {
  const id = crypto.randomUUID();
  forms.push({ id, xmlns: XMLNS2, app_id: APP_ID, form: { '@xmlns': XMLNS2, nom: 'X' + i, sexe: pick(['f', 'm']), meta: { username: 'aminata', instanceID: id } }, metadata: { username: 'aminata' },
    received_on: iso6(T0 + i * 86400e3), server_modified_on: iso6(T0 + i * 86400e3), indexed_on: iso6(T0 + i * 86400e3), archived: false });
}

// ------------------------------------------------------------------ HTTP
const FORMATS = [/^\d{4}-\d{2}-\d{2}$/, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}$/, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/];
const parseDate = s => {
  if (!FORMATS.some(r => r.test(s))) throw Object.assign(new Error(`Bad query parameter: Unknown date format: ${s}`), { status: 400 });
  return Date.parse(s.length === 10 ? s + 'T00:00:00Z' : s.endsWith('Z') ? s : s + 'Z');
};
const ms = s => Date.parse(s);
let served = 0, throttle = false;

function authUser(req) {
  const h = req.headers.authorization || '';
  let m;
  if ((m = h.match(/^ApiKey ([^:]+):(.+)$/i))) { const u = USERS[m[1]]; return u && u.key === m[2] ? [m[1], u] : null; }
  if ((m = h.match(/^Basic (.+)$/i))) {
    const [user, pw] = Buffer.from(m[1], 'base64').toString().split(':');
    const u = USERS[user];
    return u && (u.pw === pw || u.key === pw) ? [user, u] : null; // basic_auth_or_try_api_key_auth
  }
  return null;
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, qs = u.searchParams;
  const json = (o, c = 200, h = {}) => { res.writeHead(c, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  for await (const _ of req) { /* drain */ }
  try {
    if (p === '/sim/stats') { const s = served; served = 0; return json({ served: s, forms: forms.length }); }
    if (p === '/sim/throttle') { throttle = true; return json({ ok: true }); }
    if (p === '/sim/add') { const out = []; for (let k = 0; k < Number(qs.get('n') || 1); k++) out.push(makeForm(Date.now()).id); return json({ added: out }); }
    if (p === '/sim/edit' || p === '/sim/archive') {
      const f = forms.find(x => x.id === qs.get('id'));
      if (p === '/sim/archive') f.archived = true;
      else { f.form.nom_mere = 'MODIFIÉE'; f.form.enfants = [{ prenom: 'Ajouté', age_mois: '2', muac: '140', etat: 'normal' }]; f.edited_on = iso6(Date.now()); }
      f.server_modified_on = iso6(Date.now()); f.indexed_on = iso6(Date.now());
      return json({ ok: true });
    }
    const who = authUser(req);
    if (!who) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('Username or API Key is incorrect, expired or deactivated'); }
    const [username, user] = who;
    if (throttle) { throttle = false; return json({ error: 'rate limited' }, 429, { 'Retry-After': '1' }); }
    const meta = (limit, offset, total, base) => ({ limit, next: offset + limit < total ? `?${new URLSearchParams({ ...Object.fromEntries(base), limit, offset: offset + limit })}` : null, offset, previous: null, total_count: total });

    if (p === '/api/v0.5/identity/') return json({ id: user.id, username, first_name: user.first_name, last_name: user.last_name, email: username });
    if (p === '/api/v0.5/user_domains/') return json({ meta: { limit: null, next: null, offset: 0, previous: null, total_count: 1 }, objects: [{ domain_name: DOMAIN, project_name: 'Démo nutrition (Matam)' }] });
    if (p === `/a/${DOMAIN}/api/v0.5/application/`) {
      const limit = Math.min(Number(qs.get('limit') || 20), 1000), offset = Number(qs.get('offset') || 0);
      // one app per page here, to exercise "meta.next" (relative "?limit=…&offset=…")
      const lim = Math.min(limit, 1);
      return json({ meta: meta(lim, offset, APPS.length, qs), objects: APPS.slice(offset, offset + lim) });
    }
    if (p === `/a/${DOMAIN}/api/v0.5/form/`) {
      if (!user.edit) return json({ error: 'You do not have permission to access this resource' }, 403);
      let list = forms.filter(f => !f.archived);
      if (qs.get('xmlns')) list = list.filter(f => f.xmlns === qs.get('xmlns'));
      if (qs.get('app_id')) list = list.filter(f => f.app_id === qs.get('app_id').toLowerCase());
      for (const k of ['received_on', 'server_modified_on', 'indexed_on']) {
        if (qs.get(k + '_start')) { const t = parseDate(qs.get(k + '_start')); list = list.filter(f => ms(f[k]) >= t); }
        if (qs.get(k + '_end')) { const t = parseDate(qs.get(k + '_end')); list = list.filter(f => ms(f[k]) <= t); }
      }
      const order = qs.get('order_by') || '-received_on';
      const key = order.replace(/^-/, ''), desc = order.startsWith('-');
      list = [...list].sort((a, b) => (ms(a[key]) - ms(b[key])) * (desc ? -1 : 1) || (a.id < b.id ? -1 : 1));
      const limit = Math.min(Number(qs.get('limit') || 20), 1000), offset = Number(qs.get('offset') || 0);
      if (offset + limit > MAX_WINDOW) return json({ error: 'Result window is too large' }, 400);
      const page = list.slice(offset, offset + limit);
      if (limit > 1) served += page.length;
      return json({ meta: meta(limit, offset, list.length, qs), objects: page });
    }
    json({ error: 'not found' }, 404);
  } catch (e) { json({ error: e.message }, e.status || 500); }
}).listen(PORT, () => console.log(`CommCare simulé sur http://localhost:${PORT} (projet ${DOMAIN})`));
