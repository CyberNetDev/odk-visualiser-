// Helpers shared by every connector (ODK Central, IASO, CommCare).

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

async function fetchWithTimeout(url, opts = {}, ms = 20_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

// Accepts "central.org", "https://central.org/", "https://central.org/#/projects/3" ... → "https://central.org"
// `strip` removes a trailing API suffix the user may have pasted (e.g. /v1 for ODK, /api for IASO).
function normalizeServer(input, strip = /\/v1$/) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    const p = u.pathname.replace(/\/+$/, '').replace(strip, '');
    return `${u.protocol}//${u.host}${p}`;
  } catch { return ''; }
}

// Small per-process memo. Concurrent callers share the same promise; failures are not kept.
const memo = new Map();
function memoize(key, fn, ms) {
  const hit = memo.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < ms)) return hit.promise;
  const entry = { at: Date.now(), pending: true };
  entry.promise = Promise.resolve().then(fn).then(v => { entry.pending = false; entry.at = Date.now(); return v; },
    e => { if (memo.get(key) === entry) memo.delete(key); throw e; });
  memo.set(key, entry);
  if (memo.size > 2000) memo.delete(memo.keys().next().value);
  return entry.promise;
}
function forget(prefix) { for (const k of [...memo.keys()]) if (k.startsWith(prefix)) memo.delete(k); }

// "lat lon [alt [accuracy]]" (XForms), "lat,lon", {lat, lon}, {"#text": ...} or GeoJSON → GeoJSON Point
// (the shape ODK Central's OData feed uses, so the map works the same for every platform).
function toGeoPoint(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    if (v.type === 'Point' && Array.isArray(v.coordinates)) return v;
    if ('#text' in v) return toGeoPoint(v['#text']);
    const lat = v.lat ?? v.latitude, lon = v.lon ?? v.lng ?? v.longitude;
    if (lat != null && lon != null) return toGeoPoint(`${lat} ${lon} ${v.alt ?? v.altitude ?? ''}`);
    return null;
  }
  const n = String(v).trim().split(/[\s,;]+/).map(Number);
  if (n.length < 2 || !Number.isFinite(n[0]) || !Number.isFinite(n[1]) || Math.abs(n[0]) > 90 || Math.abs(n[1]) > 180) return null;
  if (n[0] === 0 && n[1] === 0) return null;
  const coordinates = [n[1], n[0]];
  if (Number.isFinite(n[2])) coordinates.push(n[2]);
  const g = { type: 'Point', coordinates };
  if (Number.isFinite(n[3])) g.properties = { accuracy: n[3] };
  return g;
}

const enc = encodeURIComponent;
const isoOrNull = t => (t == null || t === '' ? null : new Date(typeof t === 'number' ? t * 1000 : t).toISOString());

module.exports = { httpError, fetchWithTimeout, normalizeServer, memoize, forget, toGeoPoint, enc, isoOrNull };
