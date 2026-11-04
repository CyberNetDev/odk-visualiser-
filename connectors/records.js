// Turns form records of other platforms (IASO, CommCare) into the row shape of ODK Central's OData feed,
// so the whole frontend (fields, labels, joins, formatter, cache) works unchanged:
//   Submissions          → { __id, __system: {...}, group: { question: value }, ... }
//   Submissions.g.repeat → { __id, '__Submissions-id': <parent __id>, question: value, ... }
// Repeat rows also carry __root (id of their submission) so the cache can update them incrementally.

const { toGeoPoint } = require('./common');

const tableOf = repeatPath => 'Submissions.' + repeatPath.replace(/\//g, '.');
const parentKey = table => `__${table.replace(/\./g, '-')}-id`;

// fields: [{ path, name, type, selectMultiple, repeat }] (paths without the root element, e.g. "hh/members/age")
class Schema {
  constructor(fields) {
    this.fields = fields;
    this.byPath = new Map(fields.map(f => [f.path, f]));
    this.repeats = fields.filter(f => f.repeat).map(f => f.path).sort((a, b) => a.length - b.length);
    this.repeatSet = new Set(this.repeats);
  }
  tables() { return ['Submissions', ...this.repeats.map(tableOf)]; }
  // innermost repeat containing a path ('' = the submission itself)
  ownerOf(path) {
    let best = '';
    for (const r of this.repeats) if (path.startsWith(r + '/') && r.length > best.length) best = r;
    return best;
  }
}

function coerce(v, f) {
  if (v === '' || v === undefined) return null;
  if (v && typeof v === 'object' && !Array.isArray(v) && '#text' in v) v = v['#text'];
  if (!f) return v;
  if (f.type === 'int' || f.type === 'decimal') {
    if (typeof v === 'number') return v;
    const s = String(v).trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (f.type === 'geopoint') return toGeoPoint(v);
  if (typeof v === 'object') return v;
  return String(v);
}

function setPath(obj, rel, value) {
  const segs = rel.split('/');
  let o = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    if (!o[segs[i]] || typeof o[segs[i]] !== 'object' || Array.isArray(o[segs[i]])) o[segs[i]] = {};
    o = o[segs[i]];
  }
  o[segs[segs.length - 1]] = value;
}

const isMeta = k => k[0] === '@' || k[0] === '#';
const isValueObject = v => v && typeof v === 'object' && !Array.isArray(v) && '#text' in v;

// tree: nested object (groups = objects, repeats = arrays, or a single object for a one-entry repeat).
// Returns { Submissions: [row], 'Submissions.x': [...] }. `skip(path)` drops paths (meta, case blocks...).
function explode(rootId, tree, schema, system, { skip = () => false } = {}) {
  const tables = { Submissions: [] };
  const root = { __id: String(rootId) };
  if (system) root.__system = system;
  tables.Submissions.push(root);

  const fill = (row, node, base, rel, table) => {
    for (const [k, v] of Object.entries(node || {})) {
      if (isMeta(k)) continue;
      const full = base ? `${base}/${k}` : k;
      const relPath = rel ? `${rel}/${k}` : k;
      if (skip(full)) continue;
      const f = schema.byPath.get(full);
      if (schema.repeatSet.has(full)) {
        const items = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
        const t = tableOf(full);
        const list = tables[t] || (tables[t] = []);
        items.forEach((it, i) => {
          const child = { __id: `${row.__id}/${relPath}[${i + 1}]`, [parentKey(table)]: row.__id, __root: root.__id };
          fill(child, it, full, '', t);
          list.push(child);
        });
      } else if (Array.isArray(v)) {
        // a repeat the schema does not know: keep the first entry, so the values stay reachable
        if (v[0] && typeof v[0] === 'object') fill(row, v[0], full, relPath, table);
        else setPath(row, relPath, coerce(v.join(' '), f));
      } else if (v && typeof v === 'object' && !isValueObject(v) && (!f || f.type === 'structure')) {
        fill(row, v, full, relPath, table);
      } else {
        setPath(row, relPath, coerce(v, f));
      }
    }
  };
  fill(root, tree, '', '', 'Submissions');
  for (const t of schema.tables()) tables[t] ||= [];
  return tables;
}

// Merge the per-submission tables into one dataset { tables: {name: rows}, roots: [ids] }
function collect(records) {
  const out = { tables: {}, roots: [] };
  for (const r of records) {
    out.roots.push(r.Submissions[0].__id);
    for (const [t, rows] of Object.entries(r)) (out.tables[t] ||= []).push(...rows);
  }
  return out;
}

// XLSForm / pyxform JSON descriptor (IASO's form_descriptor) → fields + labels, like xform.js does for XML
const DESCRIPTOR_TYPES = {
  text: 'string', string: 'string', integer: 'int', int: 'int', decimal: 'decimal', range: 'decimal',
  date: 'date', datetime: 'dateTime', dateTime: 'dateTime', time: 'time', today: 'date', start: 'dateTime', end: 'dateTime',
  geopoint: 'geopoint', geotrace: 'geotrace', geoshape: 'geoshape', barcode: 'barcode',
  photo: 'binary', image: 'binary', audio: 'binary', video: 'binary', file: 'binary', 'background-audio': 'binary',
};
function descriptorSchema(desc) {
  const fields = [];
  const labels = { languages: [], defaultLang: '', fields: {}, choices: {} };
  const langs = new Set();
  const lab = l => {
    if (l == null || l === '') return null;
    if (typeof l === 'object') { const o = {}; for (const [k, v] of Object.entries(l)) { const key = k === 'default' ? '' : k; o[key] = String(v).replace(/<[^>]+>/g, '').trim(); if (key) langs.add(key); } return o; }
    return { '': String(l).replace(/<[^>]+>/g, '').trim() };
  };
  const listChoices = name => (desc.choices && desc.choices[name]) || null;
  const walk = (nodes, base) => {
    for (const n of nodes || []) {
      if (!n || !n.name) continue;
      const type = String(n.type || '').toLowerCase();
      if (type === 'note' || type === 'trigger') continue;
      const path = base ? `${base}/${n.name}` : n.name;
      const L = lab(n.label);
      if (L) labels.fields[path] = L;
      if (type === 'group' || type === 'repeat') {
        if (n.control?.bodyless && n.name === 'meta') { /* meta group: instanceID... */ }
        fields.push({ path, name: n.name, type: type === 'repeat' ? 'repeat' : 'structure', selectMultiple: false, repeat: type === 'repeat' });
        walk(n.children, path);
        continue;
      }
      const isSelect = /^select/.test(type) || type === 'rank';
      const multi = /all that apply|select_multiple|select multiple/.test(type);
      fields.push({ path, name: n.name, type: isSelect ? 'string' : DESCRIPTOR_TYPES[type] || 'string', selectMultiple: multi, repeat: false });
      if (isSelect) {
        const opts = Array.isArray(n.children) && n.children.length ? n.children : listChoices(n.itemset || n.list_name) || [];
        const map = {};
        for (const o of opts) if (o && o.name != null) map[String(o.name)] = lab(o.label) || {};
        if (Object.keys(map).length) labels.choices[path] = map;
      }
    }
  };
  walk(desc && desc.children, '');
  labels.languages = [...langs];
  const def = desc && desc.default_language && desc.default_language !== 'default' ? desc.default_language : '';
  labels.defaultLang = def && langs.has(def) ? def : labels.languages[0] || '';
  return { fields, labels };
}

module.exports = { Schema, explode, collect, coerce, setPath, tableOf, parentKey, descriptorSchema };
