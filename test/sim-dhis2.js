// DHIS2 API simulator, written from the DHIS2 source code (github.com/dhis2/dhis2-core, tracker export
// controllers) and documentation, to test the connector without a real server.
// Usage: node test/sim-dhis2.js [port] [version]     (default 4630, "2.41.3")
//   version ≥ 2.41: {pager, events|enrollments}, orgUnitMode implicit, "ouMode" refused (removed in recent
//   versions); version 2.36–2.40: {page, pageSize, total, instances}, ouMode=ACCESSIBLE required;
//   version < 2.36: legacy /api/events only.
//
// Accounts: admin / district (everything, also token d2pat_admintoken0000000000000000000000),
//           agent / agent123 (restricted to the "Plateaux" region; data view = Plateaux).
// Simulator controls: POST /sim/add-event?n=, /sim/edit-event?id=, /sim/delete-event?id=, /sim/add-visit?id=<enrollment>,
//                     /sim/edit-value, /sim/delete-value ; GET /sim/stats

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.argv[2] || 4630);
const VERSION = process.argv[3] || '2.41.3';
const MINOR = Number(VERSION.split('.')[1]);

let seed = 23;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = a => a[Math.floor(rnd() * a.length)];
const CH = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const uid = () => CH[10 + Math.floor(rnd() * 42)] + Array.from({ length: 10 }, () => CH[Math.floor(rnd() * 62)]).join('');

// ------------------------------------------------------------------ org units (4 levels)
const LEVELS = [{ level: 1, displayName: 'Pays' }, { level: 2, displayName: 'Région' }, { level: 3, displayName: 'District' }, { level: 4, displayName: 'Formation sanitaire' }];
const OU = new Map();
const addOU = (name, parent, lat, lon) => {
  const o = { id: uid(), displayName: name, level: parent ? parent.level + 1 : 1, parent, lat, lon };
  o.path = (parent ? parent.path : '') + '/' + o.id;
  OU.set(o.id, o);
  return o;
};
const togo = addOU('Togo', null, 8.6, 1.0);
const REGIONS = {};
for (const [r, ds] of Object.entries({ Maritime: ['Golfe', 'Lacs'], Plateaux: ['Ogou', 'Kloto'], Centrale: ['Tchaoudjo', 'Sotouboua'], Kara: ['Kozah', 'Binah'], Savanes: ['Tône', 'Kpendjal'] })) {
  const reg = REGIONS[r] = addOU(r, togo, 6.3 + rnd() * 4, 0.8 + rnd() * 0.6);
  for (const d of ds) {
    const dist = addOU(d, reg, reg.lat + (rnd() - 0.5) / 2, reg.lon + (rnd() - 0.5) / 2);
    for (let k = 1; k <= 3; k++) addOU(`USP ${d} ${k}`, dist, dist.lat + (rnd() - 0.5) / 5, dist.lon + (rnd() - 0.5) / 5);
  }
}
const FACILITIES = [...OU.values()].filter(o => o.level === 4);
const ancestors = o => { const out = []; for (let p = o.parent; p; p = p.parent) out.unshift(p); return out; };
const within = (o, roots) => roots.some(r => o.path.startsWith(r.path));
const ouView = o => ({ id: o.id, displayName: o.displayName, level: o.level, path: o.path, ancestors: ancestors(o).map(a => ({ id: a.id, displayName: a.displayName, level: a.level })),
  ...(o.level === 4 ? { geometry: { type: 'Point', coordinates: [o.lon, o.lat] } } : {}) });

const USERS = {
  admin: { pw: 'district', displayName: 'John Traore', roots: [togo], token: 'd2pat_admintoken0000000000000000000000' },
  agent: { pw: 'agent123', displayName: 'Afi Mensah', roots: [REGIONS.Plateaux] },
};

// ------------------------------------------------------------------ metadata
const tr = (fr, en) => [{ locale: 'en', property: 'NAME', value: en }, { locale: 'fr', property: 'NAME', value: fr }];
const os = (id, opts) => ({ id, options: opts.map(([code, fr, en], i) => ({ code, displayName: en, sortOrder: i + 1, translations: tr(fr, en) })) });
const SEX = os('osSexe00001', [['F', 'Féminin', 'Female'], ['M', 'Masculin', 'Male']]);
const RDT = os('osTDR000001', [['POS', 'Positif', 'Positive'], ['NEG', 'Négatif', 'Negative'], ['NA', 'Non fait', 'Not done']]);
const SYMPT = os('osSympt0001', [['FIEVRE', 'Fièvre', 'Fever'], ['VOMIS', 'Vomissements', 'Vomiting'], ['CONV', 'Convulsions', 'Convulsions']]);
const de = (id, code, en, fr, valueType, optionSet) => ({ id, code, displayName: en, displayFormName: en, valueType, translations: tr(fr, en), ...(optionSet ? { optionSet } : {}) });
const DE = {
  age: de('deAge000001', 'MAL_AGE', 'Age (years)', 'Âge (années)', 'INTEGER_ZERO_OR_POSITIVE'),
  sex: de('deSexe00001', 'MAL_SEX', 'Sex', 'Sexe', 'TEXT', SEX),
  rdt: de('deTDR000001', 'MAL_RDT', 'RDT result', 'Résultat du TDR', 'TEXT', RDT),
  temp: de('deTemp00001', 'MAL_TEMP', 'Temperature (°C)', 'Température (°C)', 'NUMBER'),
  pregnant: de('dePreg00001', 'MAL_PREG', 'Pregnant', 'Enceinte', 'BOOLEAN'),
  act: de('deACT000001', 'MAL_ACT', 'ACT given', 'ACT administré', 'TRUE_ONLY'),
  sympt: de('deSympt0001', 'MAL_SYMPT', 'Symptoms', 'Symptômes', 'MULTI_TEXT', SYMPT),
  home: de('deHome00001', null, 'Home location', 'Domicile', 'COORDINATE'),
  weight: de('dePoids0001', 'ANC_WEIGHT', 'Weight (kg)', 'Poids (kg)', 'NUMBER'),
  sys: de('deTension01', 'ANC_BP_SYS', 'Systolic BP', 'Tension systolique', 'INTEGER_POSITIVE'),
  hb: de('deHb0000001', 'ANC_HB', 'Haemoglobin (g/dl)', 'Hémoglobine (g/dl)', 'NUMBER'),
  iron: de('deFer000001', 'ANC_IRON', 'Iron given', 'Fer donné', 'BOOLEAN'),
  place: de('deLieu00001', 'DEL_PLACE', 'Place of delivery', 'Lieu d\'accouchement', 'TEXT', os('osLieu00001', [['FOSA', 'Formation sanitaire', 'Health facility'], ['DOMICILE', 'Domicile', 'Home']])),
  outcome: de('deIssue0001', 'DEL_OUTCOME', 'Outcome', 'Issue', 'TEXT', os('osIssue0001', [['VIVANT', 'Né vivant', 'Live birth'], ['MORT', 'Mort-né', 'Stillbirth']])),
  bw: de('dePoidsNai1', 'DEL_BW', 'Birth weight (g)', 'Poids de naissance (g)', 'INTEGER_POSITIVE'),
};
const TEA = {
  name: de('teaNom00001', 'NAME', 'Full name', 'Nom complet', 'TEXT'),
  age: de('teaAge00001', 'AGE', 'Age', 'Âge', 'INTEGER_POSITIVE'),
  village: de('teaVillage1', 'VILLAGE', 'Village', 'Village', 'TEXT'),
  hiv: de('teaVIH00001', 'HIV', 'HIV status', 'Statut VIH', 'TEXT', os('osVIH000001', [['POS', 'Positif', 'Positive'], ['NEG', 'Négatif', 'Negative'], ['INC', 'Inconnu', 'Unknown']])),
};
const psde = list => list.map((d, i) => ({ sortOrder: i + 1, dataElement: d }));
const PROGRAMS = [
  { id: 'prgPalu0001', displayName: 'Malaria case surveillance', programType: 'WITHOUT_REGISTRATION',
    programStages: [{ id: 'stgPalu0001', displayName: 'Malaria case', sortOrder: 1, repeatable: false, translations: tr('Cas de paludisme', 'Malaria case'),
      programStageDataElements: psde([DE.age, DE.sex, DE.rdt, DE.temp, DE.pregnant, DE.act, DE.sympt, DE.home]) }], programTrackedEntityAttributes: [] },
  { id: 'prgCPN00001', displayName: 'Antenatal care (ANC)', programType: 'WITH_REGISTRATION',
    programStages: [
      { id: 'stgVisite01', displayName: 'ANC visit', sortOrder: 1, repeatable: true, translations: tr('Visite CPN', 'ANC visit'), programStageDataElements: psde([DE.weight, DE.sys, DE.hb, DE.iron]) },
      { id: 'stgAccouch1', displayName: 'Delivery', sortOrder: 2, repeatable: false, translations: tr('Accouchement', 'Delivery'), programStageDataElements: psde([DE.place, DE.outcome, DE.bw]) },
    ],
    programTrackedEntityAttributes: [TEA.name, TEA.age, TEA.village, TEA.hiv].map((a, i) => ({ sortOrder: i + 1, trackedEntityAttribute: a })) },
];
const coc = (id, displayName) => ({ id, displayName });
const DEFAULT_CC = { id: 'ccDefault01', categoryOptionCombos: [coc('cocDefault1', 'default')] };
const AGE_CC = { id: 'ccAge000001', categoryOptionCombos: [coc('cocMoins20', '<20 ans'), coc('cocPlus20', '20 ans et plus')] };
const SEX_CC = { id: 'ccSexe00001', categoryOptionCombos: [coc('cocFemme01', 'Féminin'), coc('cocHomme01', 'Masculin')] };
const AGG = [
  { ...de('deCPN1Agg01', 'SMI_CPN1', 'ANC 1st visit', 'CPN1', 'INTEGER_ZERO_OR_POSITIVE'), categoryCombo: AGE_CC },
  { ...de('deAccAgg001', 'SMI_DELIV', 'Assisted deliveries', 'Accouchements assistés', 'INTEGER_ZERO_OR_POSITIVE'), categoryCombo: DEFAULT_CC },
  { ...de('dePenta3Agg', 'SMI_PENTA3', 'Penta 3 doses given', 'Penta 3 administrés', 'INTEGER_ZERO_OR_POSITIVE'), categoryCombo: SEX_CC },
  { ...de('deRuptAgg01', 'SMI_STOCKOUT', 'Stock-out comment', 'Rupture (commentaire)', 'TEXT'), categoryCombo: DEFAULT_CC },
];
const DATASETS = [{ id: 'dsSMI000001', displayName: 'Monthly MCH report', periodType: 'Monthly', categoryCombo: DEFAULT_CC, dataSetElements: AGG.map(d => ({ dataElement: d })) }];

// ------------------------------------------------------------------ data
const NOW = Date.now();
const iso = t => new Date(t).toISOString();
const events = [];
function addEvent(t) {
  const f = pick(FACILITIES);
  const age = Math.floor(rnd() * 60);
  const dv = [
    ['deAge000001', String(age)], ['deSexe00001', pick(['F', 'M'])], ['deTDR000001', pick(['POS', 'POS', 'NEG', 'NA'])], ['deTemp00001', (36 + rnd() * 4).toFixed(1)],
    ['deSympt0001', ['FIEVRE', 'VOMIS', 'CONV'].filter(() => rnd() < 0.5).join(',')],
  ];
  if (rnd() < 0.2) dv.push(['dePreg00001', pick(['true', 'false'])]);
  if (rnd() < 0.6) dv.push(['deACT000001', 'true']);
  if (rnd() < 0.5) dv.push(['deHome00001', `[${(f.lon + (rnd() - 0.5) / 20).toFixed(5)},${(f.lat + (rnd() - 0.5) / 20).toFixed(5)}]`]);
  const e = { event: uid(), program: 'prgPalu0001', programStage: 'stgPalu0001', status: pick(['ACTIVE', 'COMPLETED', 'COMPLETED']), orgUnit: f.id,
    occurredAt: iso(t), createdAt: iso(t + 3600e3), updatedAt: iso(t + 3600e3), deleted: false, createdBy: { uid: 'u1', username: pick(['agent', 'admin', 'infirmier3']) },
    geometry: rnd() < 0.7 ? { type: 'Point', coordinates: [f.lon + (rnd() - 0.5) / 30, f.lat + (rnd() - 0.5) / 30] } : null,
    dataValues: dv.filter(([, v]) => v !== '').map(([dataElement, value]) => ({ dataElement, value })) };
  events.push(e);
  return e;
}
for (let i = 0; i < 2500; i++) addEvent(NOW - Math.floor(rnd() * 400) * 864e5 - 400e3 - 864e5);

const enrollments = [];
function visit(en, t) {
  return { event: uid(), program: 'prgCPN00001', programStage: 'stgVisite01', enrollment: en.enrollment, trackedEntity: en.trackedEntity, status: 'COMPLETED', orgUnit: en.orgUnit,
    occurredAt: iso(t), createdAt: iso(t), updatedAt: iso(t), deleted: false, createdBy: { username: 'sagefemme' },
    dataValues: [{ dataElement: 'dePoids0001', value: (50 + rnd() * 30).toFixed(1) }, { dataElement: 'deTension01', value: String(100 + Math.floor(rnd() * 50)) },
      { dataElement: 'deHb0000001', value: (8 + rnd() * 6).toFixed(1) }, { dataElement: 'deFer000001', value: pick(['true', 'false']) }] };
}
function addEnrollment(t) {
  const f = pick(FACILITIES);
  const en = { enrollment: uid(), trackedEntity: uid(), program: 'prgCPN00001', status: pick(['ACTIVE', 'ACTIVE', 'COMPLETED']), orgUnit: f.id, enrolledAt: iso(t), occurredAt: iso(t - 60 * 864e5),
    createdAt: iso(t), updatedAt: iso(t), followUp: rnd() < 0.1, deleted: false, createdBy: { username: 'sagefemme' },
    attributes: [{ attribute: 'teaNom00001', value: `${pick(['Ama', 'Akossiwa', 'Essi', 'Kafui', 'Mawuena'])} ${pick(['Agbo', 'Lawson', 'Adjo', 'Koffi'])}` },
      { attribute: 'teaAge00001', value: String(16 + Math.floor(rnd() * 25)) }, { attribute: 'teaVillage1', value: pick(['Atakpamé', 'Kpalimé', 'Badou', 'Notsé']) },
      { attribute: 'teaVIH00001', value: pick(['NEG', 'NEG', 'NEG', 'POS', 'INC']) }], events: [] };
  const n = 1 + Math.floor(rnd() * 4);
  for (let k = 0; k < n; k++) if (t + k * 30 * 864e5 < NOW) en.events.push(visit(en, t + k * 30 * 864e5)); // nothing in the future
  if (en.status === 'COMPLETED' && t + 200 * 864e5 < NOW) en.events.push({ event: uid(), program: 'prgCPN00001', programStage: 'stgAccouch1', enrollment: en.enrollment, trackedEntity: en.trackedEntity, status: 'COMPLETED',
    orgUnit: f.id, occurredAt: iso(t + 200 * 864e5), createdAt: iso(t + 200 * 864e5), updatedAt: iso(t + 200 * 864e5), deleted: false, createdBy: { username: 'sagefemme' },
    dataValues: [{ dataElement: 'deLieu00001', value: pick(['FOSA', 'FOSA', 'DOMICILE']) }, { dataElement: 'deIssue0001', value: pick(['VIVANT', 'VIVANT', 'VIVANT', 'MORT']) },
      { dataElement: 'dePoidsNai1', value: String(2200 + Math.floor(rnd() * 1800)) }] });
  enrollments.push(en);
  return en;
}
for (let i = 0; i < 600; i++) addEnrollment(NOW - Math.floor(rnd() * 500) * 864e5 - 400e3 - 864e5);

const values = [];
const month = (k) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - k); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
for (let k = 0; k < 24; k++) for (const f of FACILITIES) for (const d of AGG) {
  if (d.valueType === 'TEXT') { if (rnd() < 0.05) values.push({ dataElement: d.id, period: month(k), orgUnit: f.id, categoryOptionCombo: 'cocDefault1', attributeOptionCombo: 'cocDefault1', value: 'Rupture de vaccins', storedBy: 'admin', created: iso(NOW - k * 30 * 864e5), lastUpdated: iso(NOW - k * 30 * 864e5 + 1e3), comment: '', followup: false }); continue; }
  for (const c of d.categoryCombo.categoryOptionCombos) values.push({ dataElement: d.id, period: month(k), orgUnit: f.id, categoryOptionCombo: c.id, attributeOptionCombo: 'cocDefault1',
    value: String(Math.floor(rnd() * 40)), storedBy: pick(['agent', 'admin']), created: iso(NOW - k * 30 * 864e5), lastUpdated: iso(NOW - k * 30 * 864e5 + 1e3), comment: '', followup: false });
}

// ------------------------------------------------------------------ helpers
const parseDT = (s, end) => {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(s + 'T00:00:00Z') + (end ? 864e5 - 1 : 0);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw Object.assign(new Error(`Invalid date: ${s}`), { status: 400 });
  return t;
};
function page(list, q, key) {
  const paging = q.get('paging') !== 'false';
  const pageSize = Number(q.get('pageSize') || 50), p = Number(q.get('page') || 1);
  const total = q.get('totalPages') === 'true' ? list.length : undefined;
  const slice = paging ? list.slice((p - 1) * pageSize, p * pageSize) : list;
  if (MINOR >= 41) {
    const pager = { page: p, pageSize, ...(total != null ? { total, pageCount: Math.ceil(total / pageSize) } : {}) };
    if (p * pageSize < list.length) pager.nextPage = `http://localhost:${PORT}/next`;
    return { pager, [key]: slice };
  }
  return { page: p, pageSize, ...(total != null ? { total, pageCount: Math.ceil(total / pageSize) } : {}), instances: slice };
}
function ouModeCheck(q) {
  if (MINOR >= 41 && q.has('ouMode')) throw Object.assign(new Error('Parameter ouMode is not supported, use orgUnitMode'), { status: 400 });
  if (MINOR < 41 && !q.has('ouMode') && !q.has('orgUnit')) throw Object.assign(new Error('At least one organisation unit must be specified'), { status: 409 });
}
let served = 0;

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, q = u.searchParams;
  const json = (o, c = 200, h = {}) => { res.writeHead(c, { 'Content-Type': 'application/json;charset=UTF-8', ...h }); res.end(JSON.stringify(o)); };
  for await (const _ of req) { /* drain */ }
  try {
    // --- simulator controls
    if (p === '/sim/stats') { const s = served; served = 0; return json({ served: s }); }
    if (p === '/sim/add-event') { const out = []; for (let k = 0; k < Number(q.get('n') || 1); k++) { const e = addEvent(Date.now() - 864e5); e.createdAt = e.updatedAt = iso(Date.now()); out.push(e.event); } return json({ added: out }); }
    if (p === '/sim/edit-event') { const e = events.find(x => x.event === q.get('id')); e.dataValues.find(d => d.dataElement === 'deAge000001').value = '99'; e.updatedAt = iso(Date.now()); return json({ ok: true }); }
    if (p === '/sim/delete-event') { const e = events.find(x => x.event === q.get('id')); e.deleted = true; e.updatedAt = iso(Date.now()); return json({ ok: true }); }
    if (p === '/sim/add-visit') { const en = enrollments.find(x => x.enrollment === q.get('id')); en.events.push(visit(en, Date.now())); return json({ ok: true }); } // the enrollment is NOT touched
    if (p === '/sim/edit-value') { const v = values.find(x => x.dataElement === 'deAccAgg001' && x.period === month(0)); v.value = '999'; v.lastUpdated = iso(Date.now()); return json({ id: `${v.dataElement}|${v.period}|${v.orgUnit}|${v.categoryOptionCombo}|${v.attributeOptionCombo}` }); }
    if (p === '/sim/delete-value') { const v = values.find(x => x.dataElement === 'dePenta3Agg' && x.period === month(0) && !x.deleted); v.deleted = true; v.lastUpdated = iso(Date.now()); return json({ id: `${v.dataElement}|${v.period}|${v.orgUnit}|${v.categoryOptionCombo}|${v.attributeOptionCombo}` }); }

    // --- authentication: Basic or personal access token; anything else → 401 (API clients)
    const h = req.headers.authorization || '';
    let username = null;
    if (/^Basic /.test(h)) { const [us, pw] = Buffer.from(h.slice(6), 'base64').toString().split(':'); if (USERS[us] && USERS[us].pw === pw) username = us; }
    else if (/^ApiToken /.test(h)) { const t = h.slice(9); username = Object.keys(USERS).find(k => USERS[k].token === t) || null; }
    if (!username) return json({ httpStatus: 'Unauthorized', httpStatusCode: 401, status: 'ERROR', message: 'Account is invalid' }, 401);
    const user = USERS[username];
    const visible = o => o && within(o, user.roots);

    if (p === '/api/me') return json({ id: 'u' + username, username, displayName: user.displayName, settings: { keyUiLocale: 'fr' }, organisationUnits: user.roots.map(r => ({ id: r.id })), dataViewOrganisationUnits: user.roots.map(r => ({ id: r.id })) });
    if (p === '/api/system/info') return json({ version: VERSION, revision: 'sim', serverTimeZoneId: 'Africa/Lome' });
    if (p === '/api/programs') return json({ programs: PROGRAMS.map(x => ({ id: x.id, displayName: x.displayName, programType: x.programType })) });
    let m;
    if ((m = p.match(/^\/api\/programs\/(\w+)$/))) { const x = PROGRAMS.find(y => y.id === m[1]); return x ? json(q.get('fields') === 'id' ? { id: x.id } : x) : json({ httpStatusCode: 404, message: `Program with id ${m[1]} could not be found.` }, 404); }
    if (p === '/api/dataSets') return json({ dataSets: DATASETS.map(d => ({ id: d.id, displayName: d.displayName, periodType: d.periodType })) });
    if ((m = p.match(/^\/api\/dataSets\/(\w+)$/))) { const d = DATASETS.find(y => y.id === m[1]); return d ? json(d) : json({ httpStatusCode: 404, message: 'not found' }, 404); }
    if (p === '/api/organisationUnitLevels') return json({ organisationUnitLevels: LEVELS });
    if (p === '/api/organisationUnits') {
      const f = (q.get('filter') || '').match(/^id:in:\[(.*)\]$/);
      const ids = f ? f[1].split(',') : [];
      return json({ organisationUnits: ids.map(id => OU.get(id)).filter(Boolean).map(ouView) });
    }
    if (p === '/api/dataValueSets.json' || p === '/api/dataValueSets') {
      if (!q.get('dataSet')) return json({ httpStatusCode: 409, message: 'At least one valid data set or data element group must be specified' }, 409);
      if (!q.get('startDate') && !q.get('period') && !q.get('lastUpdated')) return json({ httpStatusCode: 409, message: 'At least one valid period, start/end dates, last updated or last updated duration must be specified' }, 409);
      const roots = q.getAll('orgUnit').map(id => OU.get(id)).filter(Boolean);
      if (!roots.length || roots.some(r => !visible(r))) return json({ httpStatusCode: 409, message: 'User is not allowed to view org unit' }, 409);
      const ds = DATASETS.find(d => d.id === q.get('dataSet'));
      const des = new Set(ds.dataSetElements.map(x => x.dataElement.id));
      const start = q.get('startDate'), end = q.get('endDate'), lu = q.get('lastUpdated') ? parseDT(q.get('lastUpdated')) : null;
      const out = values.filter(v => des.has(v.dataElement) && (q.get('includeDeleted') === 'true' || !v.deleted)
        && within(OU.get(v.orgUnit), q.get('children') === 'true' ? roots : []) && (!lu || Date.parse(v.lastUpdated) >= lu)
        && (!start || `${v.period.slice(0, 4)}-${v.period.slice(4, 6)}-01` >= start.slice(0, 7) + '-01') && (!end || `${v.period.slice(0, 4)}-${v.period.slice(4, 6)}-01` <= end));
      served += out.length;
      return json({ dataValues: out });
    }
    if (p === '/api/events') { // legacy event API (< 2.36)
      if (MINOR >= 41) return json({ httpStatusCode: 404, message: 'Not found' }, 404);
      ouModeCheck(q);
      let list = events.filter(e => e.program === q.get('program') && visible(OU.get(e.orgUnit)) && !e.deleted);
      if (q.get('lastUpdatedStartDate')) { const t = parseDT(q.get('lastUpdatedStartDate')); list = list.filter(e => Date.parse(e.updatedAt) >= t); }
      if (q.get('startDate')) { const t = parseDT(q.get('startDate')); list = list.filter(e => Date.parse(e.occurredAt) >= t); }
      if (q.get('endDate')) { const t = parseDT(q.get('endDate'), true); list = list.filter(e => Date.parse(e.occurredAt) <= t); }
      const pageSize = Number(q.get('pageSize') || 50), pg = Number(q.get('page') || 1);
      const slice = list.slice((pg - 1) * pageSize, pg * pageSize).map(e => ({ event: e.event, program: e.program, programStage: e.programStage, status: e.status, orgUnit: e.orgUnit,
        orgUnitName: OU.get(e.orgUnit).displayName, eventDate: e.occurredAt, created: e.createdAt, lastUpdated: e.updatedAt, storedBy: e.createdBy.username, deleted: false, geometry: e.geometry, dataValues: e.dataValues }));
      served += pageSize > 1 ? slice.length : 0;
      return json({ pager: { page: pg, pageSize, ...(q.get('totalPages') === 'true' ? { total: list.length, pageCount: Math.ceil(list.length / pageSize) } : {}) }, events: slice });
    }
    if (MINOR < 36 && p.startsWith('/api/tracker/')) return json({ httpStatusCode: 404, message: 'Not found' }, 404);
    if (p === '/api/tracker/events') {
      ouModeCheck(q);
      const prog = q.get('program');
      let list = [...events, ...enrollments.flatMap(en => en.events.map(e => ({ ...e, _en: en })))].filter(e => (!prog || e.program === prog) && visible(OU.get(e.orgUnit)));
      if (q.get('includeDeleted') !== 'true') list = list.filter(e => !e.deleted);
      if (q.get('updatedAfter')) { const t = parseDT(q.get('updatedAfter')); list = list.filter(e => Date.parse(e.updatedAt) >= t); }
      if (q.get('occurredAfter')) { const t = parseDT(q.get('occurredAfter')); list = list.filter(e => Date.parse(e.occurredAt) >= t); }
      if (q.get('occurredBefore')) { const t = parseDT(q.get('occurredBefore'), true); list = list.filter(e => Date.parse(e.occurredAt) <= t); }
      const out = page(list.map(({ _en, ...e }) => e), q, 'events');
      served += Number(q.get('pageSize') || 50) > 1 ? (out.events || out.instances).length : 0;
      return json(out);
    }
    const enView = en => ({ ...en, events: en.events.filter(e => !e.deleted) });
    if ((m = p.match(/^\/api\/tracker\/enrollments\/(\w+)$/))) {
      const en = enrollments.find(x => x.enrollment === m[1] && !x.deleted && visible(OU.get(x.orgUnit)));
      return en ? json(enView(en)) : json({ httpStatusCode: 404, message: `Enrollment with id ${m[1]} could not be found.` }, 404);
    }
    if (p === '/api/tracker/enrollments') {
      ouModeCheck(q);
      let list = enrollments.filter(en => en.program === q.get('program') && visible(OU.get(en.orgUnit)) && !en.deleted);
      if (q.get('updatedAfter')) { const t = parseDT(q.get('updatedAfter')); list = list.filter(en => Date.parse(en.updatedAt) >= t); }
      if (MINOR >= 41 && q.get('enrolledAfter')) { const t = parseDT(q.get('enrolledAfter')); list = list.filter(en => Date.parse(en.enrolledAt) >= t); }
      if (MINOR >= 41 && q.get('enrolledBefore')) { const t = parseDT(q.get('enrolledBefore'), true); list = list.filter(en => Date.parse(en.enrolledAt) <= t); }
      const out = page(list.map(enView), q, 'enrollments');
      served += Number(q.get('pageSize') || 50) > 1 ? (out.enrollments || out.instances).length : 0;
      return json(out);
    }
    json({ httpStatusCode: 404, message: 'Not found' }, 404);
  } catch (e) { json({ httpStatusCode: e.status || 500, message: e.message }, e.status || 500); }
}).listen(PORT, () => console.log(`DHIS2 ${VERSION} simulé sur http://localhost:${PORT}`));
