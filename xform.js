// Reads question and choice labels out of an ODK XForm (the XML that pyxform builds from an XLSForm).
// No dependencies: includes a tiny, tolerant XML parser that is enough for XForms.
//
// Result:
// {
//   languages:   ['Français (fr)', 'English (en)'],   // itext translations ([] if the form has none)
//   defaultLang: 'Français (fr)' | '',
//   fields:  { 'household/water_source': { 'Français (fr)': 'Source d'eau', 'English (en)': 'Water source' } },
//   choices: { 'household/water_source': { borehole: { 'Français (fr)': 'Forage', ... }, ... } },
//   externals: [{ path, file, valueRef, labelRef }]   // select_one_from_file / entity lists (CSV attachments)
// }
// Untranslated labels are stored under the '' language key.

// ---------------------------------------------------------------- tiny XML parser
const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()]);

function parseXML(src) {
  const root = { name: '#root', local: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  const text = t => { if (t) top().children.push({ text: decode(t) }); };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { text(src.slice(i)); break; }
    if (lt > i) text(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? src.length : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt); const end = e < 0 ? src.length : e;
      top().children.push({ text: src.slice(lt + 9, end) }); i = end + 3; continue;
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? src.length : e + 1; continue; }
    // find end of tag, ignoring '>' inside quoted attribute values
    let j = lt + 1, q = null;
    for (; j < src.length; j++) {
      const c = src[j];
      if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '>') break;
    }
    const tag = src.slice(lt + 1, j);
    i = j + 1;
    if (tag[0] === '/') {
      const name = tag.slice(1).trim();
      // pop up to the matching element (tolerates small mistakes)
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const selfClose = tag.endsWith('/');
    const body = selfClose ? tag.slice(0, -1) : tag;
    const name = (body.match(/^[^\s/>]+/) || [''])[0];
    const attrs = {};
    for (const m of body.slice(name.length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[m[1]] = decode(m[3] ?? m[4] ?? '');
    const node = { name, local: name.split(':').pop(), attrs, children: [] };
    top().children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

const elements = n => (n.children || []).filter(c => c.name);
const child = (n, local) => n && elements(n).find(c => c.local === local);
function find(n, local) {
  if (!n) return null;
  if (n.local === local) return n;
  for (const c of elements(n)) { const r = find(c, local); if (r) return r; }
  return null;
}
function findAll(n, local, out = []) {
  if (!n || !n.name) return out;
  if (n.local === local) out.push(n);
  for (const c of elements(n)) findAll(c, local, out);
  return out;
}
// Text of a node; <output value="/data/x"/> becomes [x]; markup and markdown are stripped
function textOf(n) {
  if (!n) return '';
  let s = '';
  for (const c of n.children || []) {
    if (c.text != null) s += c.text;
    else if (c.local === 'output') s += '[' + String(c.attrs.value || '').trim().split('/').pop() + ']';
    else s += textOf(c);
  }
  return s.replace(/<[^>]+>/g, '').replace(/\*\*|__/g, '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- XForm → labels
const CONTROLS = new Set(['input', 'select1', 'select', 'rank', 'upload', 'trigger', 'range', 'group', 'repeat']);
const SELECTS = new Set(['select1', 'select', 'rank']);

function extractLabels(xml) {
  const doc = parseXML(String(xml || ''));
  const model = find(doc, 'model');
  const body = find(doc, 'body');
  const out = { languages: [], defaultLang: '', fields: {}, choices: {}, externals: [] };
  if (!model) return out;

  const instances = elements(model).filter(c => c.local === 'instance');
  const primary = instances.find(x => !x.attrs.id) || instances[0];
  const rootName = primary && elements(primary)[0] ? elements(primary)[0].name : 'data';

  // itext translations: id -> { lang: text }
  const T = {};
  const itext = child(model, 'itext');
  for (const tr of itext ? elements(itext).filter(c => c.local === 'translation') : []) {
    const lang = tr.attrs.lang || '';
    out.languages.push(lang);
    if (/true/i.test(tr.attrs.default || '') && !out.defaultLang) out.defaultLang = lang;
    for (const t of elements(tr).filter(c => c.local === 'text')) {
      const vals = elements(t).filter(c => c.local === 'value');
      const v = vals.find(x => !x.attrs.form) || vals.find(x => x.attrs.form === 'long') || vals.find(x => x.attrs.form === 'short');
      const s = textOf(v);
      if (s) (T[t.attrs.id] ||= {})[lang] = s;
    }
  }
  if (!out.defaultLang) out.defaultLang = out.languages[0] || '';

  const itextRef = ref => { const m = String(ref || '').match(/jr:itext\(\s*['"]([^'"]+)['"]\s*\)/); return m ? m[1] : null; };
  const labelOf = node => {
    const l = child(node, 'label');
    if (!l) return null;
    const id = itextRef(l.attrs.ref);
    if (id) return T[id] || null;
    const s = textOf(l);
    return s ? { '': s } : null;
  };
  const norm = (ref, base) => {
    let r = String(ref || '').trim();
    if (!r) return base;
    if (r.startsWith('/')) {
      r = r.replace(/^\/+/, '');
      const segs = r.split('/');
      if (segs[0] === rootName || segs[0].split(':').pop() === rootName.split(':').pop()) segs.shift();
      return segs.join('/');
    }
    return base ? `${base}/${r}` : r;
  };

  const parseChoices = (ctl, path) => {
    const map = {};
    for (const it of elements(ctl).filter(c => c.local === 'item')) {
      const v = textOf(child(it, 'value'));
      if (v !== '') map[v] = labelOf(it) || {};
    }
    const set = child(ctl, 'itemset');
    if (set) {
      const id = (String(set.attrs.nodeset || '').match(/instance\(\s*['"]([^'"]+)['"]\s*\)/) || [])[1];
      const inst = instances.find(x => x.attrs.id === id);
      const valueRef = child(set, 'value')?.attrs.ref || 'name';
      const labelNode = child(set, 'label');
      const labelRef = labelNode?.attrs.ref || 'label';
      if (inst && inst.attrs.src) {
        const file = decodeURIComponent(String(inst.attrs.src).split('/').pop());
        out.externals.push({ path, file, valueRef, labelRef });
      } else if (inst) {
        const itextField = (labelRef.match(/jr:itext\(\s*([^)\s]+)\s*\)/) || [])[1];
        for (const it of findAll(inst, 'item')) {
          const v = textOf(child(it, valueRef));
          if (v === '') continue;
          if (itextField) map[v] = T[textOf(child(it, itextField))] || {};
          else { const s = textOf(child(it, labelRef)); map[v] = s ? { '': s } : {}; }
        }
      }
    }
    return map;
  };

  const walk = (node, base) => {
    for (const c of elements(node)) {
      if (!CONTROLS.has(c.local)) { walk(c, base); continue; }
      const path = norm(c.attrs.ref || c.attrs.nodeset, base);
      const label = labelOf(c);
      if (path && label && !(c.local === 'repeat' && out.fields[path])) out.fields[path] = label;
      if (SELECTS.has(c.local) && path) {
        const ch = parseChoices(c, path);
        if (Object.keys(ch).length) out.choices[path] = ch;
      }
      if (c.local === 'group' || c.local === 'repeat') walk(c, path);
    }
  };
  if (body) walk(body, '');
  return out;
}

// ---------------------------------------------------------------- CSV attachments (select_one_from_file, entity lists)
function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}

// Returns { value: { lang: label } }. Columns "label" → '' and "label::French (fr)" → 'French (fr)'.
function csvChoices(csv, valueRef = 'name', labelRef = 'label') {
  const rows = parseCSV(csv);
  if (!rows.length) return {};
  const head = rows[0].map(h => h.trim());
  const vi = head.indexOf(valueRef);
  if (vi < 0) return {};
  const cols = [];
  head.forEach((h, i) => {
    if (h === labelRef) cols.push([i, '']);
    else if (h.startsWith(labelRef + '::')) cols.push([i, h.slice(labelRef.length + 2).trim()]);
  });
  const map = {};
  for (const r of rows.slice(1)) {
    const v = (r[vi] || '').trim();
    if (!v) continue;
    const l = {};
    for (const [i, lang] of cols) if (r[i]) l[lang] = r[i].trim();
    map[v] = l;
  }
  return map;
}

module.exports = { parseXML, extractLabels, csvChoices, parseCSV };
