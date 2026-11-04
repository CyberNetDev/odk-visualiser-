// Registry of data platforms. Each connector exposes the same operations:
//   login, logout, access, projects, forms, tables, fields, labels, filterKey, source(...)
// and source() returns { fetch, rootSig, changedSince, count, delta, childDelta } for the cache.

const odk = require('./odk');
const iaso = require('./iaso');
const commcare = require('./commcare');

const ALL = { odk, iaso, commcare };

// Servers proposed on the login screen (the user can type another one)
const PRESETS = {
  odk: [],
  iaso: [{ url: 'https://iaso.bluesquare.org', label: 'IASO Bluesquare (iaso.bluesquare.org)' }],
  commcare: [
    { url: 'https://www.commcarehq.org', label: 'CommCare HQ — monde (www.commcarehq.org)' },
    { url: 'https://eu.commcarehq.org', label: 'CommCare HQ — Europe (eu.commcarehq.org)' },
    { url: 'https://india.commcarehq.org', label: 'CommCare HQ — Inde (india.commcarehq.org)' },
  ],
};

module.exports = { ALL, PRESETS };
