// mSupply connector: logistics data (stock, shipments, dispensing, requisitions), not forms.
//
// Two kinds of mSupply servers, detected at sign-in:
//  • Open mSupply (msupply-foundation/open-msupply, GraphQL API, checked against its source code):
//      POST /graphql  authToken(username, password) → token, then "Authorization: Bearer <token>"
//      me { stores { nodes { id code name } } }                       → "projects" = stores
//      stockLines(storeId, page: {first, offset}, sort)               → stock on hand by batch
//      invoices(storeId, page, sort, filter: {type, status, createdDatetime}) { nodes { …, lines { nodes } } }
//      requisitions(storeId, page, sort, filter: {type, createdDatetime}) { nodes { …, lines { nodes } } }
//    Fields that an older server does not know are dropped automatically ("Unknown field" errors).
//  • mSupply Desktop web server, REST API v4 (from the mSupply documentation; it is made for customer
//    ordering, so it exposes less): POST /api/v4/login (JWT, 2 hours), GET /api/v4/storeCustomerInvoice
//    (mSupply user), GET /api/v4/stock and /api/v4/customerInvoice (store contact).
//
// Datasets become "forms": a transaction (shipment, requisition) is a row and its lines a child table,
// joined like ODK repeats. There is no "modified since" filter: changes are detected with counts per
// status, and transactions are fully reloaded at least every hour.

const { httpError, fetchWithTimeout, normalizeServer, memoize, isoOrNull } = require('./common');

const PAGE = Number(process.env.MSUPPLY_PAGE_SIZE || 500);
const META_MS = Number(process.env.CACHE_MINUTES || 5) * 60_000;
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

const userKey = sess => `msupply|${sess.server}|${sess.email}`;
const lit = v => JSON.stringify(String(v)); // GraphQL string literal
const fr = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { '': v }]));
const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const day = v => (v ? String(v).slice(0, 10) : null);

const INVOICE_STATUS = { NEW: 'Nouvelle', ALLOCATED: 'Allouée', PICKED: 'Préparée', SHIPPED: 'Expédiée', DELIVERED: 'Livrée', RECEIVED: 'Réceptionnée', VERIFIED: 'Vérifiée', CANCELLED: 'Annulée' };
const INVOICE_TYPE = { OUTBOUND_SHIPMENT: 'Expédition sortante', INBOUND_SHIPMENT: 'Réception', PRESCRIPTION: 'Dispensation', INVENTORY_ADDITION: 'Ajout d\'inventaire',
  INVENTORY_REDUCTION: 'Réduction d\'inventaire', SUPPLIER_RETURN: 'Retour fournisseur', CUSTOMER_RETURN: 'Retour client', REPACK: 'Reconditionnement' };
const LINE_TYPE = { STOCK_IN: 'Entrée de stock', STOCK_OUT: 'Sortie de stock', UNALLOCATED_STOCK: 'Non allouée', SERVICE: 'Service' };
const REQ_STATUS = { DRAFT: 'Brouillon', NEW: 'Nouvelle', SENT: 'Envoyée', FINALISED: 'Finalisée' };
const EXPIRY = { expired: 'Périmé', m3: 'Moins de 3 mois', m6: '3 à 6 mois', m12: '6 à 12 mois', later: 'Plus de 12 mois', none: 'Sans date de péremption' };
const YES_NO = { true: { '': 'Oui' }, false: { '': 'Non' } };

const DATASETS = {
  // unit: what a row of the main table is; dates: meaning of the date filter (false: none)
  stock: { name: 'Stock disponible (par lot)', kind: 'stock', unit: 'lots en stock', dates: false },
  outbound: { name: 'Expéditions sortantes (distribution aux clients)', kind: 'invoice', types: ['OUTBOUND_SHIPMENT'], party: 'Client', unit: 'expéditions', dates: 'Créées du' },
  inbound: { name: 'Réceptions (expéditions entrantes)', kind: 'invoice', types: ['INBOUND_SHIPMENT'], party: 'Fournisseur', unit: 'réceptions', dates: 'Créées du' },
  prescription: { name: 'Dispensations (prescriptions)', kind: 'invoice', types: ['PRESCRIPTION'], party: 'Patient', unit: 'dispensations', dates: 'Créées du' },
  adjustments: { name: 'Ajustements d\'inventaire', kind: 'invoice', types: ['INVENTORY_ADDITION', 'INVENTORY_REDUCTION'], party: 'Motif / tiers', unit: 'ajustements', dates: 'Créés du' },
  requests: { name: 'Réquisitions envoyées (commandes aux fournisseurs)', kind: 'requisition', type: 'REQUEST', party: 'Fournisseur', unit: 'réquisitions', dates: 'Créées du' },
  responses: { name: 'Réquisitions reçues (commandes des clients)', kind: 'requisition', type: 'RESPONSE', party: 'Client', unit: 'réquisitions', dates: 'Créées du' },
  // mSupply Desktop (REST API v4)
  storeInvoices: { name: 'Factures clients confirmées', kind: 'desktopInvoice', desktop: 'user', unit: 'factures', dates: 'Confirmées du' },
  desktopStock: { name: 'Stock disponible (catalogue du client)', kind: 'desktopStock', desktop: 'contact', unit: 'lots en stock', dates: false },
  customerInvoices: { name: 'Factures en cours de livraison', kind: 'desktopOpenInvoice', desktop: 'contact', unit: 'factures', dates: false },
};

// ---------------------------------------------------------------- field definitions
const ITEM = [['item_code', 'Code article', 'string'], ['item_name', 'Article', 'string'], ['unit', 'Unité', 'string']];
const STOCK_FIELDS = [...ITEM, ['batch', 'Lot', 'string'], ['expiry_date', 'Date de péremption', 'date'], ['expiry_status', 'Péremption', 'string'],
  ['days_to_expiry', 'Jours avant péremption', 'int'], ['pack_size', 'Taille du conditionnement', 'decimal'], ['packs_total', 'Conditionnements en stock', 'decimal'],
  ['packs_available', 'Conditionnements disponibles', 'decimal'], ['units_total', 'Unités en stock', 'decimal'], ['cost_price_pack', 'Prix d\'achat par conditionnement', 'decimal'],
  ['sell_price_pack', 'Prix de vente par conditionnement', 'decimal'], ['stock_value', 'Valeur du stock (prix d\'achat)', 'decimal'], ['on_hold', 'Bloqué', 'string'],
  ['location', 'Emplacement', 'string'], ['supplier', 'Fournisseur', 'string']];
const INVOICE_FIELDS = party => [['number', 'Numéro', 'int'], ['type', 'Type', 'string'], ['status', 'Statut', 'string'], ['other_party', party || 'Tiers', 'string'],
  ['their_reference', 'Référence du tiers', 'string'], ['comment', 'Commentaire', 'string'],
  ['shipped', 'Date d\'expédition', 'dateTime'], ['delivered', 'Date de livraison', 'dateTime'], ['received', 'Date de réception', 'dateTime'],
  ['verified', 'Date de vérification', 'dateTime'], ['total', 'Montant total', 'decimal'], ['lines_count', 'Nombre de lignes', 'int']];
const INVOICE_LINE_FIELDS = [...ITEM, ['line_type', 'Type de ligne', 'string'], ['batch', 'Lot', 'string'], ['expiry_date', 'Date de péremption', 'date'],
  ['pack_size', 'Taille du conditionnement', 'decimal'], ['packs', 'Nombre de conditionnements', 'decimal'], ['units', 'Quantité (unités)', 'decimal'],
  ['cost_price_pack', 'Prix d\'achat par conditionnement', 'decimal'], ['sell_price_pack', 'Prix de vente par conditionnement', 'decimal'],
  ['line_total', 'Montant de la ligne', 'decimal'], ['location', 'Emplacement', 'string'], ['note', 'Note', 'string']];
const REQ_FIELDS = party => [['number', 'Numéro', 'int'], ['status', 'Statut', 'string'], ['other_party', party, 'string'], ['their_reference', 'Référence du tiers', 'string'],
  ['comment', 'Commentaire', 'string'], ['program', 'Programme', 'string'], ['period', 'Période', 'string'],
  ['sent', 'Date d\'envoi', 'dateTime'], ['finalised', 'Date de finalisation', 'dateTime'], ['lines_count', 'Nombre de lignes', 'int']];
const REQ_LINE_FIELDS = [...ITEM, ['requested', 'Quantité demandée', 'decimal'], ['suggested', 'Quantité suggérée', 'decimal'], ['approved', 'Quantité approuvée', 'decimal'],
  ['supplied', 'Quantité à fournir', 'decimal'], ['amc', 'Consommation mensuelle moyenne', 'decimal'], ['soh', 'Stock disponible', 'decimal'],
  ['months_of_stock', 'Mois de stock', 'decimal'], ['comment', 'Commentaire', 'string']];
const DESKTOP_INVOICE_FIELDS = [['number', 'Numéro de facture', 'int'], ['order_number', 'Numéro de commande', 'int'], ['customer', 'Client', 'string'], ['customer_code', 'Code client', 'string'],
  ['reference', 'Référence', 'string'], ['comment', 'Commentaire', 'string'], ['confirmed', 'Date de confirmation', 'dateTime'], ['received', 'Date de réception', 'dateTime'],
  ['store', 'Magasin', 'string'], ['total', 'Montant total', 'decimal']];
const DESKTOP_LINE_FIELDS = [...ITEM, ['batch', 'Lot', 'string'], ['expiry_date', 'Date de péremption', 'date'], ['barcode', 'Code-barres', 'string'],
  ['pack_size', 'Taille du conditionnement', 'decimal'], ['packs', 'Nombre de conditionnements', 'decimal'], ['units', 'Quantité (unités)', 'decimal'],
  ['pack_price', 'Prix par conditionnement', 'decimal'], ['line_total', 'Montant de la ligne', 'decimal'], ['comment', 'Commentaire', 'string']];
const DESKTOP_STOCK_FIELDS = [...ITEM, ['batch', 'Lot', 'string'], ['expiry_date', 'Date de péremption', 'date'], ['expiry_status', 'Péremption', 'string'],
  ['days_to_expiry', 'Jours avant péremption', 'int'], ['barcode', 'Code-barres', 'string'], ['pack_size', 'Taille du conditionnement', 'decimal'],
  ['packs_total', 'Conditionnements en stock', 'decimal'], ['units_total', 'Unités en stock', 'decimal'], ['cost_price_pack', 'Prix d\'achat par conditionnement', 'decimal'],
  ['sell_price_pack', 'Prix de vente par conditionnement', 'decimal'], ['stock_value', 'Valeur du stock (prix d\'achat)', 'decimal'], ['store', 'Magasin', 'string']];

function schemaOf(ds) {
  const fields = [], labels = { languages: [], defaultLang: '', fields: {}, choices: {} };
  const add = (list, prefix = '') => {
    for (const [k, label, type] of list) {
      const path = prefix ? `${prefix}/${k}` : k;
      fields.push({ path, name: k, type, selectMultiple: false, repeat: false });
      labels.fields[path] = { '': label };
    }
  };
  const child = (label, list) => { fields.push({ path: 'lignes', name: 'lignes', type: 'repeat', selectMultiple: false, repeat: true }); labels.fields.lignes = { '': label }; add(list, 'lignes'); };
  if (ds.kind === 'stock') add(STOCK_FIELDS);
  else if (ds.kind === 'invoice') { add(INVOICE_FIELDS(ds.party)); child('Lignes (articles)', INVOICE_LINE_FIELDS); }
  else if (ds.kind === 'requisition') { add(REQ_FIELDS(ds.party)); child('Lignes (articles)', REQ_LINE_FIELDS); }
  else if (ds.kind === 'desktopInvoice' || ds.kind === 'desktopOpenInvoice') { add(DESKTOP_INVOICE_FIELDS); child('Lignes (articles)', DESKTOP_LINE_FIELDS); }
  else if (ds.kind === 'desktopStock') add(DESKTOP_STOCK_FIELDS);
  Object.assign(labels.choices, {
    status: fr(ds.kind === 'requisition' ? REQ_STATUS : INVOICE_STATUS), type: fr(INVOICE_TYPE), 'lignes/line_type': fr(LINE_TYPE),
    expiry_status: fr(EXPIRY), on_hold: YES_NO,
  });
  return { fields, labels };
}

function expiryInfo(date) {
  if (!date) return { expiry_status: 'none', days_to_expiry: null };
  const days = Math.floor((Date.parse(String(date).slice(0, 10) + 'T00:00:00Z') - Date.now()) / 864e5);
  return { days_to_expiry: days, expiry_status: days < 0 ? 'expired' : days < 91 ? 'm3' : days < 183 ? 'm6' : days < 366 ? 'm12' : 'later' };
}

// ---------------------------------------------------------------- Open mSupply (GraphQL)
const pruned = new Map(); // server → Set of field names this server does not know
async function gql(sess, build) {
  const drop = pruned.get(sess.server) || pruned.set(sess.server, new Set()).get(sess.server);
  for (let attempt = 0; attempt < 12; attempt++) {
    let text = build();
    for (const f of drop) text = text.replace(new RegExp(`(?<=[\\s{])${f}(\\s*\\{[^{}]*\\})?(?=[\\s}])`, 'g'), ' ');
    let res;
    try {
      res = await fetchWithTimeout(`${sess.server}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${sess.token}` }, body: JSON.stringify({ query: text }) }, 300_000);
    } catch (e) { throw httpError(502, `Serveur mSupply injoignable (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}).`); }
    if (res.status === 401) { const err = httpError(401, 'Session mSupply expirée, reconnectez-vous.'); err.relogin = true; throw err; }
    const body = await res.json().catch(() => null);
    if (!body) throw httpError(502, `Réponse inattendue du serveur mSupply (HTTP ${res.status}).`);
    const errs = body.errors || [];
    if (!errs.length) return body.data;
    const e0 = errs[0], msg = String(e0.message || ''), details = e0.extensions && e0.extensions.details;
    // async-graphql (Open mSupply): 'Unknown field "x" on type "Y"'; other servers: 'Cannot query field "x"'
    const unknown = errs.map(e => String(e.message || '').match(/(?:Unknown field|Cannot query field) "(\w+)"/)).filter(Boolean);
    if (unknown.length) { for (const m of unknown) drop.add(m[1]); continue; }
    if (/Unauthenticated/i.test(msg)) { const err = httpError(401, 'Session mSupply expirée, reconnectez-vous.'); err.relogin = true; throw err; }
    if (/Forbidden/i.test(msg)) throw httpError(403, `Votre compte mSupply n'a pas le droit de consulter ces données dans ce magasin${details ? ` (${details})` : ''}.`);
    throw httpError(502, `mSupply : ${msg}${details ? ` (${details})` : ''}`);
  }
  throw httpError(502, 'mSupply : requête impossible à adapter à la version du serveur.');
}

const dateFilter = (q, key) => {
  if (!q.from && !q.to) return '';
  const p = [];
  if (q.from) p.push(`afterOrEqualTo: ${lit(`${q.from}T00:00:00Z`)}`);
  if (q.to) p.push(`beforeOrEqualTo: ${lit(`${q.to}T23:59:59Z`)}`);
  return `, ${key}: {${p.join(', ')}}`;
};

const STOCK_Q = (store, first, offset) => `query { stockLines(storeId: ${lit(store)}, page: {first: ${first}, offset: ${offset}}, sort: {key: itemName}) { __typename
  ... on StockLineConnector { totalCount nodes { id itemId itemName batch packSize costPricePerPack sellPricePerPack availableNumberOfPacks totalNumberOfPacks
  expiryDate onHold locationName supplierName item { code unitName } } } } }`;
const invoiceFilter = (ds, q, status) => `{type: {equalAny: [${ds.types.join(', ')}]}${status ? `, status: {equalTo: ${status}}` : ''}${dateFilter(q, 'createdDatetime')}}`;
const INVOICE_Q = (store, ds, q, first, offset) => `query { invoices(storeId: ${lit(store)}, page: {first: ${first}, offset: ${offset}}, sort: {key: createdDatetime}, filter: ${invoiceFilter(ds, q)}) { __typename
  ... on InvoiceConnector { totalCount nodes { id invoiceNumber type status otherPartyName theirReference comment createdDatetime shippedDatetime deliveredDatetime
  receivedDatetime verifiedDatetime pricing { totalAfterTax } user { username } lines { nodes { id type itemCode itemName batch expiryDate packSize numberOfPacks
  costPricePerPack sellPricePerPack totalAfterTax locationName note item { unitName } } } } } } }`;
const reqFilter = (ds, q, status) => `{type: {equalTo: ${ds.type}}${status ? `, status: {equalTo: ${status}}` : ''}${dateFilter(q, 'createdDatetime')}}`;
const REQ_Q = (store, ds, q, first, offset) => `query { requisitions(storeId: ${lit(store)}, page: {first: ${first}, offset: ${offset}}, sort: {key: createdDatetime}, filter: ${reqFilter(ds, q)}) { __typename
  ... on RequisitionConnector { totalCount nodes { id requisitionNumber type status otherPartyName theirReference comment createdDatetime sentDatetime finalisedDatetime
  programName period { name } user { username } lines { nodes { id itemId itemName requestedQuantity suggestedQuantity approvedQuantity supplyQuantity
  averageMonthlyConsumption availableStockOnHand comment item { code unitName } } } } } } }`;

async function pagedGql(sess, root, build) {
  const out = [], seen = new Set();
  for (let offset = 0, g = 0; g < 100000; g++) {
    const conn = (await gql(sess, () => build(PAGE, offset)))[root] || {};
    const nodes = conn.nodes || [];
    for (const n of nodes) if (!seen.has(n.id)) { seen.add(n.id); out.push(n); }
    offset += nodes.length;
    if (!nodes.length || nodes.length < PAGE || (conn.totalCount != null && offset >= conn.totalCount)) break;
  }
  return out;
}

function stockRow(n) {
  const packs = num(n.totalNumberOfPacks), size = num(n.packSize), cost = num(n.costPricePerPack);
  return { __id: n.id, __system: { submissionDate: null }, item_code: (n.item && n.item.code) || null, item_name: n.itemName || null, unit: (n.item && n.item.unitName) || null,
    batch: n.batch || null, expiry_date: day(n.expiryDate), ...expiryInfo(n.expiryDate), pack_size: size, packs_total: packs, packs_available: num(n.availableNumberOfPacks),
    units_total: packs != null && size != null ? round(packs * size, 3) : null, cost_price_pack: cost, sell_price_pack: num(n.sellPricePerPack),
    stock_value: packs != null && cost != null ? round(packs * cost) : null, on_hold: n.onHold ? 'true' : 'false', location: n.locationName || null, supplier: n.supplierName || null };
}
function invoiceRows(nodes) {
  const tables = { Submissions: [], 'Submissions.lignes': [] }, roots = [];
  for (const n of nodes) {
    const lines = (n.lines && n.lines.nodes) || [];
    const last = [n.verifiedDatetime, n.receivedDatetime, n.deliveredDatetime, n.shippedDatetime, n.createdDatetime].find(Boolean);
    tables.Submissions.push({ __id: n.id, __system: { submissionDate: isoOrNull(n.createdDatetime), updatedAt: isoOrNull(last), submitterName: (n.user && n.user.username) || null },
      number: num(n.invoiceNumber), type: n.type || null, status: n.status || null, other_party: n.otherPartyName || null, their_reference: n.theirReference || null,
      comment: n.comment || null, shipped: isoOrNull(n.shippedDatetime), delivered: isoOrNull(n.deliveredDatetime),
      received: isoOrNull(n.receivedDatetime), verified: isoOrNull(n.verifiedDatetime), total: num(n.pricing && n.pricing.totalAfterTax), lines_count: lines.length });
    roots.push(n.id);
    for (const l of lines) {
      const packs = num(l.numberOfPacks), size = num(l.packSize);
      tables['Submissions.lignes'].push({ __id: l.id, '__Submissions-id': n.id, __root: n.id, item_code: l.itemCode || null, item_name: l.itemName || null,
        unit: (l.item && l.item.unitName) || null, line_type: l.type || null, batch: l.batch || null, expiry_date: day(l.expiryDate), pack_size: size, packs,
        units: packs != null && size != null ? round(packs * size, 3) : null, cost_price_pack: num(l.costPricePerPack), sell_price_pack: num(l.sellPricePerPack),
        line_total: num(l.totalAfterTax), location: l.locationName || null, note: l.note || null });
    }
  }
  return { tables, roots };
}
function requisitionRows(nodes) {
  const tables = { Submissions: [], 'Submissions.lignes': [] }, roots = [];
  for (const n of nodes) {
    const lines = (n.lines && n.lines.nodes) || [];
    tables.Submissions.push({ __id: n.id, __system: { submissionDate: isoOrNull(n.createdDatetime), updatedAt: isoOrNull(n.finalisedDatetime || n.sentDatetime || n.createdDatetime), submitterName: (n.user && n.user.username) || null },
      number: num(n.requisitionNumber), status: n.status || null, other_party: n.otherPartyName || null, their_reference: n.theirReference || null, comment: n.comment || null,
      program: n.programName || null, period: (n.period && n.period.name) || null, sent: isoOrNull(n.sentDatetime),
      finalised: isoOrNull(n.finalisedDatetime), lines_count: lines.length });
    roots.push(n.id);
    for (const l of lines) {
      const amc = num(l.averageMonthlyConsumption), soh = num(l.availableStockOnHand);
      tables['Submissions.lignes'].push({ __id: l.id, '__Submissions-id': n.id, __root: n.id, item_code: (l.item && l.item.code) || null, item_name: l.itemName || null,
        unit: (l.item && l.item.unitName) || null, requested: num(l.requestedQuantity), suggested: num(l.suggestedQuantity), approved: num(l.approvedQuantity),
        supplied: num(l.supplyQuantity), amc, soh, months_of_stock: amc ? round(soh / amc, 1) : null, comment: l.comment || null });
    }
  }
  return { tables, roots };
}

// ---------------------------------------------------------------- mSupply Desktop (REST v4)
async function rest(sess, path) {
  const headers = { Accept: 'application/json' };
  if (sess.token) headers.Authorization = `Bearer ${sess.token}`;
  if (sess.cookie) headers.Cookie = sess.cookie;
  let res;
  try { res = await fetchWithTimeout(`${sess.server}/api/v4${path}`, { headers }, 300_000); }
  catch (e) { throw httpError(502, `Serveur mSupply injoignable (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}).`); }
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (res.status === 401) {
    if (/mandatory|default/i.test(String(body && body.error || body))) throw httpError(400, `mSupply : ${body.error || body}`);
    const err = httpError(401, 'Session mSupply expirée (2 heures), reconnectez-vous.'); err.relogin = true; throw err;
  }
  if (!res.ok) throw httpError(res.status === 404 ? 404 : 502, `mSupply ${res.status} : ${String((body && body.error) || body).slice(0, 200)}`);
  return body;
}
const asList = b => (Array.isArray(b) ? b : b && typeof b === 'object' && (b.ID || b.invoiceNumber) ? [b] : []);
function desktopInvoiceRows(list) {
  const tables = { Submissions: [], 'Submissions.lignes': [] }, roots = [];
  for (const n of list) {
    const id = String(n.ID || `inv-${n.invoiceNumber}`);
    if (roots.includes(id)) continue;
    roots.push(id);
    tables.Submissions.push({ __id: id, __system: { submissionDate: isoOrNull(n.confirmedDate) },
      number: num(n.invoiceNumber), order_number: num(n.orderNumber), customer: n.customerName || null, customer_code: n.customerCode || null,
      reference: n.invoiceReference || null, comment: n.comment || null, confirmed: isoOrNull(n.confirmedDate), received: isoOrNull(n.receivedDate || null),
      store: n.storeName || null, total: num(n.invoiceTotal) });
    (n.lines || []).forEach((l, i) => {
      const packs = num(l.quantity), size = num(l.packSize);
      tables['Submissions.lignes'].push({ __id: `${id}/${i + 1}`, '__Submissions-id': id, __root: id, item_code: l.itemCode || null, item_name: l.itemName || null,
        unit: l.unit || null, batch: l.batchName || null, expiry_date: day(l.expiryDate), barcode: l.barcode || null, pack_size: size, packs,
        units: packs != null && size != null ? round(packs * size, 3) : null, pack_price: num(l.packPrice), line_total: num(l.lineTotal), comment: l.comment || null });
    });
  }
  return { tables, roots };
}
function desktopStockRows(list) {
  return list.map((n, i) => {
    const packs = num(n.quantity), size = num(n.packSize), cost = num(n.costPricePerPack);
    return { __id: `${n.itemCode}|${n.batchName}|${n.expiryDate}|${n.packSize}|${i}`, __system: { submissionDate: null }, item_code: n.itemCode || null, item_name: n.itemName || null,
      unit: n.unit || null, batch: n.batchName || null, expiry_date: day(n.expiryDate), ...expiryInfo(n.expiryDate), barcode: n.barcode || null, pack_size: size, packs_total: packs,
      units_total: packs != null && size != null ? round(packs * size, 3) : null, cost_price_pack: cost, sell_price_pack: num(n.sellPricePerPack),
      stock_value: packs != null && cost != null ? round(packs * cost) : null, store: n.storeName || null };
  });
}
// storeCustomerInvoice needs a date range: by default, the current year and the two previous ones
async function storeInvoices(sess, q) {
  const windows = [];
  if (q.from || q.to) windows.push([q.from || '2000-01-01', q.to || new Date().toISOString().slice(0, 10)]);
  else { const y = new Date().getUTCFullYear(); for (let k = 2; k >= 0; k--) windows.push([`${y - k}-01-01`, `${y - k}-12-31`]); }
  const all = [];
  for (const [a, b] of windows) all.push(...asList(await rest(sess, `/storeCustomerInvoice?startDate=${a}&endDate=${b}`)));
  return all;
}

const SYSTEM = {
  stock: [],
  invoice: [{ path: '__system/submissionDate', name: 'Date de création', type: 'dateTime', system: true, group: 'Dates et auteur' },
    { path: '__system/updatedAt', name: 'Date du dernier changement de statut', type: 'dateTime', system: true, group: 'Dates et auteur' },
    { path: '__system/submitterName', name: 'Saisi par', type: 'string', system: true, group: 'Dates et auteur' }],
  desktop: [{ path: '__system/submissionDate', name: 'Date de confirmation', type: 'dateTime', system: true, group: 'Dates et auteur' }],
};

module.exports = {
  id: 'msupply',
  label: 'mSupply',
  features: { reviewState: false },
  sharedCache: false,
  normalizeServer: s => normalizeServer(String(s || '').replace(/\/(graphql|api\/v4|api)(\/.*)?$/i, '').replace(/\/#.*$/, '')),

  async login({ server, email, password }) {
    const username = String(email || '').trim();
    if (!username || !password) throw httpError(400, 'Nom d\'utilisateur et mot de passe obligatoires.');
    let res, data = null;
    // 1. Open mSupply
    try {
      const query = `query { authToken(username: ${lit(username)}, password: ${lit(password)}) { __typename ... on AuthToken { token } ... on AuthTokenError { error { __typename description } } } }`;
      res = await fetchWithTimeout(`${server}/graphql`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query }) });
      if ((res.headers.get('content-type') || '').includes('json')) data = await res.json().catch(() => null);
    } catch (e) { throw httpError(502, `Impossible de joindre ${server} (${e.name === 'AbortError' ? 'délai dépassé' : e.cause?.code || e.message}). Vérifiez l'adresse.`); }
    if (data && data.data && data.data.authToken) {
      const t = data.data.authToken;
      if (t.__typename !== 'AuthToken') {
        const kind = t.error && t.error.__typename;
        throw httpError(401, kind === 'AccountBlocked' ? 'Compte mSupply bloqué temporairement après trop d\'essais.' : kind === 'NoSiteAccess' ? 'Ce compte n\'a accès à aucun magasin de ce site mSupply.'
          : kind === 'CentralSyncRequired' ? 'Le serveur central mSupply est injoignable : connexion impossible pour l\'instant.' : 'Nom d\'utilisateur ou mot de passe mSupply incorrect.');
      }
      const sess = { server, token: t.token };
      const me = (await gql(sess, () => 'query { me { __typename ... on UserNode { username firstName lastName defaultStore { id } stores { nodes { id code name } } } } }')).me || {};
      const stores = ((me.stores && me.stores.nodes) || []).map(s => ({ id: s.id, name: s.code && s.name !== s.code ? `${s.name} (${s.code})` : s.name || s.code }));
      if (me.defaultStore) stores.sort((a, b) => (b.id === me.defaultStore.id) - (a.id === me.defaultStore.id));
      return { email: me.username || username, name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || username, token: t.token,
        expiresAt: new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString(), mode: 'open', stores };
    }
    // a GraphQL answer without authToken is still an Open mSupply-like server
    let recognized = !!(data && (data.data || Array.isArray(data.errors)));
    // 2. mSupply Desktop web server (REST v4): an mSupply user, else a store contact
    for (const loginType of ['storeInvoice', 'invoice']) {
      try { res = await fetchWithTimeout(`${server}/api/v4/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ username, password, loginType }) }); }
      catch { break; }
      if (res.status === 404) break;
      const body = await res.json().catch(() => null);
      // mSupply answers "Failed to authenticate/No store found for user" (401) for a wrong password or login type
      if (body && /authenticate|login type|store found/i.test(String(body.error || body.message || ''))) recognized = true;
      if (!res.ok || !body || (body.status && body.status !== 'success')) continue;
      const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
      const pairs = cookies.map(c => c.split(';')[0]).filter(Boolean);
      const jwt = body.token || body.jwt || (pairs.map(p => p.slice(p.indexOf('=') + 1)).find(v => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(v))) || null;
      if (!jwt && !pairs.length) continue;
      return { email: body.username || username, name: [body.userFirstName, body.userLastName].filter(Boolean).join(' ') || body.username || username,
        token: jwt, cookie: pairs.join('; '), expiresAt: new Date(Date.now() + 2 * 3600e3 - 60_000).toISOString(),
        mode: loginType === 'storeInvoice' ? 'desktop-user' : 'desktop-contact', stores: [{ id: 'store', name: body.storeName || 'Magasin' }] };
    }
    if (recognized) throw httpError(401, 'Nom d\'utilisateur ou mot de passe mSupply incorrect.');
    throw httpError(502, 'Ce serveur ne répond ni comme Open mSupply (/graphql) ni comme le serveur web de mSupply Desktop (/api/v4). Vérifiez l\'adresse et la plateforme choisie.');
  },

  async logout(sess) {
    if (sess.mode === 'open') gql(sess, () => 'query { logout { __typename } }').catch(() => {});
  },

  async access(sess, pid, fid) {
    if (!(sess.stores || []).some(s => String(s.id) === String(pid))) throw httpError(403, 'Ce magasin n\'est pas accessible avec votre compte mSupply.');
    if (!DATASETS[fid]) throw httpError(404, 'Jeu de données mSupply inconnu.');
  },

  async projects(sess) { return sess.stores || []; },

  async forms(sess) {
    const want = sess.mode === 'open' ? id => !DATASETS[id].desktop : sess.mode === 'desktop-user' ? id => DATASETS[id].desktop === 'user' : id => DATASETS[id].desktop === 'contact';
    return Object.keys(DATASETS).filter(want).map(id => ({ id, name: DATASETS[id].name, unit: DATASETS[id].unit, dates: DATASETS[id].dates }));
  },

  async tables(sess, pid, fid) { return schemaOf(DATASETS[fid] || {}).fields.some(f => f.repeat) ? ['Submissions', 'Submissions.lignes'] : ['Submissions']; },

  async fields(sess, pid, fid) {
    const ds = DATASETS[fid]; if (!ds) throw httpError(404, 'Jeu de données mSupply inconnu.');
    const sys = ds.kind === 'stock' || ds.kind === 'desktopStock' ? SYSTEM.stock : ds.desktop ? SYSTEM.desktop : SYSTEM.invoice;
    return [...schemaOf(ds).fields, ...sys];
  },

  async labels(sess, pid, fid) { return schemaOf(DATASETS[fid] || {}).labels; },

  filterKey(table, q) {
    const p = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) p.push(`from=${q.from}`);
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) p.push(`to=${q.to}`);
    return p.join('&');
  },

  incremental: () => true,
  refuseIncremental: () => {},

  source(sess, pid, fid, params) {
    const ds = DATASETS[fid];
    const q = { from: /^\d{4}-\d{2}-\d{2}$/.test(params.from || '') ? params.from : '', to: /^\d{4}-\d{2}-\d{2}$/.test(params.to || '') ? params.to : '' };
    const snapshot = { rootSig: async () => '', changedSince: async () => 1, count: null, delta: null, reloadReason: 'instantané du stock, rechargé à chaque actualisation' };
    if (!ds) return { ...snapshot, fetch: async () => { throw httpError(404, 'Jeu de données mSupply inconnu.'); } };
    const memo = (fn) => memoize(`${userKey(sess)}|ds|${pid}|${fid}|${q.from}|${q.to}`, fn, 10_000);
    const slice = (dsOut, table) => ({ rows: dsOut.tables[table] || [], filtered: true, roots: table === 'Submissions' ? undefined : dsOut.roots });

    if (ds.kind === 'stock') return { ...snapshot, fetch: async () => ({ rows: (await pagedGql(sess, 'stockLines', (first, offset) => STOCK_Q(pid, first, offset))).map(stockRow).filter(r => (r.packs_total || 0) > 0), filtered: true }) };
    if (ds.kind === 'desktopStock') return { ...snapshot, fetch: async () => ({ rows: desktopStockRows(asList(await rest(sess, '/stock'))), filtered: true }) };
    if (ds.kind === 'desktopInvoice' || ds.kind === 'desktopOpenInvoice') {
      const load = () => memo(async () => desktopInvoiceRows(ds.kind === 'desktopInvoice' ? await storeInvoices(sess, q) : asList(await rest(sess, '/customerInvoice'))));
      return { ...snapshot, reloadReason: 'mSupply Desktop : pas de détection des changements', fetch: async table => slice(await load(), table) };
    }
    // Open mSupply transactions: counts per status detect new transactions and status changes; edits inside
    // a status are caught by the hourly full reload
    const isInv = ds.kind === 'invoice';
    const statuses = Object.keys(isInv ? INVOICE_STATUS : REQ_STATUS);
    const root = isInv ? 'invoices' : 'requisitions';
    const conn = isInv ? 'InvoiceConnector' : 'RequisitionConnector';
    const filterOf = (status, qq) => (isInv ? invoiceFilter(ds, qq, status) : reqFilter(ds, qq, status));
    const load = () => memo(async () => {
      const nodes = await pagedGql(sess, root, (first, offset) => (isInv ? INVOICE_Q : REQ_Q)(pid, ds, q, first, offset));
      return isInv ? invoiceRows(nodes) : requisitionRows(nodes);
    });
    return {
      fetch: async table => slice(await load(), table),
      rootSig: async () => {
        const parts = statuses.map(s => `${s}: ${root}(storeId: ${lit(pid)}, page: {first: 1}, filter: ${filterOf(s, {})}) { ... on ${conn} { totalCount } }`);
        const d = await gql(sess, () => `query { ${parts.join(' ')} }`);
        return statuses.map(s => `${s}:${d[s] ? d[s].totalCount : '?'}`).join(';');
      },
      changedSince: async () => 0,
      count: async () => {
        const d = await gql(sess, () => `query { n: ${root}(storeId: ${lit(pid)}, page: {first: 1}, filter: ${filterOf(null, q)}) { ... on ${conn} { totalCount } } }`);
        return d.n ? d.n.totalCount : null;
      },
      delta: null,
      fullRefreshHours: 1,
      reloadReason: 'nouvelle transaction ou changement de statut',
    };
  },
};
