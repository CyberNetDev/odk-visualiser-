// npm test — unit tests of the record normalisation + end-to-end tests of the IASO and CommCare connectors
// against the simulators (test/sim-*.js), through the real server (no network needed).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Schema, explode, descriptorSchema } = require('../connectors/records');
const { toGeoPoint } = require('../connectors/common');
const { extractFields } = require('../xform');

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

test('IASO and CommCare through the server', async t => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'odkvis-'));
  await start(['test/sim-iaso.js', String(port + 100)]);
  await start(['test/sim-commcare.js', String(port + 110)]);
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
});
