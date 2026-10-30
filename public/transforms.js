/* ODK Visualizer — field formatter / transformation engine (no dependencies).
   A transformation turns the value of a field (or several fields) of a row into a new value:
     number    text → number (decimal comma, units), × / + , rounding
     bins      number → classes ("< 5", "5 – 14", "15 et +")
     recode    regroup values into groups ("Forage", "Robinet" → "Eau améliorée")
     text      case, trim, accents, replace (regex), extract, first N characters
     date      text → date (JJ/MM/AAAA, MM/JJ/AAAA, timestamps, Excel serial numbers…)
     datepart  date → year, quarter, month, week, weekday, hour…
     duration  age / duration between two dates (years, months, days, hours, minutes)
     formula   calculation with ${champ} references: + - * / ^, comparisons, if(), round(), selected()…
     display   display format of a number (decimals, prefix/suffix, thousands, k/M, %)
   Works in the browser (window.ODKT) and in Node (module.exports) for tests. */
(function (root) {
  'use strict';

  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const WEEKDAYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

  const isEmpty = v => v == null || v === '' || (typeof v === 'number' && isNaN(v));
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // ------------------------------------------------------------------ numbers
  // "1 234,5" "1,234.5" "12 %" "FCFA 3 000" "-4.2e3" → number | null
  function parseNumber(v, decimalComma = 'auto') {
    if (isEmpty(v)) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    let s = String(v).trim().replace(/[\s\u00a0\u202f']/g, '');
    const m = s.match(/[-+]?[\d.,]*\d(?:[eE][-+]?\d+)?/);
    if (!m) return null;
    s = m[0];
    const hasC = s.includes(','), hasD = s.includes('.');
    let comma = decimalComma === true || decimalComma === 'yes';
    if (decimalComma === 'auto') {
      if (hasC && hasD) comma = s.lastIndexOf(',') > s.lastIndexOf('.');
      else if (hasC) comma = !/^\d{1,3}(,\d{3})+$/.test(s.replace(/^[-+]/, '')) || /,\d{1,2}$/.test(s);
    } else if (decimalComma === false || decimalComma === 'no') comma = false;
    s = comma ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  function roundTo(x, d) { if (x == null || d == null || d === '') return x; const p = 10 ** Number(d); return Math.round(x * p) / p; }

  // display format: { decimals, prefix, suffix, scale: 1|1e3|1e6|'auto', percent, thousands }
  function formatNumber(v, f = {}, compact = false) {
    if (isEmpty(v)) return '';
    let x = Number(v);
    if (!isFinite(x)) return String(v);
    if (f.percent) x *= 100;
    let scale = Number(f.scale) || 1, sfx = '';
    if (f.scale === 'auto' || (compact && scale === 1)) scale = Math.abs(x) >= 1e6 ? 1e6 : Math.abs(x) >= 1e4 ? 1e3 : 1;
    if (scale === 1e3) sfx = ' k'; else if (scale === 1e6) sfx = ' M';
    x /= scale;
    const dec = f.decimals === '' || f.decimals == null ? null : Number(f.decimals);
    const opts = { useGrouping: f.thousands !== false };
    if (dec != null) { opts.minimumFractionDigits = compact ? 0 : dec; opts.maximumFractionDigits = dec; }
    else opts.maximumFractionDigits = compact || scale > 1 ? 1 : Number.isInteger(x) ? 0 : 2;
    let s = x.toLocaleString('fr-FR', opts) + sfx;
    if (f.percent) s += ' %';
    return (f.prefix ? f.prefix + (/\w$/.test(f.prefix) ? ' ' : '') : '') + s + (f.suffix ? (/^\w/.test(f.suffix) ? ' ' : '') + f.suffix : '');
  }

  // ------------------------------------------------------------------ dates
  const pad = n => String(n).padStart(2, '0');
  const iso = (y, m, d, hh, mm, ss) => {
    const dt = new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0));
    if (isNaN(dt) || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return hh == null ? dt.toISOString().slice(0, 10) : dt.toISOString();
  };
  const fullYear = y => (y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y);

  // → 'YYYY-MM-DD' or full ISO string; null if not a date
  function parseDate(v, format = 'auto', keepTime = false) {
    if (isEmpty(v)) return null;
    if (v instanceof Date) return isNaN(v) ? null : (keepTime ? v.toISOString() : v.toISOString().slice(0, 10));
    const s = String(v).trim();
    const n = parseNumber(s, false);
    if (format === 'unix') return n == null ? null : cut(new Date(n * 1000));
    if (format === 'unixms') return n == null ? null : cut(new Date(n));
    if (format === 'excel') return n == null ? null : cut(new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000)));
    function cut(d) { return isNaN(d) ? null : keepTime ? d.toISOString() : d.toISOString().slice(0, 10); }
    // wall-clock time as written by the device (an offset such as +01:00 is ignored on purpose, so that
    // a submission made at 00:30 local time stays on its own day)
    const time = s.match(/[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const t = time && keepTime ? [Number(time[1]), Number(time[2]), Number(time[3] || 0)] : [];
    let m;
    if ((format === 'auto' || format === 'YYYY-MM-DD') && (m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
      return iso(+m[1], +m[2], +m[3], ...t);
    }
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) {
      let [a, b, y] = [+m[1], +m[2], fullYear(+m[3])];
      if (format === 'MM/DD/YYYY' || (format === 'auto' && b > 12 && a <= 12)) [a, b] = [b, a]; // a = day, b = month
      if (format === 'YYYY-MM-DD') return null;
      return iso(y, b, a, ...t);
    }
    if (format === 'auto' && (m = s.match(/^(\d{1,2})\s+([a-zéû.]+)\s+(\d{4})/i))) {
      const mi = MONTHS.findIndex(x => x.startsWith(m[2].toLowerCase().replace('.', '').slice(0, 3)));
      if (mi >= 0) return iso(+m[3], mi + 1, +m[1]);
    }
    if (format === 'auto' && /^\d{9,13}$/.test(s)) return cut(new Date(s.length > 10 ? +s : +s * 1000));
    return null;
  }
  const toDate = v => { const s = parseDate(v, 'auto', true); return s ? new Date(s.length === 10 ? s + 'T00:00:00Z' : s) : null; };

  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return `${t.getUTCFullYear()}-S${pad(Math.ceil(((t - y0) / 86400000 + 1) / 7))}`;
  }

  const DATE_PARTS = {
    year: { label: 'Année', fn: d => String(d.getUTCFullYear()) },
    quarter: { label: 'Trimestre (T1…T4)', fn: d => `T${Math.floor(d.getUTCMonth() / 3) + 1}`, order: ['T1', 'T2', 'T3', 'T4'] },
    yearquarter: { label: 'Année-trimestre (2026-T1)', fn: d => `${d.getUTCFullYear()}-T${Math.floor(d.getUTCMonth() / 3) + 1}` },
    month: { label: 'Mois (janvier…décembre)', fn: d => MONTHS[d.getUTCMonth()], order: MONTHS },
    yearmonth: { label: 'Année-mois (2026-03)', fn: d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}` },
    week: { label: 'Semaine ISO (2026-S12)', fn: isoWeek },
    weekday: { label: 'Jour de la semaine (lundi…dimanche)', fn: d => WEEKDAYS[(d.getUTCDay() + 6) % 7], order: WEEKDAYS },
    day: { label: 'Jour du mois (1…31)', fn: d => String(d.getUTCDate()) },
    hour: { label: 'Heure (00 h…23 h)', fn: d => `${pad(d.getUTCHours())} h`, order: Array.from({ length: 24 }, (_, i) => `${pad(i)} h`) },
    date: { label: 'Date seule (AAAA-MM-JJ)', fn: d => d.toISOString().slice(0, 10), type: 'date' },
  };

  const UNITS = { years: 'années', months: 'mois', weeks: 'semaines', days: 'jours', hours: 'heures', minutes: 'minutes' };
  function between(a, b, unit) {
    if (!a || !b) return null;
    const ms = b - a;
    switch (unit) {
      case 'years': {
        let y = b.getUTCFullYear() - a.getUTCFullYear();
        const before = b.getUTCMonth() < a.getUTCMonth() || (b.getUTCMonth() === a.getUTCMonth() && b.getUTCDate() < a.getUTCDate());
        const whole = y - (before ? 1 : 0);
        // fractional part for decimals
        const anniv = new Date(Date.UTC(a.getUTCFullYear() + whole, a.getUTCMonth(), a.getUTCDate()));
        const nextA = new Date(Date.UTC(a.getUTCFullYear() + whole + 1, a.getUTCMonth(), a.getUTCDate()));
        return whole + (b - anniv) / (nextA - anniv);
      }
      case 'months': {
        const whole = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
        return whole + ((b.getUTCDate() - a.getUTCDate() + 31) % 31) / 31;
      }
      case 'weeks': return ms / 604800000;
      case 'days': return ms / 86400000;
      case 'hours': return ms / 3600000;
      default: return ms / 60000;
    }
  }

  // ------------------------------------------------------------------ text
  const stripAccents = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  function transformText(v, o) {
    if (isEmpty(v)) return null;
    let s = String(v);
    if (o.trim !== false) s = s.trim();
    if (o.collapse !== false) s = s.replace(/\s+/g, ' ');
    if (o.accents) s = stripAccents(s);
    for (const r of o.replace || []) {
      if (!r || !r.find) continue;
      try { s = s.replace(r.regex ? new RegExp(r.find, 'gi') : new RegExp(r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), r.by ?? ''); } catch { /* invalid regex: ignored */ }
    }
    if (o.extract) {
      try { const m = s.match(new RegExp(o.extract, 'i')); s = m ? (m[1] ?? m[0]) : ''; } catch { /* ignore */ }
    }
    if (o.first > 0) s = s.slice(0, Number(o.first));
    switch (o.case) {
      case 'upper': s = s.toUpperCase(); break;
      case 'lower': s = s.toLowerCase(); break;
      case 'title': s = s.toLowerCase().replace(/(^|[\s\-'’(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()); break;
      case 'sentence': s = cap(s.toLowerCase()); break;
    }
    return s === '' ? null : s;
  }

  // ------------------------------------------------------------------ bins
  function binSpec(o, sampleIsInteger) {
    const ints = o.integer ?? sampleIsInteger;
    const fmt = x => formatNumber(x, { decimals: ints ? 0 : null });
    let edges;
    if (o.mode === 'width') {
      const w = parseNumber(o.width) || 10, start = parseNumber(o.start) ?? 0, n = Math.min(200, Number(o.count) || 10);
      edges = Array.from({ length: n + 1 }, (_, i) => start + i * w);
    } else {
      edges = String(o.breaks || '').split(/[;\s]+|,(?=\s|\d|-)/).map(x => parseNumber(x)).filter(x => x != null);
      edges = [...new Set(edges)].sort((a, b) => a - b);
    }
    const custom = String(o.labels || '').split(/[;|]/).map(x => x.trim()).filter(Boolean);
    const classes = [];
    const openLow = o.mode !== 'width' || o.openEnds !== false;
    if (openLow && edges.length) classes.push({ hi: edges[0], label: `< ${fmt(edges[0])}` });
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1];
      classes.push({ lo, hi, label: ints && Number.isInteger(lo) && Number.isInteger(hi) ? (hi - 1 === lo ? fmt(lo) : `${fmt(lo)} – ${fmt(hi - 1)}`) : `${fmt(lo)} – < ${fmt(hi)}` });
    }
    if (edges.length) classes.push({ lo: edges[edges.length - 1], label: `${fmt(edges[edges.length - 1])} et +` });
    classes.forEach((c, i) => { if (custom[i]) c.label = custom[i]; });
    return classes;
  }
  const binOf = (x, classes) => {
    if (x == null) return null;
    for (const c of classes) if ((c.lo == null || x >= c.lo) && (c.hi == null || x < c.hi)) return c.label;
    return null;
  };

  // ------------------------------------------------------------------ formula language
  // ${name} or {path} field references; numbers; "text"; operators + - * / % ^ & (concat), = == != <> < > <= >=,
  // and/or/not (&& || !); functions below. Empty values propagate (like a spreadsheet blank) except in
  // coalesce(), if(), concat(), selected(), count_selected(), len(), isempty().
  const FUNCS = {
    round: (x, n) => (x == null ? null : roundTo(x, n == null ? 0 : n)),
    floor: x => (x == null ? null : Math.floor(x)), int: x => (x == null ? null : Math.trunc(x)),
    ceil: x => (x == null ? null : Math.ceil(x)), abs: x => (x == null ? null : Math.abs(x)),
    sqrt: x => (x == null || x < 0 ? null : Math.sqrt(x)), pow: (x, y) => (x == null || y == null ? null : x ** y),
    log: x => (x == null || x <= 0 ? null : Math.log(x)), log10: x => (x == null || x <= 0 ? null : Math.log10(x)), exp: x => (x == null ? null : Math.exp(x)),
    min: (...a) => { const v = a.filter(x => x != null); return v.length ? Math.min(...v) : null; },
    max: (...a) => { const v = a.filter(x => x != null); return v.length ? Math.max(...v) : null; },
    sum: (...a) => { const v = a.filter(x => x != null); return v.length ? v.reduce((p, c) => p + c, 0) : null; },
    avg: (...a) => { const v = a.filter(x => x != null); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; },
  };
  const RAW_FUNCS = { // receive raw values (not coerced to numbers)
    coalesce: (...a) => a.find(x => !isEmpty(x)) ?? null,
    if: (c, a, b) => (truthy(c) ? a : b),
    isempty: x => isEmpty(x),
    concat: (...a) => a.filter(x => !isEmpty(x)).join(''),
    len: x => (isEmpty(x) ? 0 : String(x).length),
    upper: x => (isEmpty(x) ? null : String(x).toUpperCase()), lower: x => (isEmpty(x) ? null : String(x).toLowerCase()),
    trim: x => (isEmpty(x) ? null : String(x).trim()),
    substr: (x, a, b) => (isEmpty(x) ? null : String(x).substr(Number(a) || 0, b == null ? undefined : Number(b))),
    contains: (x, y) => !isEmpty(x) && String(x).toLowerCase().includes(String(y ?? '').toLowerCase()),
    selected: (x, v) => !isEmpty(x) && String(x).split(/\s+/).includes(String(v)),
    count_selected: x => (isEmpty(x) ? 0 : String(x).split(/\s+/).filter(Boolean).length),
    number: x => parseNumber(x), text: x => (isEmpty(x) ? null : String(x)),
    today: () => new Date().toISOString().slice(0, 10), now: () => new Date().toISOString(),
    date: x => parseDate(x),
    year: x => { const d = toDate(x); return d ? d.getUTCFullYear() : null; },
    month: x => { const d = toDate(x); return d ? d.getUTCMonth() + 1 : null; },
    day: x => { const d = toDate(x); return d ? d.getUTCDate() : null; },
    weekday: x => { const d = toDate(x); return d ? (d.getUTCDay() + 6) % 7 + 1 : null; },
    days_between: (a, b) => { const x = toDate(a), y = toDate(b); return x && y ? (y - x) / 86400000 : null; },
    years_between: (a, b) => { const x = toDate(a), y = toDate(b); return x && y ? Math.floor(between(x, y, 'years')) : null; },
  };
  const truthy = v => !(v == null || v === false || v === 0 || v === '' || v === 'false' || v === 'no' || v === '0');
  const num = v => (typeof v === 'number' ? v : parseNumber(v, 'auto'));

  function tokenize(src) {
    const toks = []; let i = 0;
    const err = msg => { const e = new Error(`${msg} (position ${i + 1})`); e.pos = i; throw e; };
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '$' && src[i + 1] === '{') { const j = src.indexOf('}', i); if (j < 0) err('« } » manquant'); toks.push({ t: 'ref', v: src.slice(i + 2, j).trim(), byName: true }); i = j + 1; continue; }
      if (c === '{') { const j = src.indexOf('}', i); if (j < 0) err('« } » manquant'); toks.push({ t: 'ref', v: src.slice(i + 1, j).trim() }); i = j + 1; continue; }
      if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1]))) { const m = src.slice(i).match(/^\d*\.?\d+(?:[eE][-+]?\d+)?/); toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue; }
      if (c === '"' || c === "'") { let j = i + 1, s = ''; while (j < src.length && src[j] !== c) { s += src[j] === '\\' ? src[++j] : src[j]; j++; } if (j >= src.length) err('guillemet non fermé'); toks.push({ t: 'str', v: s }); i = j + 1; continue; }
      const op = src.slice(i).match(/^(<=|>=|==|!=|<>|&&|\|\||[-+*/%^&()<>=!,])/);
      if (op) { toks.push({ t: 'op', v: op[0] }); i += op[0].length; continue; }
      const id = src.slice(i).match(/^[A-Za-z_][\w]*/);
      if (id) { const w = id[0].toLowerCase(); toks.push(['and', 'or', 'not'].includes(w) ? { t: 'op', v: { and: '&&', or: '||', not: '!' }[w] } : ['true', 'false', 'null'].includes(w) ? { t: 'lit', v: { true: true, false: false, null: null }[w] } : { t: 'id', v: w }); i += id[0].length; continue; }
      err(`caractère inattendu « ${c} »`);
    }
    return toks;
  }

  // precedence climbing → AST
  const BIN = { '||': 1, '&&': 2, '=': 3, '==': 3, '!=': 3, '<>': 3, '<': 4, '>': 4, '<=': 4, '>=': 4, '&': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7, '^': 9 };
  function parseFormula(src) {
    const toks = tokenize(String(src || ''));
    let p = 0;
    const peek = () => toks[p], next = () => toks[p++];
    const expect = v => { const t = next(); if (!t || t.v !== v) throw new Error(`« ${v} » attendu`); };
    function primary() {
      const t = next();
      if (!t) throw new Error('expression incomplète');
      if (t.t === 'num' || t.t === 'str' || t.t === 'lit') return { k: 'lit', v: t.v };
      if (t.t === 'ref') return { k: 'ref', v: t.v, byName: !!t.byName };
      if (t.t === 'op' && t.v === '(') { const e = expr(0); expect(')'); return e; }
      if (t.t === 'op' && (t.v === '-' || t.v === '+')) return { k: 'un', op: t.v, a: expr(8) };
      if (t.t === 'op' && t.v === '!') return { k: 'un', op: '!', a: expr(8) };
      if (t.t === 'id') {
        if (!FUNCS[t.v] && !RAW_FUNCS[t.v]) throw new Error(`fonction inconnue « ${t.v} »`);
        expect('(');
        const args = [];
        if (peek() && peek().v !== ')') { do { args.push(expr(0)); } while (peek() && peek().v === ',' && next()); }
        expect(')');
        return { k: 'call', f: t.v, args };
      }
      throw new Error(`« ${t.v} » inattendu`);
    }
    function expr(minPrec) {
      let left = primary();
      for (;;) {
        const t = peek();
        if (!t || t.t !== 'op' || BIN[t.v] == null || BIN[t.v] < minPrec) break;
        next();
        const prec = BIN[t.v];
        const right = expr(t.v === '^' ? prec : prec + 1);
        left = { k: 'bin', op: t.v, a: left, b: right };
      }
      return left;
    }
    const ast = expr(0);
    if (p < toks.length) throw new Error(`« ${toks[p].v} » inattendu`);
    const refs = [];
    (function walk(n) { if (!n) return; if (n.k === 'ref') refs.push(n); (n.args || []).forEach(walk); walk(n.a); walk(n.b); })(ast);
    return { ast, refs };
  }

  function evalAst(n, ref) {
    switch (n.k) {
      case 'lit': return n.v;
      case 'ref': return ref(n);
      case 'un': { const a = evalAst(n.a, ref); if (n.op === '!') return !truthy(a); const x = num(a); return x == null ? null : n.op === '-' ? -x : x; }
      case 'call': {
        const vals = n.args.map(a => evalAst(a, ref));
        return RAW_FUNCS[n.f] ? RAW_FUNCS[n.f](...vals) : FUNCS[n.f](...vals.map(num));
      }
      case 'bin': {
        if (n.op === '&&') return truthy(evalAst(n.a, ref)) && truthy(evalAst(n.b, ref));
        if (n.op === '||') return truthy(evalAst(n.a, ref)) || truthy(evalAst(n.b, ref));
        const a = evalAst(n.a, ref), b = evalAst(n.b, ref);
        if (n.op === '&') return (isEmpty(a) ? '' : String(a)) + (isEmpty(b) ? '' : String(b));
        if (['=', '==', '!=', '<>', '<', '>', '<=', '>='].includes(n.op)) {
          if (isEmpty(a) || isEmpty(b)) return ['=', '=='].includes(n.op) ? isEmpty(a) && isEmpty(b) : ['!=', '<>'].includes(n.op) ? isEmpty(a) !== isEmpty(b) : false;
          const x = num(a), y = num(b);
          const numeric = x != null && y != null && !(typeof a === 'string' && isNaN(Number(a)) && typeof b === 'string');
          const A = numeric ? x : String(a).toLowerCase(), B = numeric ? y : String(b).toLowerCase();
          switch (n.op) { case '=': case '==': return A === B; case '!=': case '<>': return A !== B; case '<': return A < B; case '>': return A > B; case '<=': return A <= B; default: return A >= B; }
        }
        const x = num(a), y = num(b);
        if (x == null || y == null) return null;
        switch (n.op) {
          case '+': return x + y; case '-': return x - y; case '*': return x * y;
          case '/': return y === 0 ? null : x / y; case '%': return y === 0 ? null : x % y; case '^': return x ** y;
        }
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ compile a definition
  // def: { id, name, kind, source, opts, format }
  // ctx: { get(row, path), resolve(nameOrPath) → path, sourceIsInteger }
  // returns { fn(row) → value, type, order, multi, refs }
  function compile(def, ctx) {
    const o = def.opts || {};
    const src = row => ctx.get(row, def.source);
    switch (def.kind) {
      case 'number': {
        const mul = parseNumber(o.multiply) ?? 1, add = parseNumber(o.add) ?? 0;
        return {
          type: o.round === 0 || o.round === '0' ? 'int' : 'decimal', refs: [def.source],
          fn: row => { let x = parseNumber(src(row), o.decimalComma ?? 'auto'); if (x == null) return o.emptyAsZero ? 0 : null; x = x * mul + add; return o.round === '' || o.round == null ? x : roundTo(x, o.round); },
        };
      }
      case 'bins': {
        const classes = binSpec(o, ctx.sourceIsInteger);
        return { type: 'select1', order: classes.map(c => c.label), refs: [def.source], fn: row => binOf(parseNumber(src(row)), classes) };
      }
      case 'recode': {
        const map = o.map || {}, order = [...new Set([...(o.order || []), ...Object.values(map)].filter(Boolean))];
        const other = o.others || 'keep';
        if (other === 'other' && !order.includes(o.otherLabel || 'Autre')) order.push(o.otherLabel || 'Autre');
        const one = v => {
          const g = map[v];
          if (g) return g;
          return other === 'keep' ? (ctx.labelOf ? ctx.labelOf(def.source, v) : v) : other === 'other' ? (o.otherLabel || 'Autre') : null;
        };
        return {
          type: 'select1', order, multi: !!ctx.sourceIsMulti, refs: [def.source],
          fn: row => {
            const v = src(row);
            if (isEmpty(v)) return null;
            if (ctx.sourceIsMulti) { const out = [...new Set(String(v).split(/\s+/).filter(Boolean).map(one).filter(x => x != null))]; return out.length ? out : null; }
            return one(String(v));
          },
        };
      }
      case 'text': return { type: o.asCategory === false ? 'string' : 'select1', refs: [def.source], fn: row => transformText(src(row), o) };
      case 'date': return { type: o.keepTime ? 'dateTime' : 'date', refs: [def.source], fn: row => parseDate(src(row), o.format || 'auto', !!o.keepTime) };
      case 'datepart': {
        const part = DATE_PARTS[o.part] || DATE_PARTS.month;
        return { type: part.type || 'select1', order: part.order, refs: [def.source], fn: row => { const d = toDate(src(row)); return d ? part.fn(d) : null; } };
      }
      case 'duration': {
        const toPath = o.to === 'today' ? null : o.toField;
        return {
          type: Number(o.decimals) > 0 ? 'decimal' : 'int', refs: toPath ? [def.source, toPath] : [def.source],
          fn: row => {
            const a = toDate(src(row)), b = toPath ? toDate(ctx.get(row, toPath)) : new Date();
            let x = between(a, b, o.unit || 'years');
            if (x == null || !isFinite(x)) return null;
            if (o.abs) x = Math.abs(x);
            const d = Number(o.decimals) || 0;
            return d > 0 ? roundTo(x, d) : (x < 0 ? Math.ceil(x) : Math.floor(x));
          },
        };
      }
      case 'formula': {
        const { ast, refs } = parseFormula(o.expr);
        const paths = refs.map(r => { const p = r.byName ? ctx.resolve(r.v) : r.v; if (!p) throw new Error(`champ inconnu « ${r.v} »`); r.path = p; return p; });
        const out = o.output || 'number';
        return {
          type: out === 'number' ? 'decimal' : out === 'date' ? 'date' : out === 'text' ? 'string' : 'select1', refs: paths,
          fn: row => {
            const v = evalAst(ast, r => ctx.get(row, r.path));
            if (out === 'number') { if (typeof v === 'boolean') return v ? 1 : 0; return num(v); }
            if (out === 'date') return parseDate(v);
            if (isEmpty(v)) return null;
            return typeof v === 'boolean' ? (v ? 'Oui' : 'Non') : typeof v === 'number' ? formatNumber(v, {}) : String(v);
          },
        };
      }
      default: return { type: 'string', refs: [], fn: () => null };
    }
  }

  const KINDS = {
    number: 'Convertir en nombre',
    bins: 'Classes / tranches (nombre → catégories)',
    recode: 'Regrouper / recoder des valeurs',
    text: 'Format du texte (casse, espaces, remplacer…)',
    date: 'Convertir du texte en date',
    datepart: 'Extraire une partie de la date',
    duration: 'Âge / durée entre deux dates',
    formula: 'Calcul (formule)',
    display: 'Format d\'affichage du nombre',
  };

  const api = { parseNumber, formatNumber, parseDate, toDate, transformText, binSpec, binOf, parseFormula, evalAst, compile, between, DATE_PARTS, UNITS, KINDS, MONTHS, WEEKDAYS, FUNCTIONS: [...Object.keys(FUNCS), ...Object.keys(RAW_FUNCS)].sort() };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ODKT = api;
})(typeof window !== 'undefined' ? window : globalThis);
