/* ODK Visualizer — frontend.
   Layout model follows the DHIS2 Data Visualizer: Columns (series) × Rows (category) + Filter,
   with a value (count / sum / avg / ...) aggregated client-side from the ODK OData feed. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const EMPTY = '(vide)';
const PERIODS = { day: 'Jour', week: 'Semaine', month: 'Mois', quarter: 'Trimestre', year: 'Année' };
const NUM_TYPES = ['int', 'decimal', 'range'];
const DATE_TYPES = ['date', 'dateTime', 'today', 'start', 'end'];

const SYSTEM_FIELDS = [
  { path: '__system/submissionDate', name: 'Date de soumission', type: 'dateTime', system: true },
  { path: '__system/submitterName', name: 'Enquêteur', type: 'string', system: true },
  { path: '__system/reviewState', name: 'État de revue', type: 'string', system: true },
  { path: '__system/deviceId', name: 'Appareil', type: 'string', system: true },
  { path: '__system/formVersion', name: 'Version du formulaire', type: 'string', system: true },
];

let state = blankState();
let allFields = [];      // fields from ODK for the current form
let fields = [];         // fields usable for the current table
let fieldMap = new Map();
let data = [];           // raw OData rows for current source
let chart = null, map = null;
let lastResult = null, lastFiltered = [];

function blankState() {
  return {
    id: null, name: '', title: '', type: 'column',
    projectId: null, formId: null, table: 'Submissions', from: '', to: '', reviewState: '',
    columns: [], rows: [], filters: [],
    measure: { agg: 'count', field: '' },
    options: { showValues: false, pretty: true, hideEmpty: false, sort: 'label', limit: 0 },
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

// ------------------------------------------------------------------ helpers
const get = (obj, path) => path.split('/').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const kindOf = f => !f ? 'text'
  : f.type === 'geopoint' || f.type === 'geotrace' || f.type === 'geoshape' ? 'geo'
  : NUM_TYPES.includes(f.type) ? 'num'
  : DATE_TYPES.includes(f.type) ? 'date'
  : f.selectMultiple ? 'multi'
  : f.type === 'select1' || f.type === 'select' ? 'sel' : 'text';
const TYPE_TAG = { num: ['123', 'num'], date: ['DATE', 'date'], multi: ['MULTI', 'sel'], sel: ['UN', 'sel'], geo: ['GPS', 'geo'], text: ['ABC', ''] };

function tidy(s) {
  if (!state.options.pretty || s === EMPTY) return s;
  return String(s).replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
}
function fieldLabel(f) { return f.system ? f.name : tidy(f.name); }

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
function periodKey(v, p) {
  const d = new Date(v.length === 10 ? v + 'T00:00:00Z' : v);
  if (isNaN(d)) return EMPTY;
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  switch (p) {
    case 'day': return d.toISOString().slice(0, 10);
    case 'week': return isoWeek(d);
    case 'quarter': return `${y}-Q${Math.ceil(m / 3)}`;
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

function cartesian(lists) {
  return lists.reduce((acc, l) => acc.flatMap(a => l.map(b => [...a, b])), [[]]);
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

function aggregate() {
  const { filters, measure } = state;
  // With only Columns chosen, treat them as the category axis
  const rows = state.rows.length ? state.rows : state.columns;
  const columns = state.rows.length ? state.columns : [];
  const filtered = data.filter(r => filters.every(d => !d.values || !d.values.length || dimValues(r, d).length));
  const needsField = !['count', 'pct'].includes(measure.agg);
  const cells = new Map(), rowTot = new Map(), colTot = new Map(), grand = newAcc();
  const rowKeys = new Set(), colKeys = new Set();
  const SEP = ' · ';

  for (const r of filtered) {
    const rk = cartesian(rows.map(d => dimValues(r, d))).map(k => k.join(SEP));
    const ck = cartesian(columns.map(d => dimValues(r, d))).map(k => k.join(SEP));
    if (!rk.length || !ck.length) continue;
    const x = needsField ? Number(get(r, measure.field)) : null;
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
  if (state.options.hideEmpty) {
    R = R.filter(k => !k.split(SEP).includes(EMPTY));
    C = C.filter(k => !k.split(SEP).includes(EMPTY));
  }
  const natural = (a, b) => (a === EMPTY) - (b === EMPTY) || a.localeCompare(b, undefined, { numeric: true });
  C.sort(natural);
  const rv = k => accValue(rowTot.get(k), measure.agg) ?? -Infinity;
  if (state.options.sort === 'desc') R.sort((a, b) => rv(b) - rv(a));
  else if (state.options.sort === 'asc') R.sort((a, b) => rv(a) - rv(b));
  else R.sort(natural);
  if (state.options.limit > 0) R = R.slice(0, state.options.limit);

  const total = grand.n;
  const val = acc => {
    const v = accValue(acc, measure.agg);
    if (v == null) return null;
    return measure.agg === 'pct' ? (total ? (100 * v) / total : 0) : v;
  };
  const matrix = R.map(a => C.map(b => val(cells.get(a + '\u0001' + b))));
  return {
    rowKeys: R, colKeys: C, matrix, hasSeries: columns.length > 0, rowDims: rows,
    rowTotals: R.map(a => val(rowTot.get(a))),
    colTotals: C.map(b => val(colTot.get(b))),
    grandTotal: val(grand),
    filtered,
  };
}

function measureLabel() {
  const { agg, field } = state.measure;
  const f = fieldMap.get(field);
  const name = f ? fieldLabel(f) : '';
  return { count: 'Nombre', pct: '% du total', sum: `Somme de ${name}`, avg: `Moyenne de ${name}`, min: `Min. de ${name}`, max: `Max. de ${name}` }[agg];
}
const fmt = v => v == null ? '' : state.measure.agg === 'pct' ? v.toFixed(1) + '%'
  : Number.isInteger(v) ? v.toLocaleString('fr-FR') : v.toLocaleString('fr-FR', { maximumFractionDigits: 2 });

// ------------------------------------------------------------------ rendering
function render() {
  syncControls();
  renderZones();
  renderFieldList();
  const canvas = $('#canvas');
  if (chart) { chart.dispose(); chart = null; }
  if (map) { map.remove(); map = null; }
  canvas.innerHTML = '';
  const ready = data.length && (state.type === 'single' || state.type === 'map' || state.rows.length || state.columns.length);
  const EMPTY_MSG = '<strong>Choisissez un formulaire, puis glissez des champs dans la mise en page.</strong><span>Exemple : <em>région</em> en Lignes et <em>date de soumission</em> (mois) en Colonnes.</span>';
  $('#empty').innerHTML = data.length || !state.formId ? EMPTY_MSG : '<strong>Aucune soumission pour cette sélection.</strong><span>Vérifiez la période ou le filtre d\'état de revue.</span>';
  $('#empty').hidden = !!ready;
  if (!ready) { lastResult = null; return; }
  if (!['count', 'pct'].includes(state.measure.agg) && !state.measure.field) {
    $('#empty').hidden = false;
    $('#empty').innerHTML = '<strong>Choisissez un champ numérique pour la valeur.</strong>';
    return;
  }

  if (state.type === 'map') return renderMap(canvas);
  const res = aggregate();
  lastResult = res; lastFiltered = res.filtered;
  if (!res.rowKeys.length) { canvas.innerHTML = '<div class="single"><span class="sub">Aucune donnée ne correspond à la sélection.</span></div>'; return; }
  if (state.type === 'pivot') return renderPivot(canvas, res);
  if (state.type === 'single') {
    canvas.innerHTML = `<div class="single"><div class="big">${fmt(res.grandTotal)}</div><div class="sub">${measureLabel()} · ${res.filtered.length.toLocaleString('fr-FR')} soumissions</div></div>`;
    return;
  }
  renderChart(canvas, res);
}

function renderChart(canvas, res) {
  const el = document.createElement('div'); el.style.cssText = 'width:100%;height:100%;min-height:380px';
  canvas.appendChild(el);
  chart = echarts.init(el);
  const t = state.type;
  const cats = res.rowKeys.map(k => k.split(' · ').map(tidy).join(' · '));
  const seriesNames = res.hasSeries ? res.colKeys.map(k => k.split(' · ').map(tidy).join(' · ')) : [measureLabel()];
  const label = { show: state.options.showValues, formatter: p => fmt(p.value), position: t.startsWith('stacked') ? 'inside' : 'top', fontSize: 11 };
  let option;

  if (t === 'pie') {
    const vals = res.rowTotals;
    const names = cats;
    option = {
      tooltip: { trigger: 'item', formatter: p => `${p.name}<br><b>${fmt(p.value)}</b> (${p.percent}%)` },
      legend: { type: 'scroll', bottom: 0 },
      series: [{ type: 'pie', radius: ['35%', '68%'], data: names.map((n, i) => ({ name: n, value: vals[i] })),
        label: { formatter: state.options.showValues ? '{b}: {d}%' : '{b}' } }],
    };
  } else {
    const horizontal = t === 'bar' || t === 'stackedBar';
    const stack = t.startsWith('stacked') || t === 'area' ? 'total' : undefined;
    const type = t === 'line' || t === 'area' ? 'line' : 'bar';
    const series = seriesNames.map((name, j) => ({
      name, type, stack, data: res.matrix.map(r => r[j]),
      label: { ...label, position: horizontal && !stack ? 'right' : label.position },
      areaStyle: t === 'area' ? {} : undefined, smooth: false, symbolSize: 6,
      barMaxWidth: 48, emphasis: { focus: 'series' },
    }));
    const cat = { type: 'category', data: cats, axisLabel: { interval: 0, rotate: !horizontal && cats.length > 8 ? 40 : 0, width: 140, overflow: 'truncate' } };
    const valAx = { type: 'value', axisLabel: { formatter: v => fmt(v) } };
    option = {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, valueFormatter: fmt },
      legend: { show: series.length > 1, type: 'scroll', bottom: 0 },
      grid: { left: 12, right: 24, top: 24, bottom: series.length > 1 ? 44 : 16, containLabel: true },
      xAxis: horizontal ? valAx : cat, yAxis: horizontal ? { ...cat, inverse: true } : valAx,
      series,
    };
  }
  option.color = ['#1565c0', '#f57c00', '#2e7d32', '#c62828', '#6a1b9a', '#00838f', '#ad1457', '#5d4037', '#9e9d24', '#455a64'];
  option.animationDuration = 300;
  option.animationDurationUpdate = 200;
  chart.setOption(option);
}

function renderPivot(canvas, res) {
  const colHead = res.hasSeries ? res.colKeys : [measureLabel()];
  const rowHeadLabel = res.rowDims.map(d => fieldLabel(fieldMap.get(d.path) || { name: d.path })).join(' · ') || '';
  let h = '<table class="pivot"><thead><tr><th>' + esc(rowHeadLabel) + '</th>';
  for (const c of colHead) h += `<th>${esc(res.hasSeries ? c.split(' · ').map(tidy).join(' · ') : c)}</th>`;
  if (res.hasSeries) h += '<th>Total</th>';
  h += '</tr></thead><tbody>';
  const max = Math.max(...res.matrix.flat().filter(v => v != null), 1);
  res.rowKeys.forEach((rk, i) => {
    h += `<tr><th>${esc(rk.split(' · ').map(tidy).join(' · '))}</th>`;
    res.matrix[i].forEach(v => {
      const a = v == null ? 0 : (v / max) * 0.35;
      h += `<td style="background:rgba(21,101,192,${a.toFixed(3)})">${fmt(v)}</td>`;
    });
    if (res.hasSeries) h += `<td class="total">${fmt(res.rowTotals[i])}</td>`;
    h += '</tr>';
  });
  {
    h += '<tr class="total"><th>Total</th>';
    (res.hasSeries ? res.colTotals : [res.grandTotal]).forEach(v => (h += `<td>${fmt(v)}</td>`));
    if (res.hasSeries) h += `<td>${fmt(res.grandTotal)}</td>`;
    h += '</tr>';
  }
  canvas.innerHTML = h + '</tbody></table>';
}

function renderMap(canvas) {
  const geo = [...state.rows, ...state.columns].map(d => fieldMap.get(d.path)).find(f => kindOf(f) === 'geo')
    || fields.find(f => kindOf(f) === 'geo');
  if (!geo) { canvas.innerHTML = '<div class="single"><span class="sub">Cette table n\'a pas de champ GPS (geopoint).</span></div>'; return; }
  const colorDim = [...state.columns, ...state.rows].find(d => kindOf(fieldMap.get(d.path)) !== 'geo');
  const filtered = data.filter(r => state.filters.every(d => !d.values || !d.values.length || dimValues(r, d).length));
  lastFiltered = filtered; lastResult = null;
  const el = document.createElement('div'); el.id = 'map'; canvas.appendChild(el);
  map = L.map(el);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const colors = ['#1565c0', '#f57c00', '#2e7d32', '#c62828', '#6a1b9a', '#00838f', '#ad1457', '#5d4037', '#9e9d24', '#455a64'];
  const cats = new Map();
  const pts = [];
  for (const r of filtered) {
    const g = get(r, geo.path);
    if (!g || !g.coordinates) continue;
    const [lon, lat] = g.coordinates;
    const cat = colorDim ? dimValues(r, colorDim)[0] ?? EMPTY : 'Soumissions';
    if (!cats.has(cat)) cats.set(cat, colors[cats.size % colors.length]);
    pts.push([lat, lon]);
    L.circleMarker([lat, lon], { radius: 5, weight: 1, color: '#fff', fillColor: cats.get(cat), fillOpacity: 0.85 })
      .bindPopup(`<b>${esc(tidy(cat))}</b><br>${esc(r.__id || '')}<br>${esc(get(r, '__system/submitterName') || '')}`)
      .addTo(map);
  }
  if (pts.length) map.fitBounds(pts, { padding: [20, 20] }); else map.setView([13.5, 8.9], 6);
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const d = L.DomUtil.create('div');
    d.style.cssText = 'background:#fff;padding:6px 10px;border-radius:4px;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,.3);max-height:200px;overflow:auto';
    d.innerHTML = `<b>${pts.length.toLocaleString('fr-FR')} points</b><br>` + [...cats].map(([k, c]) => `<span style="color:${c}">●</span> ${esc(tidy(k))}`).join('<br>');
    return d;
  };
  legend.addTo(map);
  setTimeout(() => map && map.invalidateSize(), 50);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ------------------------------------------------------------------ layout zones & chips
function chipText(d) {
  const f = fieldMap.get(d.path) || { name: d.path };
  let extra = '';
  if (kindOf(f) === 'date') extra = PERIODS[d.period || 'month'];
  if (d.values && d.values.length) extra += (extra ? ', ' : '') + `${d.values.length} sélectionné(s)`;
  return `${esc(fieldLabel(f))}${extra ? ` <small>${esc(extra)}</small>` : ''}`;
}

function renderZones() {
  for (const zone of ['columns', 'rows', 'filters']) {
    const el = $(`.zone[data-zone=${zone}]`);
    el.innerHTML = '';
    state[zone].forEach((d, i) => {
      const c = document.createElement('span');
      c.className = 'chip'; c.draggable = true; c.innerHTML = chipText(d) + '<button class="x" title="Retirer">×</button>';
      c.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', JSON.stringify({ from: zone, index: i })));
      c.querySelector('.x').addEventListener('click', e => { e.stopPropagation(); state[zone].splice(i, 1); render(); });
      c.addEventListener('click', e => openDimPopover(zone, i, c));
      el.appendChild(c);
    });
  }
}

function usedPaths() { return new Set([...state.columns, ...state.rows, ...state.filters].map(d => d.path)); }

function addDim(zone, path, index) {
  for (const z of ['columns', 'rows', 'filters']) state[z] = state[z].filter(d => d.path !== path);
  const f = fieldMap.get(path);
  const dim = { path };
  if (kindOf(f) === 'date') dim.period = 'month';
  if (index == null) state[zone].push(dim); else state[zone].splice(index, 0, dim);
  render();
  if (zone === 'filters') setTimeout(() => { const chips = $$(`.zone[data-zone=filters] .chip`); const c = chips[state.filters.indexOf(dim)]; if (c) openDimPopover('filters', state.filters.indexOf(dim), c); }, 0);
}

function setupZones() {
  $$('.zone').forEach(z => {
    z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('over'); });
    z.addEventListener('dragleave', () => z.classList.remove('over'));
    z.addEventListener('drop', e => {
      e.preventDefault(); z.classList.remove('over');
      const payload = e.dataTransfer.getData('text/plain');
      const zone = z.dataset.zone;
      try {
        const p = JSON.parse(payload);
        if (p.from) { const [d] = state[p.from].splice(p.index, 1); state[zone].push(d); render(); return; }
        if (p.path) addDim(zone, p.path);
      } catch { /* ignore */ }
    });
  });
}

// distinct values for a field across current data (respecting select-multiple splitting)
function distinctValues(dim) {
  const counts = new Map();
  const probe = { ...dim, values: null };
  for (const r of data) for (const v of dimValues(r, probe)) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => (a[0] === EMPTY) - (b[0] === EMPTY) || a[0].localeCompare(b[0], undefined, { numeric: true }));
}

function openDimPopover(zone, i, anchor) {
  const d = state[zone][i];
  const f = fieldMap.get(d.path) || { name: d.path };
  const k = kindOf(f);
  const pop = $('#popover');
  const vals = distinctValues(d);
  const sel = new Set(d.values || []);
  pop.innerHTML = `
    <h4>${esc(fieldLabel(f))}</h4>
    ${k === 'date' ? `<label>Regrouper par période <select id="pPeriod">${Object.entries(PERIODS).map(([v, l]) => `<option value="${v}" ${v === (d.period || 'month') ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
    ${f.selectMultiple ? `<label style="display:flex;gap:6px;align-items:center;color:var(--ink)"><input type="checkbox" id="pSplit" ${d.split !== false ? 'checked' : ''}> Compter chaque option cochée séparément</label>` : ''}
    <label>${zone === 'filters' ? 'Garder uniquement ces valeurs' : 'Afficher uniquement ces valeurs (aucune = toutes)'}</label>
    <input type="search" id="pSearch" placeholder="Rechercher parmi ${vals.length} valeurs">
    <div class="vals">${vals.slice(0, 500).map(([v, n]) => `<label><input type="checkbox" value="${esc(v)}" ${sel.has(v) ? 'checked' : ''}> ${esc(tidy(v))}<span class="n">${n}</span></label>`).join('')}</div>
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
    ${kindOf(f) === 'num' ? '<button class="ghost" data-z="measure">Utiliser comme valeur (somme)</button>' : ''}</div>`;
  place(pop, anchor);
  $$('[data-z]', pop).forEach(b => (b.onclick = () => {
    pop.hidden = true;
    if (b.dataset.z === 'measure') { state.measure = { agg: 'sum', field: path }; render(); }
    else addDim(b.dataset.z, path);
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
  if (!e.target.closest('.menu')) $('#downloadMenu').hidden = true;
});

// ------------------------------------------------------------------ field list
function renderFieldList() {
  const q = $('#fieldSearch').value.toLowerCase();
  const used = usedPaths();
  const ul = $('#fieldList'); ul.innerHTML = '';
  let lastGroup = null;
  const groupOf = f => f.system ? 'Métadonnées de soumission' : f.path.includes('/') ? f.path.split('/').slice(0, -1).join(' / ') : 'Champs du formulaire';
  const order = [...new Set(fields.map(groupOf))];
  const sorted = [...fields].sort((a, b) => order.indexOf(groupOf(a)) - order.indexOf(groupOf(b)));
  for (const f of sorted) {
    if (q && !(f.name + ' ' + f.path).toLowerCase().includes(q)) continue;
    const group = groupOf(f);
    if (group !== lastGroup) {
      const g = document.createElement('li'); g.className = 'group'; g.textContent = tidy(group); ul.appendChild(g); lastGroup = group;
    }
    const k = kindOf(f); const [tag, cls] = TYPE_TAG[k];
    const li = document.createElement('li');
    li.draggable = true; li.title = f.path;
    if (used.has(f.path)) li.className = 'used';
    li.innerHTML = `<span class="ftype ${cls}">${tag}</span><span class="fname">${esc(fieldLabel(f))}</span>`;
    li.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', JSON.stringify({ path: f.path })));
    li.addEventListener('click', () => openAddPopover(f.path, li));
    ul.appendChild(li);
  }
}

// ------------------------------------------------------------------ controls <-> state
function syncControls() {
  $('#visType').value = state.type;
  $('#agg').value = state.measure.agg;
  const nums = fields.filter(f => kindOf(f) === 'num');
  $('#measureField').innerHTML = '<option value="">— champ numérique —</option>' + nums.map(f => `<option value="${esc(f.path)}">${esc(fieldLabel(f))}</option>`).join('');
  $('#measureField').value = state.measure.field || '';
  $('#measureField').hidden = ['count', 'pct'].includes(state.measure.agg);
  $('#optValues').checked = state.options.showValues;
  $('#optPretty').checked = state.options.pretty;
  $('#optHideEmpty').checked = state.options.hideEmpty;
  $('#optSort').value = state.options.sort;
  $('#optLimit').value = state.options.limit || '';
  $('#title').value = state.title || '';
  $('#from').value = state.from || ''; $('#to').value = state.to || '';
  $('#reviewState').value = state.reviewState || '';
}

function bindControls() {
  $('#visType').onchange = e => { state.type = e.target.value; render(); };
  $('#agg').onchange = e => {
    state.measure.agg = e.target.value;
    if (!['count', 'pct'].includes(state.measure.agg) && !state.measure.field) {
      const n = fields.find(f => kindOf(f) === 'num'); if (n) state.measure.field = n.path;
    }
    render();
  };
  $('#measureField').onchange = e => { state.measure.field = e.target.value; render(); };
  $('#optValues').onchange = e => { state.options.showValues = e.target.checked; render(); };
  $('#optPretty').onchange = e => { state.options.pretty = e.target.checked; render(); };
  $('#optHideEmpty').onchange = e => { state.options.hideEmpty = e.target.checked; render(); };
  $('#optSort').onchange = e => { state.options.sort = e.target.value; render(); };
  $('#optLimit').onchange = e => { state.options.limit = Math.max(0, parseInt(e.target.value) || 0); render(); };
  $('#title').oninput = e => { state.title = e.target.value; };
  $('#fieldSearch').oninput = renderFieldList;

  $('#project').onchange = async e => { state.projectId = e.target.value; state.formId = null; resetLayout(); await loadForms(); };
  $('#form').onchange = async e => { state.formId = e.target.value; state.table = 'Submissions'; resetLayout(); await loadForm(); };
  $('#table').onchange = async e => { state.table = e.target.value; resetLayout(); setFieldsForTable(); await loadData(); };
  $('#from').onchange = e => { state.from = e.target.value; loadData(); };
  $('#to').onchange = e => { state.to = e.target.value; loadData(); };
  $('#reviewState').onchange = e => { state.reviewState = e.target.value; loadData(); };
  $('#btnRefresh').onclick = () => loadData(true);

  $('#btnNew').onclick = () => { const keep = { projectId: state.projectId, formId: state.formId, table: state.table }; state = { ...blankState(), ...keep }; history.replaceState(null, '', location.pathname); render(); };
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
  if (!state.formId) { data = []; fields = []; render(); return; }
  const base = `/api/projects/${state.projectId}/forms/${encodeURIComponent(state.formId)}`;
  const [tables, flds] = await Promise.all([api(base + '/tables'), api(base + '/fields')]);
  allFields = flds;
  $('#table').innerHTML = tables.map(t => `<option value="${esc(t)}">${esc(t === 'Submissions' ? 'Soumissions (principale)' : 'Répétition : ' + t.replace(/^Submissions\./, ''))}</option>`).join('');
  if (!tables.includes(state.table)) state.table = 'Submissions';
  $('#table').value = state.table;
  setFieldsForTable();
  await loadData();
}

// Submissions table: all non-repeat fields. Repeat table "Submissions.a.b": fields under a/b, paths made relative.
function setFieldsForTable() {
  const repeats = allFields.filter(f => f.repeat).map(f => f.path);
  const prefix = state.table === 'Submissions' ? '' : state.table.replace(/^Submissions\./, '').replace(/\./g, '/');
  const owner = p => repeats.filter(r => p.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0] || '';
  fields = allFields
    .filter(f => !f.repeat && owner(f.path) === prefix)
    .map(f => ({ ...f, path: prefix ? f.path.slice(prefix.length + 1) : f.path }));
  if (!prefix) fields = [...fields, ...SYSTEM_FIELDS];
  fieldMap = new Map(fields.map(f => [f.path, f]));
}

async function loadData(refresh = false) {
  if (!state.formId) return;
  const p = new URLSearchParams({ table: state.table });
  if (state.from) p.set('from', state.from);
  if (state.to) p.set('to', state.to);
  if (state.reviewState) p.set('reviewState', state.reviewState);
  if (refresh) p.set('refresh', '1');
  $('#rowCount').textContent = 'Chargement…';
  try {
    const res = await api(`/api/projects/${state.projectId}/forms/${encodeURIComponent(state.formId)}/data?${p}`);
    data = res.rows;
    $('#rowCount').textContent = `${data.length.toLocaleString('fr-FR')} soumissions · ${new Date(res.fetchedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`;
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
  const draw = () => {
    const q = $('#openSearch').value.toLowerCase();
    $('#openList').innerHTML = list.filter(v => v.name.toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(v => `<li data-id="${v.id}"><span>${esc(v.name)}<br><span class="owner">${v.mine ? 'Moi' : esc(v.ownerName || v.owner || '')}</span></span><small>${esc($(`#visType option[value="${v.type}"]`)?.textContent || v.type)} · ${new Date(v.updatedAt).toLocaleDateString('fr-FR')}</small>${v.mine ? '<button type="button" class="del" title="Supprimer">🗑</button>' : ''}</li>`).join('')
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
    state = { ...blankState(), ...v, options: { ...blankState().options, ...v.options } };
    if (!v.mine) state.id = null; // someone else's: "Save" will create a copy
    history.replaceState(null, '', `#/${id}`);
    await loadProjects();
  } catch (e) { if (e.status !== 401) { toast(e.message, true); history.replaceState(null, '', location.pathname); await loadProjects().catch(() => {}); } }
}

// ------------------------------------------------------------------ downloads
function fileName(ext) { return (state.title || state.name || 'odk-visualization').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.' + ext; }
function saveBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
const csvCell = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

function download(kind) {
  if (kind === 'png') {
    if (!chart) return toast('L\'export PNG fonctionne pour les graphiques. Utilisez le CSV pour les tableaux.', true);
    const url = chart.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
    fetch(url).then(r => r.blob()).then(b => saveBlob(b, fileName('png')));
  } else if (kind === 'table') {
    const res = lastResult; if (!res) return toast('Rien à exporter pour l\'instant', true);
    const head = [res.rowDims.map(d => d.path).join(' · ') || '', ...(res.hasSeries ? res.colKeys : [measureLabel()]), ...(res.hasSeries ? ['Total'] : [])];
    const lines = [head, ...res.rowKeys.map((k, i) => [k, ...res.matrix[i], ...(res.hasSeries ? [res.rowTotals[i]] : [])])];
    saveBlob(new Blob(['﻿' + lines.map(l => l.map(csvCell).join(',')).join('\n')], { type: 'text/csv' }), fileName('csv'));
  } else {
    const rows = lastFiltered.length ? lastFiltered : data;
    if (!rows.length) return toast('Rien à exporter pour l\'instant', true);
    const cols = ['__id', ...fields.filter(f => kindOf(f) !== 'geo').map(f => f.path)];
    const lines = [cols, ...rows.map(r => cols.map(c => get(r, c)))];
    saveBlob(new Blob(['﻿' + lines.map(l => l.map(csvCell).join(',')).join('\n')], { type: 'text/csv' }), fileName('raw.csv'));
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
  if (fresh || serverChanged) { state = blankState(); data = []; allFields = []; fields = []; fieldMap = new Map(); }
  render();
  const id = location.hash.match(/^#\/([\w-]+)/);
  try {
    if (id) await openVis(id[1]); else await loadProjects();
  } catch (e) { if (e.status !== 401) toast(e.message, true); }
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  history.replaceState(null, '', location.pathname + location.hash);
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
  document.addEventListener('mousedown', e => { if (!e.target.closest('.menu')) $('#userMenu').hidden = true; });
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
