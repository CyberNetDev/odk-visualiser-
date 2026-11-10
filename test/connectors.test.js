// npm test — unit tests of the record normalisation + end-to-end tests of the IASO, CommCare, DHIS2 and
// mSupply connectors against the simulators (test/sim-*.js), through the real server (no network needed).
// The mSupply simulator needs the "graphql" dev dependency: run "npm install" once.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Schema, explode, descriptorSchema } = require('../connectors/records');
const { toGeoPoint } = require('../connectors/common');
const { extractFields } = require('../xform');
const { periodStart } = require('../connectors/dhis2');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');

test('geopoints become GeoJSON like ODK Central', () => {
  assert.deepEqual(toGeoPoint('12.5 -1.25 300 4'), { type: 'Point', coordinates: [-1.25, 12.5, 300], properties: { accuracy: 4 } });
  assert.deepEqual(toGeoPoint({ '#text': '1 2' }), { type: 'Point', coordinates: [2, 1] });
  assert.equal(toGeoPoint(''), null);
  assert.equal(toGeoPoint('0 0'), null);
});

test('XForm and pyxform descriptor give the same fields', () => {
  const a = extractFields(fs.readFileSync(path.join(FIX, 'menage.xml'), 'utf8')).filter(f => f.name !== 'merci');
  const b = descriptorSchema(JSON.parse(fs.readFileSync(path.join(FIX, 'menage.descriptor.json'), 'utf8'))).fields;
  assert.deepEqual(a.map(f => [f.path, f.type, f.selectMultiple, f.repeat]), b.map(f => [f.path, f.type, f.selectMultiple, f.repeat]));
});

test('explode: groups nested, repeats as child tables, single-entry repeat object', () => {
  const schema = new Schema([
    { path: 'g/n', name: 'n', type: 'int' }, { path: 'r', name: 'r', type: 'repeat', repeat: true },
    { path: 'r/x', name: 'x', type: 'decimal' }, { path: 'r/s', name: 's', type: 'repeat', repeat: true }, { path: 'r/s/y', name: 'y', type: 'string' },
  ]);
  const t = explode('A', { g: { n: '3' }, r: { x: '1.5', s: [{ y: 'a' }, { y: '' }] }, '@xmlns': 'x' }, schema, { submissionDate: 'd' });
  assert.deepEqual(t.Submissions, [{ __id: 'A', __system: { submissionDate: 'd' }, g: { n: 3 } }]);
  assert.deepEqual(t['Submissions.r'], [{ __id: 'A/r[1]', '__Submissions-id': 'A', __root: 'A', x: 1.5 }]);
  assert.deepEqual(t['Submissions.r.s'].map(r => [r.__id, r['__Submissions-r-id'], r.y]), [['A/r[1]/s[1]', 'A/r[1]', 'a'], ['A/r[1]/s[2]', 'A/r[1]', null]]);
});

test('DHIS2 periods → first day', () => {
  assert.equal(periodStart('202403'), '2024-03-01');
  assert.equal(periodStart('2024Q3'), '2024-07-01');
  assert.equal(periodStart('2025W01'), '2024-12-30');
  assert.equal(periodStart('2024April'), '2024-04-01');
  assert.equal(periodStart('2024NovQ1'), '2023-11-01');
  assert.equal(periodStart('202403B'), '2024-05-01');
});

// ------------------------------------------------------------------ end to end
const procs = [];
const start = (args, env = {}) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  let out = '';
  p.stdout.on('data', d => { out += d; if (/http:\/\/localhost/.test(out)) resolve(p); });
  p.stderr.on('data', d => { out += d; });
  p.on('exit', c => reject(new Error(`exit ${c}: ${out}`)));
});
test.after(() => procs.forEach(p => p.kill()));

const port = 3900 + Math.floor(Math.random() * 50);
const B = `http://localhost:${port}`;
let cookie = '';
async function call(p, { method = 'GET', body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });
  const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0];
  return { status: r.status, body: await r.json(), h: r.headers };
}

test('IASO, CommCare, DHIS2 and mSupply through the server', async t => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odkvis-'));
  await start(['test/sim-iaso.js', String(port + 100)]);
  await start(['test/sim-commcare.js', String(port + 110)]);
  await start(['test/sim-dhis2.js', String(port + 120), '2.41.3']);
  await start(['test/sim-dhis2.js', String(port + 122), '2.40.5']);
  await start(['test/sim-msupply.js', String(port + 130)]);
  await start(['server.js'], { PORT: String(port), CACHE_DIR: cacheDir });

  await t.test('IASO', async () => {
    assert.equal((await call('/api/login', { method: 'POST', body: { platform: 'iaso', server: `http://localhost:${port + 100}`, email: 'admin', password: 'x' } })).status, 401);
    const me = await call('/api/login', { method: 'POST', body: { platform: 'iaso', server: `http://localhost:${port + 100}/dashboard`, email: 'admin', password: 'admin123' } });
    assert.equal(me.body.platform, 'iaso');
    assert.deepEqual((await call('/api/projects/1/forms/11/tables')).body, ['Submissions', 'Submissions.membres']);
    const fields = (await call('/api/projects/1/forms/11/fields')).body;
    assert.ok(fields.some(f => f.path === '__system/level2' && /Département/.test(f.name)));
    const rows = (await call('/api/projects/1/forms/11/data')).body.rows;
    assert.equal(rows.length, 1200);
    assert.equal(typeof rows[0].menage.taille, 'number');
    const kids = (await call('/api/projects/1/forms/11/data?table=Submissions.membres')).body.rows;
    assert.ok(kids.every(k => rows.some(r => r.__id === k['__Submissions-id'])));
    // descriptor fallback (form file is private)
    assert.ok((await call('/api/projects/1/forms/12/labels')).body.choices.eau.oui);
  });

  await t.test('CommCare', async () => {
    cookie = '';
    const me = await call('/api/login', { method: 'POST', body: { platform: 'commcare', server: `http://localhost:${port + 110}`, email: 'enqueteur@demo.org', password: 'cle-api-123' } });
    assert.equal(me.body.platform, 'commcare');
    const forms = (await call('/api/projects/demo-nutrition/forms')).body;
    const fid = encodeURIComponent(forms[0].id);
    assert.deepEqual((await call(`/api/projects/demo-nutrition/forms/${fid}/tables`)).body, ['Submissions', 'Submissions.enfants']);
    const rows = (await call(`/api/projects/demo-nutrition/forms/${fid}/data`)).body.rows;
    assert.equal(rows.length, 11800); // more than the 10 000 Elasticsearch window: keyset paging works
    assert.equal(new Set(rows.map(r => r.__id)).size, rows.length);
    assert.ok(!rows.some(r => r.case || r.meta), 'case blocks and meta are not form fields');
    const L = (await call(`/api/projects/demo-nutrition/forms/${fid}/labels`)).body;
    assert.equal(L.choices['enfants/etat'].mas.fr, 'Malnutrition sévère');
  });

  for (const [version, p] of [['2.41', port + 120], ['2.40', port + 122]]) {
    await t.test(`DHIS2 ${version}`, async () => {
      cookie = '';
      const bad = await call("/api/login", { method: "POST", body: { platform: "dhis2", server: `http://localhost:${p}`, email: "admin", password: "x" } });
      assert.equal(bad.status, 401, JSON.stringify(bad.body));
      const me = await call('/api/login', { method: 'POST', body: { platform: 'dhis2', server: `http://localhost:${p}/dhis-web-dashboard/`, email: 'admin', password: 'district' } });
      assert.equal(me.body.platform, 'dhis2');
      assert.deepEqual((await call('/api/projects')).body.map(x => x.id), ['evenements', 'tracker', 'agrege']);
      const ev = (await call('/api/projects/evenements/forms/prgPalu0001/data')).body.rows;
      assert.equal(ev.length, 2500);
      assert.equal(ev[0].__system.level1, 'Togo');
      const sept = (await call('/api/projects/evenements/forms/prgPalu0001/data?from=2026-09-01&to=2026-09-30')).body.rows;
      assert.ok(sept.length > 0 && sept.every(r => r.__system.submissionDate.startsWith('2026-09')));
      assert.deepEqual((await call('/api/projects/tracker/forms/prgCPN00001/tables')).body, ['Submissions', 'Submissions.stgVisite01', 'Submissions.stgAccouch1']);
      const en = (await call('/api/projects/tracker/forms/prgCPN00001/data')).body.rows;
      const visits = (await call('/api/projects/tracker/forms/prgCPN00001/data?table=Submissions.stgVisite01')).body.rows;
      const ids = new Set(en.map(r => r.__id));
      assert.ok(visits.length > en.length && visits.every(v => ids.has(v['__Submissions-id'])));
      const L = (await call('/api/projects/tracker/forms/prgCPN00001/labels')).body;
      assert.equal(L.fields['stgVisite01/dePoids0001'].fr, 'Poids (kg)');
      const agg = (await call('/api/projects/agrege/forms/dsSMI000001/data')).body.rows;
      assert.ok(agg.length > 1000 && agg.every(r => r.__system.submissionDate));
      // restricted user: only the Plateaux region
      cookie = '';
      await call('/api/login', { method: 'POST', body: { platform: 'dhis2', server: `http://localhost:${p}`, email: 'agent', password: 'agent123' } });
      const mine = (await call('/api/projects/evenements/forms/prgPalu0001/data')).body.rows;
      assert.ok(mine.length > 0 && mine.length < 2500 && mine.every(r => r.__system.level2 === 'Plateaux'));
    });
  }

  await t.test('mSupply', async () => {
    cookie = '';
    assert.equal((await call('/api/login', { method: 'POST', body: { platform: 'msupply', server: `http://localhost:${port + 130}`, email: 'admin', password: 'x' } })).status, 401);
    const me = await call('/api/login', { method: 'POST', body: { platform: 'msupply', server: `http://localhost:${port + 130}/graphql`, email: 'admin', password: 'pass' } });
    assert.equal(me.body.platform, 'msupply');
    assert.equal((await call('/api/projects')).body.length, 2);
    const stock = (await call('/api/projects/store-central/forms/stock/data')).body.rows;
    assert.ok(stock.length > 0 && stock.every(r => r.packs_total > 0 && r.units_total === r.packs_total * r.pack_size));
    const out = (await call('/api/projects/store-central/forms/outbound/data')).body.rows;
    const lines = (await call('/api/projects/store-central/forms/outbound/data?table=Submissions.lignes')).body.rows;
    assert.equal(out.length, 700);
    assert.ok(lines.every(l => out.some(o => o.__id === l['__Submissions-id'])));
    // mSupply Desktop (REST v4), mSupply user
    cookie = '';
    const d = await call('/api/login', { method: 'POST', body: { platform: 'msupply', server: `http://localhost:${port + 131}`, email: 'gestionnaire', password: 'pass' } });
    assert.equal(d.status, 200);
    assert.deepEqual((await call('/api/projects/store/forms')).body.map(f => f.id), ['storeInvoices']);
    assert.ok((await call('/api/projects/store/forms/storeInvoices/data')).body.rows.length > 100);
  });
});
