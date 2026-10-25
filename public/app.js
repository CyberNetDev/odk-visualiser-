/* ODK Visualizer — frontend.
   Layout model follows the DHIS2 Data Visualizer: Columns (series) × Rows (category) + Filter,
   with a value (count / sum / avg / ...) aggregated in the browser from the ODK OData feed.
   Extra chart types are modelled on Apache Superset's gallery (big number + trendline, gauge,
   heatmap, treemap, sunburst, funnel, radar, box plot, histogram, scatter, calendar, sankey, rose). */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const EMPTY = '(vide)';
const SEP = ' · ';
const PERIODS = { day: 'Jour', week: 'Semaine', month: 'Mois', quarter: 'Trimestre', year: 'Année' };
const NUM_TYPES = ['int', 'decimal', 'range'];
const DATE_TYPES = ['date', 'dateTime', 'today', 'start', 'end'];
const PALETTE = ['#1565c0', '#f57c00', '#2e7d32', '#c62828', '#6a1b9a', '#00838f', '#ad1457', '#5d4037', '#9e9d24', '#455a64'];
const MONTHS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const SYSTEM_FIELDS = [
  { path: '__system/submissionDate', name: 'Date de soumission', type: 'dateTime', system: true },
  { path: '__system/submitterName', name: 'Enquêteur', type: 'string', system: true },
  { path: '__system/reviewState', name: 'État de revue', type: 'string', system: true },
  { path: '__system/deviceId', name: 'Appareil', type: 'string', system: true },
  { path: '__system/formVersion', name: 'Version du formulaire', type: 'string', system: true },
];

// Catalogue of visualizations. Groups follow Apache Superset's gallery categories.
// raw: works on individual values of a numeric field (not on an aggregate)
// noDims: can render without any field in Columns/Rows; needs: 'date' needs a date field
const VIS = [
  { id: 'column', label: 'Colonnes', group: 'Comparaison' },
  { id: 'stackedColumn', label: 'Colonnes empilées', group: 'Comparaison' },
  { id: 'radar', label: 'Radar', group: 'Comparaison', superset: true, hint: 'Lignes = axes du radar · Colonnes = séries comparées.' },
  { id: 'bar', label: 'Barres', group: 'Classement' },
  { id: 'stackedBar', label: 'Barres empilées', group: 'Classement' },
  { id: 'funnel', label: 'Entonnoir', group: 'Classement', superset: true, hint: 'Les catégories des Lignes, de la plus grande à la plus petite.' },
  { id: 'line', label: 'Courbe', group: 'Évolution' },
  { id: 'area', label: 'Aires empilées', group: 'Évolution' },
  { id: 'calendar', label: 'Calendrier (carte de chaleur)', group: 'Évolution', superset: true, needs: 'date', noDims: true, hint: 'Valeur par jour. Utilise le premier champ date des Lignes/Colonnes, sinon la date de soumission.' },
  { id: 'pie', label: 'Secteurs', group: "Partie d'un tout" },
  { id: 'rose', label: 'Rose de Nightingale', group: "Partie d'un tout", superset: true },
  { id: 'treemap', label: 'Treemap', group: "Partie d'un tout", superset: true, hint: 'Les champs des Lignes puis des Colonnes forment les niveaux de la hiérarchie.' },
  { id: 'sunburst', label: 'Sunburst', group: "Partie d'un tout", superset: true, hint: 'Les champs des Lignes puis des Colonnes forment les anneaux, du centre vers l\'extérieur.' },
  { id: 'heatmap', label: 'Carte de chaleur', group: 'Corrélation', superset: true, hint: 'Lignes = axe vertical · Colonnes = axe horizontal · la couleur indique la valeur.' },
  { id: 'scatter', label: 'Nuage de points', group: 'Corrélation', superset: true, raw: true, hint: 'Un champ numérique en Lignes (axe X) et un champ numérique en Valeur (axe Y). Un champ en Colonnes colore les points.' },
  { id: 'boxplot', label: 'Boîte à moustaches', group: 'Distribution', superset: true, raw: true, hint: 'Distribution d\'un champ numérique (Valeur) pour chaque catégorie des Lignes ; les Colonnes séparent les séries.' },
  { id: 'histogram', label: 'Histogramme', group: 'Distribution', superset: true, raw: true, hint: 'Distribution d\'un champ numérique (Valeur) ; un champ en Colonnes ou Lignes sépare les séries.' },
  { id: 'sankey', label: 'Sankey (flux)', group: 'Flux', superset: true, hint: 'Au moins deux champs (Lignes puis Colonnes) : chaque champ est une étape du flux.' },
  { id: 'single', label: 'Grand nombre', group: 'KPI', noDims: true },
  { id: 'bigNumberTrend', label: 'Grand nombre + tendance', group: 'KPI', superset: true, needs: 'date', noDims: true, hint: 'Valeur de la dernière période et son évolution. Utilise le premier champ date (sinon la date de soumission).' },
  { id: 'gauge', label: 'Jauge', group: 'KPI', superset: true, noDims: true, hint: 'Valeur totale sur une jauge ; renseignez la Cible pour fixer le maximum.' },
  { id: 'pivot', label: 'Tableau croisé', group: 'Tableau' },
  { id: 'map', label: 'Carte (points GPS)', group: 'Carte', noDims: true },
];

let state = blankState();
let allFields = [];      // fields from ODK for the current form
let fields = [];         // fields usable for the current table (incl. joined parent fields)
let fieldMap = new Map();
let tables = [];         // OData tables of the form
let labels = null;       // { languages, defaultLang, fields, choices } from the XForm
let data = [];           // rows of the current table (with __parent links for repeats)
let chart = null, map = null;
let lastResult = null, lastFiltered = [];

function blankState() {
  return {
    id: null, name: '', title: '', type: 'column',
    projectId: null, formId: null, table: 'Submissions', from: '', to: '', reviewState: '',
    columns: [], rows: [], filters: [],
    measure: { agg: 'count', field: '' },
    options: { showValues: false, lang: '', hideEmpty: false, sort: 'label', limit: 0, target: 0 },
  };
}

// ------------------------------------------------------------------ API
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && body.relogin) showLogin(path === '/api/me' ? '' : (body.error || 'Session expirée, reconnectez-vous.'), 'info');
    const err = new Error(body.error || `Erreur (${res.status})`); err.status = res.status; throw err;
  }
  return body;
}

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => (t.hidden = true), err ? 6000 : 2500);
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ labels (XLSForm) & field helpers
const get = (obj, path) => path.split('/').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const rawLabels = () => state.options.lang === '__raw';
function pick(map) {
  if (!map || rawLabels()) return null;
  const want = state.options.lang || labels?.defaultLang || '';
  return map[want] ?? map[labels?.defaultLang ?? ''] ?? map[''] ?? Object.values(map)[0] ?? null;
}
function tidy(s) {
  if (rawLabels() || s === EMPTY) return String(s);
  return String(s).replace(/_/g, ' ').replace(/^\p{Ll}/u, c => c.toUpperCase());
}
const choicesOf = f => (f && f.labelPath && labels?.choices?.[f.labelPath]) || null;
const kindOf = f => !f ? 'text'
  : ['geopoint', 'geotrace', 'geoshape'].includes(f.type) ? 'geo'
  : NUM_TYPES.includes(f.type) ? 'num'
  : DATE_TYPES.includes(f.type) ? 'date'
  : f.selectMultiple ? 'multi'
  : f.type === 'select1' || f.type === 'select' || choicesOf(f) ? 'sel' : 'text';
const TYPE_TAG = { num: ['123', 'num'], date: ['DATE', 'date'], multi: ['MULTI', 'sel'], sel: ['UN', 'sel'], geo: ['GPS', 'geo'], text: ['ABC', ''] };

function fieldLabel(f) {
  if (!f) return '';
  if (f.system) return f.name;
  return pick(labels?.fields?.[f.labelPath]) || tidy(f.name);
}
function valueLabel(dim, v) {
  if (v === EMPTY) return v;
  const f = dim && fieldMap.get(dim.path);
  if (!f) return tidy(v);
  if (kindOf(f) === 'date') return v;
  const ch = choicesOf(f);
  const one = x => (ch && pick(ch[x])) || tidy(x);
  if (f.selectMultiple && dim.split === false) return String(v).split(/\s+/).filter(Boolean).map(one).join(', ');
  return one(v);
}
const keyLabel = (key, dims) => (dims && dims.length ? String(key).split(SEP).map((p, i) => valueLabel(dims[i], p)).join(SEP) : String(key));
const groupLabel = path => pick(labels?.fields?.[path]) || tidy(path.split('/').pop());
const repeatPath = t => t.replace(/^Submissions\.?/, '').replace(/\./g, '/');
function tableLabel(t) {
  if (t === 'Submissions') return 'Soumission';
  // show the chain of repeats only (groups are part of the path but are not tables)
  const chain = tables.filter(x => x !== 'Submissions' && (t === x || t.startsWith(x + '.')));
  return chain.map(x => groupLabel(repeatPath(x))).join(' › ') || groupLabel(repeatPath(t));
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-S${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
function periodKey(v, p) {
  const d = new Date(v.length === 10 ? v + 'T00:00:00Z' : v);
  if (isNaN(d)) return EMPTY;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  switch (p) {
    case 'day': return d.toISOString().slice(0, 10);
    case 'week': return isoWeek(d);
    case 'quarter': return `${y}-T${Math.ceil(m / 3)}`;
    case 'year': return String(y);
    default: return `${y}-${String(m).padStart(2, '0')}`;
  }
}

// All values a row contributes for a dimension (array: select-multiple fields can yield several)
function dimValues(row, dim) {
  const f = fieldMap.get(dim.path);
  const v = get(row, dim.path);
  let out;
  if (v == null || v === '') out = [EMPTY];
  else if (kindOf(f) === 'date') out = [periodKey(String(v), dim.period || 'month')];
  else if (f && f.selectMultiple && dim.split !== false) out = String(v).split(/\s+/).filter(Boolean);
  else if (typeof v === 'object') out = [JSON.stringify(v)];
  else out = [String(v)];
  if (dim.values && dim.values.length) out = out.filter(x => dim.values.includes(x));
  return out;
}
const cartesian = lists => lists.reduce((acc, l) => acc.flatMap(a => l.map(b => [...a, b])), [[]]);
const passesFilters = r => state.filters.every(d => !d.values || !d.values.length || dimValues(r, d).length);
const numVal = path => r => { const x = get(r, path); if (x == null || x === '') return null; const n = Number(x); return isNaN(n) ? null : n; };

// Order keys like the form: choice order from the XLSForm, otherwise natural order; (vide) last
function compareKeys(dims) {
  const orders = dims.map(d => { const ch = choicesOf(fieldMap.get(d.path)); return ch ? Object.keys(ch) : null; });
  const natural = (a, b) => a.localeCompare(b, 'fr', { numeric: true });
  return (A, B) => {
    const a = String(A).split(SEP), b = String(B).split(SEP);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      if (a[i] === EMPTY || b[i] === EMPTY) return (a[i] === EMPTY) - (b[i] === EMPTY);
      const o = orders[i];
      if (o) { const ia = o.indexOf(a[i]), ib = o.indexOf(b[i]); if (ia !== ib) return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib); }
      return natural(a[i] ?? '', b[i] ?? '');
    }
    return 0;
  };
}

// ------------------------------------------------------------------ aggregation engine
function newAcc() { return { n: 0, sum: 0, cnt: 0, min: Infinity, max: -Infinity }; }
function addAcc(a, x) {
  a.n++;
  if (x != null && !isNaN(x)) { a.sum += x; a.cnt++; if (x < a.min) a.min = x; if (x > a.max) a.max = x; }
}
function accValue(a, agg) {
  if (!a) return null;
  switch (agg) {
    case 'count': case 'pct': return a.n;
    case 'sum': return a.cnt ? a.sum : null;
    case 'avg': return a.cnt ? a.sum / a.cnt : null;
    case 'min': return a.cnt ? a.min : null;
    case 'max': return a.cnt ? a.max : null;
  }
}

// o: { rows, columns, sort, limit, hideEmpty } overrides (defaults come from the layout)
function aggregate(o = {}) {
  const measure = state.measure;
  const rows = o.rows ?? (state.rows.length ? state.rows : state.columns);
  const columns = o.columns ?? (state.rows.length ? state.columns : []);
  const sort = o.sort ?? state.options.sort, limit = o.limit ?? state.options.limit, hideEmpty = o.hideEmpty ?? state.options.hideEmpty;
  const filtered = data.filter(passesFilters);
  const needsField = !['count', 'pct'].includes(measure.agg);
  const getX = needsField ? numVal(measure.field) : () => null;
  const cells = new Map(), rowTot = new Map(), colTot = new Map(), grand = newAcc();
  const rowKeys = new Set(), colKeys = new Set();

  for (const r of filtered) {
    const rk = cartesian(rows.map(d => dimValues(r, d))).map(k => k.join(SEP));
    const ck = cartesian(columns.map(d => dimValues(r, d))).map(k => k.join(SEP));
    if (!rk.length || !ck.length) continue;
    const x = getX(r);
    for (const a of rk) {
      rowKeys.add(a);
      for (const b of ck) {
        colKeys.add(b);
        const key = a + '\u0001' + b;
        if (!cells.has(key)) cells.set(key, newAcc());
        addAcc(cells.get(key), x);
      }
    }
    // totals count each row once per key (not per cell) so averages stay honest
    for (const a of rk) { if (!rowTot.has(a)) rowTot.set(a, newAcc()); addAcc(rowTot.get(a), x); }
    for (const b of ck) { if (!colTot.has(b)) colTot.set(b, newAcc()); addAcc(colTot.get(b), x); }
    addAcc(grand, x);
  }

  let R = [...rowKeys], C = [...colKeys];
  if (hideEmpty) {
    R = R.filter(k => !k.split(SEP).includes(EMPTY));
    C = C.filter(k => !k.split(SEP).includes(EMPTY));
  }
  C.sort(compareKeys(columns));
  const rv = k => accValue(rowTot.get(k), measure.agg) ?? -Infinity;
  if (sort === 'desc') R.sort((a, b) => rv(b) - rv(a));
  else if (sort === 'asc') R.sort((a, b) => rv(a) - rv(b));
  else R.sort(compareKeys(rows));
  if (limit > 0) R = R.slice(0, limit);

  const total = grand.n;
  const val = acc => {
    const v = accValue(acc, measure.agg);
    if (v == null) return null;
    return measure.agg === 'pct' ? (total ? (100 * v) / total : 0) : v;
  };
  return {
    rowKeys: R, colKeys: C, rowDims: rows, colDims: columns, hasSeries: columns.length > 0,
    matrix: R.map(a => C.map(b => val(cells.get(a + '\u0001' + b)))),
    rowTotals: R.map(a => val(rowTot.get(a))),
    colTotals: C.map(b => val(colTot.get(b))),
    grandTotal: val(grand),
    filtered,
  };
}

// Raw values of a numeric field grouped by row × column keys (box plot, histogram)
function groupRaw(rowDims, colDims, valueOf) {
  const cells = new Map(), rk = new Set(), ck = new Set();
  for (const r of data) {
    if (!passesFilters(r)) continue;
    const v = valueOf(r);
    if (v == null) continue;
    for (const a of cartesian(rowDims.map(d => dimValues(r, d))).map(k => k.join(SEP))) {
      for (const b of cartesian(colDims.map(d => dimValues(r, d))).map(k => k.join(SEP))) {
        rk.add(a); ck.add(b);
        const key = a + '\u0001' + b;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(v);
      }
    }
  }
  const clean = (keys, dims) => {
    let k = [...keys];
    if (state.options.hideEmpty) k = k.filter(x => !x.split(SEP).includes(EMPTY));
    return k.sort(compareKeys(dims));
  };
  let R = clean(rk, rowDims);
  if (state.options.limit > 0) R = R.slice(0, state.options.limit);
  return { rowKeys: R, colKeys: clean(ck, colDims), cell: (a, b) => cells.get(a + '\u0001' + b) || [] };
}

function measureLabel() {
  const { agg, field } = state.measure;
  const name = fieldLabel(fieldMap.get(field));
  return { count: 'Nombre', pct: '% du total', sum: `Somme · ${name}`, avg: `Moyenne · ${name}`, min: `Min. · ${name}`, max: `Max. · ${name}` }[agg];
}
const fmtNum = v => v == null || isNaN(v) ? '' : Number.isInteger(v) ? v.toLocaleString('fr-FR') : v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
const fmt = v => v == null ? '' : state.measure.agg === 'pct' ? v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' %' : fmtNum(v);
const fmtCompact = v => Math.abs(v) >= 1e6 ? (v / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' M' : Math.abs(v) >= 1e4 ? (v / 1e3).toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' k' : fmt(v);
function niceCeil(x) { if (!(x > 0)) return 1; const p = 10 ** Math.floor(Math.log10(x)); return Math.ceil(x / p) * p; }
function niceStep(x) { if (!(x > 0)) return 1; const p = 10 ** Math.floor(Math.log10(x)); const f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; }

// ------------------------------------------------------------------ rendering
const visDef = () => VIS.find(v => v.id === state.type) || VIS[0];
function dateDim() {
  const d = [...state.rows, ...state.columns].find(x => kindOf(fieldMap.get(x.path)) === 'date');
  if (d) return d;
  const f = fields.find(x => x.path.endsWith('__system/submissionDate')) || fields.find(x => kindOf(x) === 'date');
  return f ? { path: f.path, period: 'month' } : null;
}

function readiness() {
  const v = visDef();
  const hint = v.hint ? `<span>${esc(v.hint)}</span>` : '';
  if (!state.formId) return '<strong>Choisissez un formulaire.</strong>';
  if (!data.length) return '<strong>Aucune donnée pour cette sélection.</strong><span>Vérifiez la période ou le filtre d\'état de revue.</span>';
  if (v.raw && !state.measure.field) return `<strong>Choisissez un champ numérique pour la Valeur.</strong>${hint}`;
  if (!v.raw && !['count', 'pct'].includes(state.measure.agg) && !state.measure.field) return '<strong>Choisissez un champ numérique pour la valeur.</strong>';
  if (v.needs === 'date' && !dateDim()) return `<strong>Ce type a besoin d'un champ date.</strong>${hint}`;
  if (state.type === 'scatter' && kindOf(fieldMap.get(state.rows[0]?.path)) !== 'num') return `<strong>Placez un champ numérique en Lignes (axe X).</strong>${hint}`;
  if (state.type === 'sankey' && state.rows.length + state.columns.length < 2) return `<strong>Placez au moins deux champs.</strong>${hint}`;
  if (!v.noDims && !v.raw && !state.rows.length && !state.columns.length) {
    return `<strong>Glissez des champs dans la mise en page.</strong>${hint || '<span>Exemple : <em>région</em> en Lignes et <em>date de soumission</em> (mois) en Colonnes.</span>'}`;
  }
  return null;
}

function render() {
  syncControls();
  renderZones();
  renderFieldList();
  const canvas = $('#canvas');
  if (chart) { chart.dispose(); chart = null; }
  if (map) { map.remove(); map = null; }
  canvas.innerHTML = '';
  lastResult = null; lastFiltered = [];
  const msg = readiness();
  $('#empty').innerHTML = msg || '';
  $('#empty').hidden = !msg;
  if (msg) return;
  lastFiltered = data.filter(passesFilters);
  try {
    (RENDERERS[state.type] || renderCartesian)(canvas);
  } catch (e) {
    console.error(e);
    canvas.innerHTML = `<div class="single"><span class="sub">Impossible d'afficher ce graphique : ${esc(e.message)}</span></div>`;
  }
}

const noData = canvas => (canvas.innerHTML = '<div class="single"><span class="sub">Aucune donnée ne correspond à la sélection.</span></div>');

function makeChart(canvas, height) {
  const el = document.createElement('div');
  el.className = 'chart';
  if (height) el.style.height = height + 'px';
  canvas.appendChild(el);
  chart = echarts.init(el);
  return chart;
}
function setOption(option) {
  chart.setOption({ color: PALETTE, animationDuration: 300, animationDurationUpdate: 200, textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' }, ...option });
}
const legendBottom = show => ({ show, type: 'scroll', bottom: 0 });

// ---- classic cartesian charts: column, stacked column, bar, stacked bar, line, area
function renderCartesian(canvas) {
  const res = aggregate(); lastResult = res;
  if (!res.rowKeys.length) return noData(canvas);
  const t = state.type;
  const cats = res.rowKeys.map(k => keyLabel(k, res.rowDims));
  const names = res.hasSeries ? res.colKeys.map(k => keyLabel(k, res.colDims)) : [measureLabel()];
  const horizontal = t === 'bar' || t === 'stackedBar';
  const stack = t.startsWith('stacked') || t === 'area' ? 'total' : undefined;
  const type = t === 'line' || t === 'area' ? 'line' : 'bar';
  const series = names.map((name, j) => ({
    name, type, stack, data: res.matrix.map(r => r[j]),
    label: { show: state.options.showValues, formatter: p => fmt(p.value), position: stack ? 'inside' : horizontal ? 'right' : 'top', fontSize: 11 },
    areaStyle: t === 'area' ? { opacity: 0.6 } : undefined, symbolSize: 6, barMaxWidth: 48, emphasis: { focus: 'series' },
  }));
  const cat = { type: 'category', data: cats, axisLabel: { interval: 0, rotate: !horizontal && cats.length > 8 ? 40 : 0, width: 150, overflow: 'truncate' } };
  const valAx = { type: 'value', axisLabel: { formatter: v => fmtCompact(v) } };
  makeChart(canvas);
  setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: type === 'bar' ? 'shadow' : 'line' }, valueFormatter: fmt },
    legend: legendBottom(series.length > 1),
    grid: { left: 12, right: 24, top: 24, bottom: series.length > 1 ? 44 : 16, containLabel: true },
    xAxis: horizontal ? valAx : { ...cat, boundaryGap: type === 'bar' }, yAxis: horizontal ? { ...cat, inverse: true } : valAx,
    series,
  });
}

// ---- pie & Nightingale rose
function renderPie(canvas) {
  const res = aggregate({ columns: [] }); lastResult = res;
  if (!res.rowKeys.length) return noData(canvas);
  const rose = state.type === 'rose';
  makeChart(canvas);
  setOption({
    tooltip: { trigger: 'item', formatter: p => `${esc(p.name)}<br><b>${fmt(p.value)}</b> (${p.percent} %)` },
    legend: legendBottom(true),
    series: [{
      type: 'pie', radius: rose ? ['12%', '72%'] : ['35%', '68%'], roseType: rose ? 'area' : undefined,
      itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: rose ? 4 : 0 },
      data: res.rowKeys.map((k, i) => ({ name: keyLabel(k, res.rowDims), value: res.rowTotals[i] })),
      label: { formatter: state.options.showValues ? '{b} : {d} %' : '{b}' },
    }],
  });
}

// ---- pivot table
function renderPivot(canvas) {
  const res = aggregate(); lastResult = res;
  if (!res.rowKeys.length) return noData(canvas);
  const colHead = res.hasSeries ? res.colKeys.map(k => keyLabel(k, res.colDims)) : [measureLabel()];
  const rowHeadLabel = res.rowDims.map(d => fieldLabel(fieldMap.get(d.path))).join(SEP);
  let h = '<table class="pivot"><thead><tr><th>' + esc(rowHeadLabel) + '</th>';
  for (const c of colHead) h += `<th>${esc(c)}</th>`;
  if (res.hasSeries) h += '<th>Total</th>';
  h += '</tr></thead><tbody>';
  const max = Math.max(...res.matrix.flat().filter(v => v != null), 1);
  res.rowKeys.forEach((rk, i) => {
    h += `<tr><th>${esc(keyLabel(rk, res.rowDims))}</th>`;
    res.matrix[i].forEach(v => {
      const a = v == null ? 0 : (v / max) * 0.35;
      h += `<td style="background:rgba(21,101,192,${a.toFixed(3)})">${fmt(v)}</td>`;
    });
    if (res.hasSeries) h += `<td class="total">${fmt(res.rowTotals[i])}</td>`;
    h += '</tr>';
  });
  h += '<tr class="total"><th>Total</th>';
  (res.hasSeries ? res.colTotals : [res.grandTotal]).forEach(v => (h += `<td>${fmt(v)}</td>`));
  if (res.hasSeries) h += `<td>${fmt(res.grandTotal)}</td>`;
  canvas.innerHTML = h + '</tr></tbody></table>';
}

// ---- KPI: big number
function renderSingle(canvas) {
  const res = aggregate(); lastResult = res;
  canvas.innerHTML = `<div class="single"><div class="big">${fmt(res.grandTotal)}</div><div class="sub">${esc(measureLabel())} · ${res.filtered.length.toLocaleString('fr-FR')} enregistrements</div></div>`;
}

// ---- KPI: big number with trendline (Superset "Big Number with Trendline")
function renderBigNumberTrend(canvas) {
  const dd = dateDim();
  const res = aggregate({ rows: [{ ...dd, values: null }], columns: [], sort: 'label', limit: 0, hideEmpty: true }); lastResult = res;
  if (!res.rowKeys.length) return noData(canvas);
  const keys = res.rowKeys, vals = res.rowTotals;
  const last = vals[vals.length - 1], prev = vals.length > 1 ? vals[vals.length - 2] : null;
  const delta = prev ? ((last - prev) / Math.abs(prev)) * 100 : null;
  const total = aggregate({ rows: [], columns: [] }).grandTotal;
  canvas.innerHTML = `<div class="bignum">
    <div class="bn-label">${esc(measureLabel())} · ${esc(fieldLabel(fieldMap.get(dd.path)))} ${esc(keys.at(-1))}</div>
    <div class="big">${fmt(last)}</div>
    ${delta != null ? `<div class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} % par rapport à ${esc(keys.at(-2))}</div>` : ''}
    <div class="sub">Total sur toute la période : <b>${fmt(total)}</b></div>
    <div class="spark"></div></div>`;
  chart = echarts.init($('.spark', canvas));
  setOption({
    grid: { left: 28, right: 28, top: 10, bottom: 4, containLabel: true },
    tooltip: { trigger: 'axis', valueFormatter: fmt },
    xAxis: { type: 'category', data: keys, boundaryGap: false, axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: '#919eab', fontSize: 11, hideOverlap: true } },
    yAxis: { type: 'value', show: false, scale: true },
    series: [{ type: 'line', data: vals, smooth: true, symbol: 'none', lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.12 } }],
  });
}

// ---- KPI: gauge
function renderGauge(canvas) {
  const res = aggregate({ rows: [], columns: [] }); lastResult = res;
  const v = res.grandTotal ?? 0;
  const target = state.options.target > 0 ? state.options.target : 0;
  const max = target || (state.measure.agg === 'pct' ? 100 : niceCeil(v * 1.2));
  makeChart(canvas);
  setOption({
    series: [{
      type: 'gauge', min: 0, max, startAngle: 210, endAngle: -30, radius: '88%', center: ['50%', '58%'],
      progress: { show: true, width: 20, roundCap: true }, axisLine: { roundCap: true, lineStyle: { width: 20, color: [[1, '#e6ebf1']] } },
      pointer: { show: true, length: '55%', width: 5, itemStyle: { color: '#263238' } }, anchor: { show: true, size: 12, itemStyle: { color: '#263238' } },
      splitNumber: 5, axisTick: { distance: -28, length: 5, lineStyle: { color: '#919eab' } }, splitLine: { distance: -32, length: 12, lineStyle: { color: '#919eab' } },
      axisLabel: { distance: 44, color: '#637381', fontSize: 11, formatter: x => fmtCompact(x) },
      title: { offsetCenter: [0, '72%'], fontSize: 13, color: '#637381' },
      detail: { valueAnimation: true, offsetCenter: [0, '40%'], fontSize: 34, fontWeight: 700, color: '#1f2933', formatter: x => fmt(x) },
      data: [{ value: v, name: measureLabel() + (target ? `  ·  ${Math.round((v / target) * 100)} % de la cible (${fmt(target)})` : '') }],
    }],
  });
}

// ---- heatmap (rows × columns)
function renderHeatmap(canvas) {
  const res = aggregate(); lastResult = res;
  if (!res.rowKeys.length) return noData(canvas);
  const xs = res.hasSeries ? res.colKeys.map(k => keyLabel(k, res.colDims)) : [measureLabel()];
  const ys = res.rowKeys.map(k => keyLabel(k, res.rowDims));
  const cells = []; let mn = Infinity, mx = -Infinity;
  res.matrix.forEach((row, i) => row.forEach((v, j) => { if (v == null) return; cells.push([j, i, v]); mn = Math.min(mn, v); mx = Math.max(mx, v); }));
  // dark text on light cells, white text on dark cells
  const items = cells.map(c => ({ value: c, label: { color: mx > mn && (c[2] - mn) / (mx - mn) > 0.5 ? '#fff' : '#1f2933' } }));
  makeChart(canvas, Math.max(380, ys.length * 30 + 130));
  setOption({
    tooltip: { formatter: p => `${esc(ys[p.value[1]])}${SEP}${esc(xs[p.value[0]])}<br><b>${fmt(p.value[2])}</b>` },
    grid: { left: 12, right: 24, top: 12, bottom: 64, containLabel: true },
    xAxis: { type: 'category', data: xs, splitArea: { show: true }, axisLabel: { interval: 0, rotate: xs.length > 8 ? 40 : 0, width: 120, overflow: 'truncate' } },
    yAxis: { type: 'category', data: ys, inverse: true, splitArea: { show: true }, axisLabel: { width: 160, overflow: 'truncate' } },
    visualMap: { min: mn === Infinity ? 0 : mn, max: mx === -Infinity ? 1 : mx, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, itemWidth: 12, inRange: { color: ['#e3eefb', '#64a0e3', '#1565c0', '#0b2e59'] }, formatter: v => fmtCompact(v) },
    series: [{
      type: 'heatmap', data: items,
      label: { show: state.options.showValues || cells.length <= 160, formatter: p => fmt(p.value[2]), fontSize: 12, fontWeight: 600 },
      itemStyle: { borderColor: '#fff', borderWidth: 1 }, emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,.3)' } },
    }],
  });
}

// ---- treemap & sunburst: Rows then Columns become the levels of the hierarchy
function hierarchy() {
  const dims = [...state.rows, ...state.columns];
  const res = aggregate({ rows: dims, columns: [], sort: state.options.sort, limit: 0 }); lastResult = res;
  const root = { children: [] }, idx = new Map();
  res.rowKeys.forEach((k, i) => {
    let node = root, acc = '';
    k.split(SEP).forEach((p, lvl) => {
      acc += (lvl ? SEP : '') + p;
      let ch = idx.get(acc);
      if (!ch) { ch = { name: valueLabel(dims[lvl], p), children: [] }; idx.set(acc, ch); node.children.push(ch); }
      node = ch;
    });
    node.value = res.rowTotals[i];
  });
  const clean = n => { if (n.children && !n.children.length) delete n.children; else (n.children || []).forEach(clean); };
  clean(root);
  return { tree: root.children || [], depth: dims.length };
}
const pathTooltip = p => `${(p.treePathInfo || []).slice(1).map(x => esc(x.name)).join(' › ')}<br><b>${fmt(p.value)}</b>`;
function renderTreemap(canvas) {
  const { tree, depth } = hierarchy();
  if (!tree.length) return noData(canvas);
  makeChart(canvas, 460);
  setOption({
    tooltip: { formatter: pathTooltip },
    series: [{
      type: 'treemap', name: measureLabel(), data: tree, roam: false, nodeClick: 'zoomToNode', leafDepth: depth > 2 ? 2 : undefined,
      top: 8, left: 4, right: 4, bottom: 34, breadcrumb: { show: true, bottom: 4 },
      label: { show: true, formatter: p => `${p.name}\n${fmt(p.value)}`, fontSize: 12, lineHeight: 16 },
      upperLabel: { show: depth > 1, height: 22, color: '#fff', fontWeight: 600 },
      levels: [
        { itemStyle: { borderColor: '#fff', borderWidth: 3, gapWidth: 3 } },
        { colorSaturation: [0.35, 0.6], itemStyle: { borderColorSaturation: 0.6, gapWidth: 2, borderWidth: 2 } },
        { colorSaturation: [0.3, 0.5], itemStyle: { borderColorSaturation: 0.7, gapWidth: 1, borderWidth: 1 } },
      ],
    }],
  });
}
function renderSunburst(canvas) {
  const { tree } = hierarchy();
  if (!tree.length) return noData(canvas);
  makeChart(canvas, 480);
  setOption({
    tooltip: { formatter: pathTooltip },
    series: [{
      type: 'sunburst', name: measureLabel(), data: tree, radius: ['10%', '92%'], sort: null, nodeClick: 'rootToNode',
      itemStyle: { borderColor: '#fff', borderWidth: 1.5 }, emphasis: { focus: 'ancestor' },
      label: { rotate: 'radial', minAngle: 6, overflow: 'truncate', width: 90, fontSize: 11, formatter: p => state.options.showValues ? `${p.name} ${fmt(p.value)}` : p.name },
    }],
  });
}

// ---- funnel
function renderFunnel(canvas) {
  const res = aggregate({ columns: [] }); lastResult = res;
  const items = res.rowKeys.map((k, i) => ({ name: keyLabel(k, res.rowDims), value: res.rowTotals[i] })).filter(x => x.value > 0);
  if (!items.length) return noData(canvas);
  makeChart(canvas, Math.max(380, items.length * 42 + 40));
  setOption({
    tooltip: { trigger: 'item', formatter: p => `${esc(p.name)}<br><b>${fmt(p.value)}</b>` },
    series: [{
      type: 'funnel', left: '12%', right: '12%', top: 16, bottom: 16, minSize: '6%', sort: 'descending', gap: 2,
      label: { show: true, position: 'inside', formatter: p => `${p.name}  ${fmt(p.value)}`, color: '#fff', fontSize: 12, textBorderColor: 'rgba(0,0,0,.25)', textBorderWidth: 2 },
      itemStyle: { borderColor: '#fff', borderWidth: 1 }, data: items,
    }],
  });
}

// ---- radar
function renderRadar(canvas) {
  const res = aggregate({ sort: 'label' }); lastResult = res;
  if (!res.rowKeys.length) return noData(canvas);
  const keys = res.rowKeys.slice(0, 30);
  const names = res.hasSeries ? res.colKeys.map(k => keyLabel(k, res.colDims)) : [measureLabel()];
  const mx = Math.max(...res.matrix.flat().filter(v => v != null), 1) * 1.1;
  makeChart(canvas, 460);
  setOption({
    tooltip: { trigger: 'item' },
    legend: legendBottom(names.length > 1),
    radar: { indicator: keys.map(k => ({ name: keyLabel(k, res.rowDims), max: mx })), radius: '66%', center: ['50%', '48%'], axisName: { color: '#454f5b', fontSize: 12 }, splitArea: { areaStyle: { color: ['#fff', '#f6f8fa'] } } },
    series: [{ type: 'radar', symbolSize: 5, data: names.map((n, j) => ({ name: n, value: keys.map((_, i) => res.matrix[i][j] ?? 0), areaStyle: { opacity: 0.12 } })) }],
  });
}

// ---- box plot (Superset "Box Plot")
function quantile(sorted, p) {
  const pos = (sorted.length - 1) * p, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function renderBoxplot(canvas) {
  const field = state.measure.field;
  const g = groupRaw(state.rows, state.columns, numVal(field));
  if (!g.rowKeys.length) return noData(canvas);
  const cats = state.rows.length ? g.rowKeys.map(k => keyLabel(k, state.rows)) : [fieldLabel(fieldMap.get(field))];
  const series = [];
  g.colKeys.forEach((ck, j) => {
    const name = state.columns.length ? keyLabel(ck, state.columns) : fieldLabel(fieldMap.get(field));
    const boxes = [], outliers = [];
    g.rowKeys.forEach((rk, i) => {
      const vals = g.cell(rk, ck).slice().sort((a, b) => a - b);
      if (!vals.length) { boxes.push({ value: [] }); return; }
      const q1 = quantile(vals, 0.25), q2 = quantile(vals, 0.5), q3 = quantile(vals, 0.75), iqr = q3 - q1;
      const low = vals.find(v => v >= q1 - 1.5 * iqr), high = [...vals].reverse().find(v => v <= q3 + 1.5 * iqr);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      boxes.push({ value: [low, q1, q2, q3, high], n: vals.length, mean });
      vals.filter(v => v < low || v > high).slice(0, 300).forEach(v => outliers.push([i, v]));
    });
    series.push({ name, type: 'boxplot', data: boxes, itemStyle: { color: PALETTE[j % PALETTE.length] + '33', borderColor: PALETTE[j % PALETTE.length], borderWidth: 1.5 } });
    if (outliers.length) series.push({ name, type: 'scatter', data: outliers, symbolSize: 5, itemStyle: { color: PALETTE[j % PALETTE.length], opacity: 0.6 } });
  });
  makeChart(canvas);
  setOption({
    tooltip: {
      trigger: 'item', formatter: p => {
        if (p.seriesType === 'scatter') return `${esc(cats[p.value[0]])}<br>Valeur atypique : <b>${fmtNum(p.value[1])}</b>`;
        const d = p.data; if (!d.value.length) return '';
        return `${esc(p.name)}${g.colKeys.length > 1 ? SEP + esc(p.seriesName) : ''}<br>Max : ${fmtNum(d.value[4])}<br>Q3 : ${fmtNum(d.value[3])}<br><b>Médiane : ${fmtNum(d.value[2])}</b><br>Q1 : ${fmtNum(d.value[1])}<br>Min : ${fmtNum(d.value[0])}<br>Moyenne : ${fmtNum(d.mean)} · n = ${d.n.toLocaleString('fr-FR')}`;
      },
    },
    legend: legendBottom(g.colKeys.length > 1),
    grid: { left: 12, right: 24, top: 24, bottom: g.colKeys.length > 1 ? 44 : 16, containLabel: true },
    xAxis: { type: 'category', data: cats, axisLabel: { interval: 0, rotate: cats.length > 8 ? 40 : 0, width: 140, overflow: 'truncate' } },
    yAxis: { type: 'value', name: fieldLabel(fieldMap.get(field)), nameTextStyle: { align: 'left' }, scale: true, axisLabel: { formatter: v => fmtCompact(v) } },
    series,
  });
}

// ---- histogram
function renderHistogram(canvas) {
  const field = state.measure.field;
  const sdims = state.columns.length ? state.columns : state.rows;
  const g = groupRaw(sdims, [], numVal(field));
  const all = g.rowKeys.flatMap(k => g.cell(k, ''));
  if (!all.length) return noData(canvas);
  let min = Infinity, max = -Infinity;
  for (const v of all) { if (v < min) min = v; if (v > max) max = v; }
  const ints = all.every(Number.isInteger);
  let step, start;
  if (ints && max - min <= 40) { step = 1; start = min; }
  else { const k = Math.min(30, Math.max(6, Math.ceil(Math.log2(all.length) + 1))); step = niceStep((max - min) / k || 1); start = Math.floor(min / step) * step; }
  const nb = Math.max(1, Math.floor((max - start) / step) + 1);
  const binLabels = Array.from({ length: nb }, (_, i) => ints && step === 1 ? fmtNum(start + i) : `${fmtNum(start + i * step)} – ${fmtNum(start + (i + 1) * step)}`);
  const series = g.rowKeys.map(k => {
    const counts = new Array(nb).fill(0);
    for (const v of g.cell(k, '')) counts[Math.min(nb - 1, Math.floor((v - start) / step))]++;
    return { name: sdims.length ? keyLabel(k, sdims) : fieldLabel(fieldMap.get(field)), type: 'bar', stack: 'h', data: counts, barCategoryGap: '6%', emphasis: { focus: 'series' }, label: { show: state.options.showValues && g.rowKeys.length === 1, position: 'top', fontSize: 11 } };
  });
  makeChart(canvas);
  setOption({
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    legend: legendBottom(series.length > 1),
    grid: { left: 12, right: 24, top: 30, bottom: series.length > 1 ? 66 : 40, containLabel: true },
    xAxis: { type: 'category', data: binLabels, name: fieldLabel(fieldMap.get(field)), nameLocation: 'middle', nameGap: binLabels.length > 12 ? 52 : 28, axisLabel: { rotate: binLabels.length > 12 ? 40 : 0 } },
    yAxis: { type: 'value', name: 'Nombre', nameTextStyle: { align: 'left' } },
    series,
  });
}

// ---- scatter: X = numeric field in Rows, Y = numeric value field, colour = Columns
function renderScatter(canvas) {
  const xd = state.rows[0], yField = state.measure.field;
  const cdims = state.columns.length ? state.columns : state.rows.slice(1);
  const gx = numVal(xd.path), gy = numVal(yField);
  const groups = new Map(); let n = 0;
  const pts = [];
  for (const r of data) {
    if (!passesFilters(r)) continue;
    const x = gx(r), y = gy(r);
    if (x == null || y == null) continue;
    const k = cdims.length ? cartesian(cdims.map(d => dimValues(r, d))).map(a => a.join(SEP))[0] : '';
    if (k === undefined || (state.options.hideEmpty && k.split(SEP).includes(EMPTY))) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([x, y]); pts.push([x, y]);
    if (++n >= 20000) break;
  }
  if (!pts.length) return noData(canvas);
  const keys = [...groups.keys()].sort(compareKeys(cdims));
  const series = keys.map(k => ({ name: cdims.length ? keyLabel(k, cdims) : 'Enregistrements', type: 'scatter', data: groups.get(k), symbolSize: 7, itemStyle: { opacity: 0.6 }, large: n > 5000 }));
  // least-squares trend line over all points
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (sxx > 0 && pts.length > 2) {
    const b = sxy / sxx, a = my - b * mx, r2 = syy ? (sxy * sxy) / (sxx * syy) : 0;
    let x0 = Infinity, x1 = -Infinity;
    for (const p of pts) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; }
    series.push({ name: `Tendance (R² = ${r2.toLocaleString('fr-FR', { maximumFractionDigits: 2 })})`, type: 'line', data: [[x0, a + b * x0], [x1, a + b * x1]], symbol: 'none', lineStyle: { type: 'dashed', width: 2, color: '#263238' }, itemStyle: { color: '#263238' }, tooltip: { show: false }, z: 5 });
  }
  const xl = fieldLabel(fieldMap.get(xd.path)), yl = fieldLabel(fieldMap.get(yField));
  makeChart(canvas);
  setOption({
    tooltip: { trigger: 'item', formatter: p => `${esc(p.seriesName)}<br>${esc(xl)} : <b>${fmtNum(p.value[0])}</b><br>${esc(yl)} : <b>${fmtNum(p.value[1])}</b>` },
    legend: legendBottom(true),
    grid: { left: 16, right: 28, top: 36, bottom: 60, containLabel: true },
    xAxis: { type: 'value', name: xl, nameLocation: 'middle', nameGap: 28, scale: true, axisLabel: { formatter: v => fmtCompact(v) } },
    yAxis: { type: 'value', name: yl, nameTextStyle: { align: 'left' }, scale: true, axisLabel: { formatter: v => fmtCompact(v) } },
    series,
  });
}

// ---- calendar heatmap (Superset "Calendar Heatmap")
function renderCalendar(canvas) {
  const dd = { ...dateDim(), period: 'day', values: null };
  const res = aggregate({ rows: [dd], columns: [], sort: 'label', limit: 0, hideEmpty: true }); lastResult = res;
  const pts = res.rowKeys.map((k, i) => [k, res.rowTotals[i]]).filter(p => p[1] != null);
  if (!pts.length) return noData(canvas);
  const years = [...new Set(pts.map(p => p[0].slice(0, 4)))].sort().slice(-3);
  const max = Math.max(...pts.map(p => p[1]));
  makeChart(canvas, years.length * 165 + 80);
  const fmtDay = d => new Date(d + 'T00:00:00Z').toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  setOption({
    tooltip: { formatter: p => `${esc(fmtDay(p.value[0]))}<br><b>${fmt(p.value[1])}</b>` },
    visualMap: { min: 0, max, calculable: true, orient: 'horizontal', left: 'center', top: 0, itemWidth: 12, inRange: { color: ['#e3eefb', '#64a0e3', '#1565c0', '#0b2e59'] }, formatter: v => fmtCompact(v) },
    calendar: years.map((y, i) => ({
      range: y, top: 64 + i * 165, left: 48, right: 16, cellSize: ['auto', 15],
      itemStyle: { borderWidth: 2, borderColor: '#fff', color: '#f4f6f8' }, splitLine: { lineStyle: { color: '#c4cdd5', width: 1 } },
      yearLabel: { color: '#637381', fontSize: 14 }, dayLabel: { firstDay: 1, nameMap: ['D', 'L', 'M', 'M', 'J', 'V', 'S'], fontSize: 10, color: '#919eab' },
      monthLabel: { nameMap: MONTHS_FR, fontSize: 11, color: '#637381' },
    })),
    series: years.map((y, i) => ({ type: 'heatmap', coordinateSystem: 'calendar', calendarIndex: i, data: pts.filter(p => p[0].startsWith(y)) })),
  });
}

// ---- sankey: each field (Rows then Columns) is a step of the flow
function renderSankey(canvas) {
  const dims = [...state.rows, ...state.columns];
  const nodes = new Map(), links = [];
  for (let i = 0; i < dims.length - 1; i++) {
    const res = aggregate({ rows: [dims[i]], columns: [dims[i + 1]], sort: 'label', limit: 0 });
    res.rowKeys.forEach((rk, a) => res.colKeys.forEach((ck, b) => {
      const v = res.matrix[a][b];
      if (!v) return;
      const s = `${i}\u0001${rk}`, t = `${i + 1}\u0001${ck}`;
      nodes.set(s, valueLabel(dims[i], rk)); nodes.set(t, valueLabel(dims[i + 1], ck));
      links.push({ source: s, target: t, value: v });
    }));
  }
  if (!links.length) return noData(canvas);
  makeChart(canvas, Math.max(420, Math.min(900, nodes.size * 26)));
  setOption({
    title: { text: dims.map(d => fieldLabel(fieldMap.get(d.path))).join('   →   '), left: 'center', top: 0, textStyle: { fontSize: 12, color: '#637381', fontWeight: 'normal' } },
    tooltip: {
      trigger: 'item', formatter: p => p.dataType === 'edge'
        ? `${esc(nodes.get(p.data.source))} → ${esc(nodes.get(p.data.target))}<br><b>${fmt(p.data.value)}</b>`
        : `${esc(nodes.get(p.name))}<br><b>${fmt(p.value)}</b>`,
    },
    series: [{
      type: 'sankey', left: 16, right: 150, top: 32, bottom: 12, nodeAlign: 'justify', nodeGap: 10, draggable: true, animationDuration: 400, layoutIterations: 0,
      data: [...nodes.keys()].map(name => ({ name })), links, emphasis: { focus: 'adjacency' },
      lineStyle: { color: 'gradient', curveness: 0.5, opacity: 0.35 },
      label: { formatter: p => nodes.get(p.name) + (state.options.showValues ? ` (${fmt(p.value)})` : ''), fontSize: 12, color: '#1f2933' },
    }],
  });
}

// ---- GPS map
function renderMap(canvas) {
  const geo = [...state.rows, ...state.columns].map(d => fieldMap.get(d.path)).find(f => kindOf(f) === 'geo') || fields.find(f => kindOf(f) === 'geo');
  if (!geo) { canvas.innerHTML = '<div class="single"><span class="sub">Cette table n\'a pas de champ GPS (geopoint).</span></div>'; return; }
  const colorDim = [...state.columns, ...state.rows].find(d => kindOf(fieldMap.get(d.path)) !== 'geo');
  const filtered = data.filter(passesFilters);
  const el = document.createElement('div'); el.id = 'map'; canvas.appendChild(el);
  map = L.map(el);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const cats = new Map(), pts = [];
  for (const r of filtered) {
    const g = get(r, geo.path);
    if (!g || !g.coordinates) continue;
    const [lon, lat] = g.coordinates;
    const cat = colorDim ? dimValues(r, colorDim)[0] ?? EMPTY : 'Enregistrements';
    if (!cats.has(cat)) cats.set(cat, PALETTE[cats.size % PALETTE.length]);
    pts.push([lat, lon]);
    L.circleMarker([lat, lon], { radius: 5, weight: 1, color: '#fff', fillColor: cats.get(cat), fillOpacity: 0.85 })
      .bindPopup(`<b>${esc(colorDim ? valueLabel(colorDim, cat) : cat)}</b><br>${esc(r.__id || '')}<br>${esc(get(r, '__system/submitterName') || get(r, '__parent/__system/submitterName') || '')}`)
      .addTo(map);
  }
  if (pts.length) map.fitBounds(pts, { padding: [20, 20] }); else map.setView([13.5, 8.9], 6);
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const d = L.DomUtil.create('div', 'map-legend');
    d.innerHTML = `<b>${pts.length.toLocaleString('fr-FR')} points</b><br>` + [...cats].map(([k, c]) => `<span style="color:${c}">●</span> ${esc(colorDim ? valueLabel(colorDim, k) : k)}`).join('<br>');
    return d;
  };
  legend.addTo(map);
  setTimeout(() => map && map.invalidateSize(), 50);
}

const RENDERERS = {
  column: renderCartesian, stackedColumn: renderCartesian, bar: renderCartesian, stackedBar: renderCartesian, line: renderCartesian, area: renderCartesian,
  pie: renderPie, rose: renderPie, pivot: renderPivot, single: renderSingle, bigNumberTrend: renderBigNumberTrend, gauge: renderGauge,
  heatmap: renderHeatmap, treemap: renderTreemap, sunburst: renderSunburst, funnel: renderFunnel, radar: renderRadar,
  boxplot: renderBoxplot, histogram: renderHistogram, scatter: renderScatter, calendar: renderCalendar, sankey: renderSankey, map: renderMap,
};

// ------------------------------------------------------------------ layout zones & chips
function chipText(d) {
  const f = fieldMap.get(d.path) || { name: d.path };
  let extra = '';
  if (kindOf(f) === 'date') extra = PERIODS[d.period || 'month'];
  if (d.values && d.values.length) extra += (extra ? ', ' : '') + `${d.values.length} sélectionné(s)`;
  return `<span class="cl">${f.parentTable ? '<span class="up" title="Champ parent">↑</span> ' : ''}${esc(fieldLabel(f))}</span>${extra ? ` <small>${esc(extra)}</small>` : ''}`;
}

function renderZones() {
  for (const zone of ['columns', 'rows', 'filters']) {
    const el = $(`.zone[data-zone=${zone}]`);
    el.innerHTML = '';
    state[zone].forEach((d, i) => {
      const f = fieldMap.get(d.path);
      const c = document.createElement('span');
      c.className = 'chip' + (f ? '' : ' missing'); c.draggable = true;
      c.title = f ? `${fieldLabel(f)} (${f.name})` : `Champ introuvable : ${d.path}`;
      c.innerHTML = chipText(d) + '<button class="x" title="Retirer">×</button>';
      c.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', JSON.stringify({ from: zone, index: i })));
      c.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); state[zone].splice(i, 1); render(); });
      c.addEventListener('click', () => openDimPopover(zone, i, c));
      el.appendChild(c);
    });
  }
}

const usedPaths = () => new Set([...state.columns, ...state.rows, ...state.filters].map(d => d.path));

function addDim(zone, path, index) {
  for (const z of ['columns', 'rows', 'filters']) state[z] = state[z].filter(d => d.path !== path);
  const dim = { path };
  if (kindOf(fieldMap.get(path)) === 'date') dim.period = 'month';
  if (index == null) state[zone].push(dim); else state[zone].splice(index, 0, dim);
  render();
  if (zone === 'filters') setTimeout(() => { const c = $$('.zone[data-zone=filters] .chip')[state.filters.indexOf(dim)]; if (c) openDimPopover('filters', state.filters.indexOf(dim), c); }, 0);
}

function setupZones() {
  $$('.zone').forEach(z => {
    z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', e => {
      e.preventDefault(); z.classList.remove('over');
      const zone = z.dataset.zone;
      try {
        const p = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (p.from) { const [d] = state[p.from].splice(p.index, 1); state[zone].push(d); render(); return; }
        if (p.path) addDim(zone, p.path);
      } catch { /* ignore */ }
    });
  });
}

// distinct values for a field across current data (respecting select-multiple splitting), in form order
function distinctValues(dim) {
  const counts = new Map();
  const probe = { ...dim, values: null };
  for (const r of data) for (const v of dimValues(r, probe)) counts.set(v, (counts.get(v) || 0) + 1);
  const cmp = compareKeys([dim]);
  return [...counts].sort((a, b) => cmp(a[0], b[0]));
}

function openDimPopover(zone, i, anchor) {
  const d = state[zone][i];
  const f = fieldMap.get(d.path) || { name: d.path };
  const pop = $('#popover');
  const vals = distinctValues(d);
  const sel = new Set(d.values || []);
  pop.innerHTML = `
    <h4>${esc(fieldLabel(f))}</h4>
    ${kindOf(f) === 'date' ? `<label>Regrouper par période <select id="pPeriod">${Object.entries(PERIODS).map(([v, l]) => `<option value="${v}" ${v === (d.period || 'month') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
    ${f.selectMultiple ? `<label class="inline"><input type="checkbox" id="pSplit" ${d.split !== false ? 'checked' : ''}> Compter chaque option cochée séparément</label>` : ''}
    <label>${zone === 'filters' ? 'Garder uniquement ces valeurs' : 'Afficher uniquement ces valeurs (aucune = toutes)'}</label>
    <input type="search" id="pSearch" placeholder="Rechercher parmi ${vals.length} valeurs">
    <div class="vals">${vals.slice(0, 500).map(([v, n]) => {
      const lab = valueLabel(d, v);
      return `<label><input type="checkbox" value="${esc(v)}" ${sel.has(v) ? 'checked' : ''}> <span>${esc(lab)}${lab !== v && v !== EMPTY && !rawLabels() ? ` <code>${esc(v)}</code>` : ''}</span><span class="n">${n.toLocaleString('fr-FR')}</span></label>`;
    }).join('')}</div>
    <div class="row"><span><button class="link" id="pAll">Tout</button> · <button class="link" id="pNone">Aucun</button></span>
      <span><button class="ghost" id="pCancel">Annuler</button> <button id="pApply">Appliquer</button></span></div>`;
  place(pop, anchor);
  $('#pSearch', pop).addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    $$('.vals label', pop).forEach(l => (l.hidden = !l.textContent.toLowerCase().includes(q)));
  });
  $('#pAll', pop).onclick = () => $$('.vals input', pop).forEach(x => !x.closest('label').hidden && (x.checked = true));
  $('#pNone', pop).onclick = () => $$('.vals input', pop).forEach(x => (x.checked = false));
  $('#pCancel', pop).onclick = () => (pop.hidden = true);
  $('#pApply', pop).onclick = () => {
    const checked = $$('.vals input:checked', pop).map(x => x.value);
    d.values = checked.length && checked.length < vals.length ? checked : null;
    if ($('#pPeriod', pop) && $('#pPeriod', pop).value !== (d.period || 'month')) { d.period = $('#pPeriod', pop).value; d.values = null; }
    if ($('#pSplit', pop)) d.split = $('#pSplit', pop).checked;
    pop.hidden = true; render();
  };
}

function openAddPopover(path, anchor) {
  const pop = $('#popover');
  const f = fieldMap.get(path);
  pop.innerHTML = `<h4>${esc(fieldLabel(f))}</h4><div class="addto">
    <button class="ghost" data-z="columns">Ajouter aux Colonnes</button>
    <button class="ghost" data-z="rows">Ajouter aux Lignes</button>
    <button class="ghost" data-z="filters">Ajouter au Filtre</button>
    ${kindOf(f) === 'num' ? '<button class="ghost" data-z="measure">Utiliser comme Valeur</button>' : ''}</div>`;
  place(pop, anchor);
  $$('[data-z]', pop).forEach(b => (b.onclick = () => {
    pop.hidden = true;
    if (b.dataset.z === 'measure') {
      const agg = visDef().raw || !['count', 'pct'].includes(state.measure.agg) ? state.measure.agg : 'sum';
      state.measure = { agg, field: path }; render();
    } else addDim(b.dataset.z, path);
  }));
}

function place(pop, anchor) {
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  pop.style.top = (r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6) + 'px';
}
document.addEventListener('mousedown', e => {
  const pop = $('#popover');
  if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.chip, .field-list li')) pop.hidden = true;
  if (!e.target.closest('.menu')) { $('#downloadMenu').hidden = true; $('#userMenu').hidden = true; }
});

// ------------------------------------------------------------------ field list
function groupOf(f) {
  let own;
  if (f.system) own = 'Métadonnées de soumission';
  else {
    const segs = f.labelPath.split('/').slice(0, -1);
    // the repeat prefix of the field's own table is not a sub-group
    const pre = f.tablePrefix ? f.tablePrefix.split('/').length : 0;
    const rest = segs.slice(pre);
    own = rest.length ? rest.map((_, i) => groupLabel(segs.slice(0, pre + i + 1).join('/'))).join(' › ') : 'Champs du formulaire';
  }
  return f.parentTable ? `↑ ${tableLabel(f.parentTable)} — ${own}` : own;
}

function renderFieldList() {
  const q = $('#fieldSearch').value.toLowerCase();
  const used = usedPaths();
  const ul = $('#fieldList'); ul.innerHTML = '';
  const order = [...new Set(fields.map(groupOf))];
  const sorted = [...fields].sort((a, b) => order.indexOf(groupOf(a)) - order.indexOf(groupOf(b)));
  let lastGroup = null;
  for (const f of sorted) {
    const lab = fieldLabel(f);
    if (q && !(lab + ' ' + f.name + ' ' + f.path).toLowerCase().includes(q)) continue;
    const group = groupOf(f);
    if (group !== lastGroup) {
      const g = document.createElement('li'); g.className = 'group' + (f.parentTable ? ' parent' : ''); g.textContent = group; ul.appendChild(g); lastGroup = group;
    }
    const [tag, cls] = TYPE_TAG[kindOf(f)];
    const li = document.createElement('li');
    li.draggable = true; li.title = `${lab}\n${f.name}${f.parentTable ? ' — champ de « ' + tableLabel(f.parentTable) + ' »' : ''}`;
    if (used.has(f.path)) li.className = 'used';
    li.innerHTML = `<span class="ftype ${cls}">${tag}</span><span class="fname">${esc(lab)}</span>`;
    li.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', JSON.stringify({ path: f.path })));
    li.addEventListener('click', () => openAddPopover(f.path, li));
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ controls <-> state
function renderVisTypeOptions() {
  const groups = [...new Set(VIS.map(v => v.group))];
  $('#visType').innerHTML = groups.map(g => `<optgroup label="${esc(g)}">${VIS.filter(v => v.group === g).map(v => `<option value="${v.id}">${esc(v.label)}${v.superset ? '  ✦' : ''}</option>`).join('')}</optgroup>`).join('');
}
function renderLangOptions() {
  const langs = labels?.languages || [];
  const hasLabels = labels && (Object.keys(labels.fields || {}).length || Object.keys(labels.choices || {}).length);
  const opts = langs.length
    ? langs.map(l => `<option value="${l === labels.defaultLang ? '' : esc(l)}">${esc(l)}</option>`)
    : [`<option value="">${hasLabels ? 'Du formulaire' : 'Lisibles'}</option>`];
  $('#optLang').innerHTML = opts.join('') + '<option value="__raw">Valeurs brutes</option>';
}
function renderTableOptions() {
  $('#table').innerHTML = tables.map(t => `<option value="${esc(t)}">${esc(t === 'Submissions' ? 'Soumissions (principale)' : 'Répétition : ' + tableLabel(t))}</option>`).join('');
  $('#table').value = state.table;
}

function syncControls() {
  const v = visDef();
  $('#visType').value = state.type;
  $('#agg').value = state.measure.agg;
  $('#agg').hidden = !!v.raw;
  $('#measurePrefix').textContent = state.type === 'scatter' ? 'Axe Y :' : 'Champ :';
  $('#measurePrefix').hidden = !v.raw;
  const nums = fields.filter(f => kindOf(f) === 'num');
  $('#measureField').innerHTML = '<option value="">— champ numérique —</option>' + nums.map(f => `<option value="${esc(f.path)}">${f.parentTable ? '↑ ' : ''}${esc(fieldLabel(f))}</option>`).join('');
  $('#measureField').value = state.measure.field || '';
  $('#measureField').hidden = !v.raw && ['count', 'pct'].includes(state.measure.agg);
  const langVal = state.options.lang && state.options.lang !== labels?.defaultLang ? state.options.lang : '';
  $('#optLang').value = langVal;
  if ($('#optLang').value !== langVal) $('#optLang').value = '';
  $('#optValues').checked = state.options.showValues;
  $('#optHideEmpty').checked = state.options.hideEmpty;
  $('#optSort').value = state.options.sort;
  $('#optLimit').value = state.options.limit || '';
  $('#optTargetWrap').hidden = state.type !== 'gauge';
  $('#optTarget').value = state.options.target || '';
  $('#title').value = state.title || '';
  $('#visHint').textContent = v.hint || '';
  $('#visHint').hidden = !v.hint;
  $('#from').value = state.from || ''; $('#to').value = state.to || '';
  $('#reviewState').value = state.reviewState || '';
}

function firstNumeric() { const n = fields.find(f => kindOf(f) === 'num' && !f.parentTable) || fields.find(f => kindOf(f) === 'num'); return n ? n.path : ''; }

function bindControls() {
  renderVisTypeOptions();
  $('#visType').onchange = e => {
    state.type = e.target.value;
    if (visDef().raw && !state.measure.field) state.measure.field = firstNumeric();
    render();
  };
  $('#agg').onchange = e => {
    state.measure.agg = e.target.value;
    if (!['count', 'pct'].includes(state.measure.agg) && !state.measure.field) state.measure.field = firstNumeric();
    render();
  };
  $('#measureField').onchange = e => { state.measure.field = e.target.value; render(); };
  $('#optValues').onchange = e => { state.options.showValues = e.target.checked; render(); };
  $('#optLang').onchange = e => { state.options.lang = e.target.value; renderTableOptions(); render(); };
  $('#optHideEmpty').onchange = e => { state.options.hideEmpty = e.target.checked; render(); };
  $('#optSort').onchange = e => { state.options.sort = e.target.value; render(); };
  $('#optLimit').onchange = e => { state.options.limit = Math.max(0, parseInt(e.target.value) || 0); render(); };
  $('#optTarget').onchange = e => { state.options.target = Math.max(0, parseFloat(e.target.value) || 0); render(); };
  $('#title').oninput = e => { state.title = e.target.value; };
  $('#fieldSearch').oninput = renderFieldList;

  $('#project').onchange = async e => { state.projectId = e.target.value; state.formId = null; resetLayout(); await loadForms(); };
  $('#form').onchange = async e => { state.formId = e.target.value; state.table = 'Submissions'; resetLayout(); await loadForm(); };
  $('#table').onchange = async e => { state.table = e.target.value; resetLayout(); setFieldsForTable(); await loadData(); };
  $('#from').onchange = e => { state.from = e.target.value; loadData(); };
  $('#to').onchange = e => { state.to = e.target.value; loadData(); };
  $('#reviewState').onchange = e => { state.reviewState = e.target.value; loadData(); };
  $('#btnRefresh').onclick = () => loadData(true);

  $('#btnNew').onclick = () => {
    const keep = { projectId: state.projectId, formId: state.formId, table: state.table, options: { ...blankState().options, lang: state.options.lang } };
    state = { ...blankState(), ...keep }; history.replaceState(null, '', location.pathname); render();
  };
  $('#btnSave').onclick = () => save(false);
  $('#btnSaveAs').onclick = () => save(true);
  $('#btnOpen').onclick = openDialog;
  $('#btnDownload').onclick = () => ($('#downloadMenu').hidden = !$('#downloadMenu').hidden);
  $$('[data-dl]').forEach(b => (b.onclick = () => { $('#downloadMenu').hidden = true; download(b.dataset.dl); }));
  window.addEventListener('resize', () => { chart && chart.resize(); map && map.invalidateSize(); });
}

function resetLayout() { state.columns = []; state.rows = []; state.filters = []; state.measure = { agg: 'count', field: '' }; }

// ------------------------------------------------------------------ loading
async function loadProjects() {
  const list = await api('/api/projects');
  $('#project').innerHTML = list.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if (!state.projectId || !list.some(p => String(p.id) === String(state.projectId))) state.projectId = list[0] && String(list[0].id);
  $('#project').value = state.projectId;
  await loadForms();
}

async function loadForms() {
  if (!state.projectId) return;
  const list = await api(`/api/projects/${state.projectId}/forms`);
  $('#form').innerHTML = list.map(f => `<option value="${esc(f.id)}">${esc(f.name)}${f.submissions != null ? ` (${f.submissions})` : ''}</option>`).join('');
  if (!state.formId || !list.some(f => f.id === state.formId)) state.formId = list[0] && list[0].id;
  $('#form').value = state.formId || '';
  await loadForm();
}

async function loadForm() {
  if (!state.formId) { data = []; fields = []; tables = []; labels = null; render(); return; }
  const base = `/api/projects/${state.projectId}/forms/${encodeURIComponent(state.formId)}`;
  const [tbls, flds, lbl] = await Promise.all([
    api(base + '/tables'), api(base + '/fields'),
    api(base + '/labels').catch(e => { console.warn('Libellés indisponibles :', e.message); return null; }),
  ]);
  tables = tbls; allFields = flds; labels = lbl;
  if (!tables.includes(state.table)) state.table = 'Submissions';
  renderLangOptions();
  renderTableOptions();
  setFieldsForTable();
  await loadData();
}

// Ancestors of a repeat table, root first: Submissions.a.b → [Submissions, Submissions.a]
const ancestorsOf = t => tables.filter(x => x !== t && (x === 'Submissions' || t.startsWith(x + '.'))).sort((a, b) => a.length - b.length);

// Fields of the current table + (for repeats) the fields of every parent table, reachable through __parent/
function setFieldsForTable() {
  const repeats = allFields.filter(f => f.repeat).map(f => f.path);
  const owner = p => repeats.filter(r => p.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0] || '';
  const direct = t => {
    const pre = t === 'Submissions' ? '' : repeatPath(t);
    const list = allFields.filter(f => !f.repeat && owner(f.path) === pre)
      .map(f => ({ ...f, path: pre ? f.path.slice(pre.length + 1) : f.path, labelPath: f.path, tablePrefix: pre }));
    return t === 'Submissions' ? [...list, ...SYSTEM_FIELDS.map(f => ({ ...f, labelPath: f.path }))] : list;
  };
  fields = direct(state.table);
  let prefix = '';
  for (const t of ancestorsOf(state.table).reverse()) {
    prefix += '__parent/';
    fields.push(...direct(t).map(f => ({ ...f, path: prefix + f.path, parentTable: t })));
  }
  fieldMap = new Map(fields.map(f => [f.path, f]));
}

async function fetchTable(table, refresh) {
  const p = new URLSearchParams({ table });
  if (state.from) p.set('from', state.from);
  if (state.to) p.set('to', state.to);
  if (state.reviewState) p.set('reviewState', state.reviewState);
  if (refresh) p.set('refresh', '1');
  return api(`/api/projects/${state.projectId}/forms/${encodeURIComponent(state.formId)}/data?${p}`);
}

// Loads the current table and, for a repeat, its parent tables; each row gets row.__parent = its parent row.
// Rows whose parent is missing (e.g. outside the date filter) are dropped.
async function loadData(refresh = false) {
  if (!state.formId) return;
  $('#rowCount').textContent = 'Chargement…';
  try {
    const chain = [...ancestorsOf(state.table), state.table];
    const results = await Promise.all(chain.map(t => fetchTable(t, refresh)));
    let parents = null, rows = [];
    results.forEach((res, k) => {
      rows = res.rows;
      if (k > 0) {
        const key = rows.length ? Object.keys(rows[0]).find(x => x !== '__id' && /^__.+-id$/.test(x)) : null;
        if (key) rows = rows.filter(r => { const p = parents.get(r[key]); if (!p) return false; r.__parent = p; return true; });
      }
      parents = new Map(rows.map(r => [r.__id, r]));
    });
    data = rows;
    const when = new Date(Math.min(...results.map(r => r.fetchedAt))).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    const unit = state.table === 'Submissions' ? 'soumissions' : `lignes « ${tableLabel(state.table)} »`;
    $('#rowCount').textContent = `${data.length.toLocaleString('fr-FR')} ${unit} · ${when}`;
  } catch (e) {
    data = []; $('#rowCount').textContent = 'Échec du chargement'; if (e.status !== 401) toast(e.message, true);
  }
  render();
}

// ------------------------------------------------------------------ save / open
async function save(asNew) {
  if (!state.formId) return toast('Choisissez d\'abord un formulaire', true);
  let name = state.name;
  if (asNew || !state.id) {
    name = prompt('Nom de la visualisation', state.title || state.name || '');
    if (!name) return;
  }
  const body = JSON.stringify({ ...state, name, id: undefined, mine: undefined });
  let saved;
  try {
    saved = state.id && !asNew
      ? await api(`/api/visualizations/${state.id}`, { method: 'PUT', body })
      : await api('/api/visualizations', { method: 'POST', body });
  } catch (e) { if (e.status === 403) return save(true); return toast(e.message, true); }
  state.id = saved.id; state.name = saved.name;
  history.replaceState(null, '', `#/${saved.id}`);
  toast(`« ${saved.name} » enregistrée`);
}

async function openDialog() {
  const dlg = $('#openDialog');
  let list;
  try { list = await api('/api/visualizations'); } catch (e) { return toast(e.message, true); }
  const typeName = id => VIS.find(v => v.id === id)?.label || id;
  const draw = () => {
    const q = $('#openSearch').value.toLowerCase();
    $('#openList').innerHTML = list.filter(v => v.name.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(v => `<li data-id="${v.id}"><span>${esc(v.name)}<br><span class="owner">${v.mine ? 'Moi' : esc(v.ownerName || v.owner || '')}</span></span><small>${esc(typeName(v.type))} · ${new Date(v.updatedAt).toLocaleDateString('fr-FR')}</small>${v.mine ? '<button type="button" class="del" title="Supprimer">🗑</button>' : ''}</li>`).join('')
      || '<li>Aucune visualisation enregistrée sur ce serveur.</li>';
  };
  $('#openSearch').value = ''; $('#openSearch').oninput = draw; draw();
  $('#openList').onclick = async e => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    if (e.target.classList.contains('del')) {
      if (!confirm('Supprimer cette visualisation ?')) return;
      try { await api(`/api/visualizations/${li.dataset.id}`, { method: 'DELETE' }); } catch (err) { return toast(err.message, true); }
      list.splice(list.findIndex(v => v.id === li.dataset.id), 1); draw(); return;
    }
    dlg.close(); await openVis(li.dataset.id);
  };
  dlg.showModal();
}

async function openVis(id) {
  try {
    const v = await api(`/api/visualizations/${id}`);
    const options = { ...blankState().options, ...v.options };
    if (v.options && v.options.pretty === false && v.options.lang == null) options.lang = '__raw'; // older saves
    state = { ...blankState(), ...v, options };
    if (!v.mine) state.id = null; // someone else's: "Save" will create a copy
    history.replaceState(null, '', `#/${id}`);
    await loadProjects();
  } catch (e) { if (e.status !== 401) { toast(e.message, true); history.replaceState(null, '', location.pathname); await loadProjects().catch(() => {}); } }
}

// ------------------------------------------------------------------ downloads
function fileName(ext) { return (state.title || state.name || 'odk-visualisation').replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().replace(/\s+/g, '_') + '.' + ext; }
function saveBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
const csvCell = v => v == null ? '' : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
const csvBlob = lines => new Blob(['﻿' + lines.map(l => l.map(csvCell).join(',')).join('\n')], { type: 'text/csv' });

function download(kind) {
  if (kind === 'png') {
    if (!chart) return toast('L\'export PNG fonctionne pour les graphiques. Utilisez le CSV pour les tableaux.', true);
    const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
    fetch(url).then(r => r.blob()).then(b => saveBlob(b, fileName('png')));
  } else if (kind === 'table') {
    const res = lastResult;
    if (!res) return toast('Pas de tableau agrégé pour ce type : utilisez les données brutes.', true);
    const head = [res.rowDims.map(d => fieldLabel(fieldMap.get(d.path))).join(SEP), ...(res.hasSeries ? res.colKeys.map(k => keyLabel(k, res.colDims)) : [measureLabel()]), ...(res.hasSeries ? ['Total'] : [])];
    const lines = [head, ...res.rowKeys.map((k, i) => [keyLabel(k, res.rowDims), ...res.matrix[i], ...(res.hasSeries ? [res.rowTotals[i]] : [])])];
    saveBlob(csvBlob(lines), fileName('csv'));
  } else {
    const rows = lastFiltered.length ? lastFiltered : data;
    if (!rows.length) return toast('Rien à exporter pour l\'instant', true);
    const cols = fields.filter(f => kindOf(f) !== 'geo');
    // line 1 = technical path, line 2 = question label (in the chosen language)
    const lines = [['__id', ...cols.map(f => f.path)], ['', ...cols.map(f => fieldLabel(f))], ...rows.map(r => [r.__id, ...cols.map(f => get(r, f.path))])];
    saveBlob(csvBlob(lines), fileName('brut.csv'));
  }
}

// ------------------------------------------------------------------ connexion ODK
let config = {};
let currentUser = null;
const RECENT_KEY = 'odkvis.recent';
const store = {
  get() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || { servers: [], last: {} }; } catch { return { servers: [], last: {} }; } },
  set(v) { try { localStorage.setItem(RECENT_KEY, JSON.stringify(v)); } catch { /* private mode */ } },
};

function showLogin(message = '', kind = 'error') {
  currentUser = null;
  $('#appRoot').hidden = true; $('#login').hidden = false; $('#popover').hidden = true;
  const msg = $('#loginMsg');
  msg.hidden = !message; msg.textContent = message; msg.className = 'login-msg' + (kind === 'info' ? ' info' : '');
  const saved = store.get();
  $('#recentServers').innerHTML = saved.servers.map(s => `<option value="${esc(s)}">`).join('');
  if (config.lockServer) {
    $('#serverWrap').hidden = true; $('#loginServer').required = false;
    $('#serverLocked').hidden = false; $('#serverLocked').innerHTML = `Serveur : <b>${esc(config.defaultServer)}</b>`;
  } else if (!$('#loginServer').value) {
    $('#loginServer').value = saved.last.server || config.defaultServer || '';
  }
  if (!$('#loginEmail').value) $('#loginEmail').value = saved.last.email || '';
  $('#demoBtn').hidden = !config.allowDemo;
  $('#loginPassword').value = '';
  setTimeout(() => ($('#loginServer').value || config.lockServer ? ($('#loginEmail').value ? $('#loginPassword') : $('#loginEmail')) : $('#loginServer')).focus(), 0);
}

async function doLogin(payload) {
  const btn = $('#loginBtn');
  btn.disabled = true; btn.textContent = 'Connexion…';
  $('#loginMsg').hidden = true;
  try {
    const me = await api('/api/login', { method: 'POST', body: JSON.stringify(payload) });
    if (!me.demo && $('#rememberServer').checked) {
      const saved = store.get();
      saved.servers = [me.server, ...saved.servers.filter(s => s !== me.server)].slice(0, 8);
      saved.last = { server: me.server, email: me.email };
      store.set(saved);
    }
    await startApp(me, true);
  } catch (e) {
    $('#loginMsg').hidden = false; $('#loginMsg').className = 'login-msg'; $('#loginMsg').textContent = e.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Se connecter'; $('#loginPassword').value = '';
  }
}

async function startApp(me, fresh) {
  const serverChanged = currentUser?.server !== me.server;
  currentUser = me;
  $('#login').hidden = true; $('#appRoot').hidden = false;
  $('#demoBadge').hidden = !me.demo;
  const initials = (me.name || me.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  $('#userAvatar').textContent = initials || '?';
  $('#userName').textContent = me.demo ? 'Démo' : me.name;
  $('#userFull').textContent = me.demo ? 'Mode démonstration' : `${me.name} (${me.email})`;
  $('#userServer').textContent = me.demo ? 'Données fictives' : me.server;
  if (fresh || serverChanged) { state = blankState(); data = []; allFields = []; fields = []; tables = []; labels = null; fieldMap = new Map(); }
  render();
  const id = location.hash.match(/^#\/([\w-]+)/);
  try {
    if (id) await openVis(id[1]); else await loadProjects();
  } catch (e) { if (e.status !== 401) toast(e.message, true); }
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  showLogin('Vous êtes déconnecté.', 'info');
}

function bindLogin() {
  $('#loginForm').addEventListener('submit', e => {
    e.preventDefault();
    doLogin({ server: $('#loginServer').value, email: $('#loginEmail').value, password: $('#loginPassword').value });
  });
  $('#demoBtn').onclick = () => doLogin({ demo: true });
  $('#togglePw').onclick = () => {
    const i = $('#loginPassword'); const show = i.type === 'password';
    i.type = show ? 'text' : 'password'; $('#togglePw').textContent = show ? 'Masquer' : 'Afficher';
  };
  $('#btnUser').onclick = () => ($('#userMenu').hidden = !$('#userMenu').hidden);
  $('#btnLogout').onclick = () => { $('#userMenu').hidden = true; logout(); };
  $('#btnSwitch').onclick = async () => {
    $('#userMenu').hidden = true;
    await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
    $('#loginServer').value = ''; $('#loginEmail').value = '';
    history.replaceState(null, '', location.pathname);
    showLogin();
  };
}

// ------------------------------------------------------------------ boot
(async function init() {
  bindControls(); setupZones(); bindLogin();
  try { config = await api('/api/config'); } catch { config = {}; }
  try {
    const me = await api('/api/me');
    await startApp(me, false);
  } catch (e) {
    if (e.status !== 401) showLogin(e.message);
  }
})();
