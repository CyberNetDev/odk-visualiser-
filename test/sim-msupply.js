// mSupply simulators, to test the connector without a real server. Usage: node test/sim-msupply.js [port] (4640)
//  • port      : Open mSupply GraphQL API (POST /graphql), schema written from the Open mSupply source code
//                (msupply-foundation/open-msupply, server/graphql). It is executed by graphql-js (dev dependency),
//                so queries are validated like a real server. This schema is an *older* one on purpose: it lacks
//                StockLineNode.supplierName, to check that the connector drops fields a server does not know.
//  • port + 1  : mSupply Desktop web server, REST API v4 (from the mSupply documentation): /api/v4/login (JWT
//                cookie, 2 hours), /storeCustomerInvoice (mSupply user), /stock and /customerInvoice (store contact).
// Accounts: Open mSupply  admin / pass (stores Pharmacie centrale + Dépôt Nord), pharmacien / pass (Dépôt Nord only)
//           Desktop       gestionnaire / pass (mSupply user), client1 / pass (store contact)
// Simulator controls: POST /sim/ship (an outbound shipment changes status), /sim/new-invoice ; GET /sim/stats

const http = require('node:http');
const crypto = require('node:crypto');
const { buildSchema, graphql } = require('graphql');

const PORT = Number(process.argv[2] || 4640);

let seed = 31;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = a => a[Math.floor(rnd() * a.length)];
const id = () => crypto.randomUUID();

const schema = buildSchema(`
  scalar DateTime
  scalar NaiveDate
  type Query {
    authToken(username: String!, password: String!): AuthTokenResponse!
    me: UserResponse!
    logout: LogoutResponse!
    stockLines(storeId: String!, page: PaginationInput, filter: StockLineFilterInput, sort: [StockLineSortInput!], timezoneOffset: Int): StockLinesResponse!
    invoices(storeId: String!, page: PaginationInput, filter: InvoiceFilterInput, sort: [InvoiceSortInput!]): InvoicesResponse!
    requisitions(storeId: String!, page: PaginationInput, filter: RequisitionFilterInput, sort: [RequisitionSortInput!]): RequisitionsResponse!
  }
  union AuthTokenResponse = AuthToken | AuthTokenError
  type AuthToken { token: String! expiryDate: Int! userId: String! }
  type AuthTokenError { error: AuthTokenErrorInterface! }
  interface AuthTokenErrorInterface { description: String! }
  type InvalidCredentials implements AuthTokenErrorInterface { description: String! }
  type AccountBlocked implements AuthTokenErrorInterface { description: String! timeoutRemaining: Int! }
  type NoSiteAccess implements AuthTokenErrorInterface { description: String! }
  union UserResponse = UserNode
  type UserNode { userId: String! username: String! email: String firstName: String lastName: String defaultStore: UserStoreNode stores: UserStoreConnector! }
  type UserStoreConnector { totalCount: Int! nodes: [UserStoreNode!]! }
  type UserStoreNode { id: String! code: String! nameId: String! name: String! }
  union LogoutResponse = Logout
  type Logout { userId: String! }
  input PaginationInput { first: Int offset: Int }
  input EqualFilterStringInput { equalTo: String equalAny: [String!] notEqualTo: String }
  input DatetimeFilterInput { equalTo: DateTime beforeOrEqualTo: DateTime afterOrEqualTo: DateTime }
  type ItemNode { id: String! code: String! name: String! unitName: String }
  union StockLinesResponse = StockLineConnector
  type StockLineConnector { totalCount: Int! nodes: [StockLineNode!]! }
  type StockLineNode { id: String! itemId: String! itemName: String! storeId: String! batch: String packSize: Float! costPricePerPack: Float! sellPricePerPack: Float!
    availableNumberOfPacks: Float! totalNumberOfPacks: Float! expiryDate: NaiveDate onHold: Boolean! note: String locationName: String item: ItemNode! }
  input StockLineFilterInput { isAvailable: Boolean itemId: EqualFilterStringInput }
  enum StockLineSortFieldInput { expiryDate numberOfPacks itemCode itemName batch packSize }
  input StockLineSortInput { key: StockLineSortFieldInput! desc: Boolean }
  enum InvoiceNodeType { OUTBOUND_SHIPMENT INBOUND_SHIPMENT PRESCRIPTION INVENTORY_ADDITION INVENTORY_REDUCTION SUPPLIER_RETURN CUSTOMER_RETURN REPACK }
  enum InvoiceNodeStatus { NEW ALLOCATED PICKED SHIPPED DELIVERED RECEIVED VERIFIED CANCELLED }
  enum InvoiceLineNodeType { STOCK_IN STOCK_OUT UNALLOCATED_STOCK SERVICE }
  input EqualFilterInvoiceTypeInput { equalTo: InvoiceNodeType equalAny: [InvoiceNodeType!] notEqualTo: InvoiceNodeType }
  input EqualFilterInvoiceStatusInput { equalTo: InvoiceNodeStatus equalAny: [InvoiceNodeStatus!] notEqualTo: InvoiceNodeStatus }
  input InvoiceFilterInput { id: EqualFilterStringInput type: EqualFilterInvoiceTypeInput status: EqualFilterInvoiceStatusInput createdDatetime: DatetimeFilterInput }
  enum InvoiceSortFieldInput { type otherPartyName invoiceNumber comment status createdDatetime shippedDatetime }
  input InvoiceSortInput { key: InvoiceSortFieldInput! desc: Boolean }
  union InvoicesResponse = InvoiceConnector
  type InvoiceConnector { totalCount: Int! nodes: [InvoiceNode!]! }
  type PricingNode { totalBeforeTax: Float! totalAfterTax: Float! }
  type InvoiceNode { id: String! invoiceNumber: Int! type: InvoiceNodeType! status: InvoiceNodeStatus! otherPartyName: String! otherPartyId: String! theirReference: String comment: String
    createdDatetime: DateTime! allocatedDatetime: DateTime pickedDatetime: DateTime shippedDatetime: DateTime deliveredDatetime: DateTime receivedDatetime: DateTime verifiedDatetime: DateTime
    pricing: PricingNode! user: UserNode lines: InvoiceLineConnector! }
  type InvoiceLineConnector { totalCount: Int! nodes: [InvoiceLineNode!]! }
  type InvoiceLineNode { id: String! invoiceId: String! type: InvoiceLineNodeType! itemId: String! itemCode: String! itemName: String! batch: String expiryDate: NaiveDate packSize: Float!
    numberOfPacks: Float! costPricePerPack: Float! sellPricePerPack: Float! totalBeforeTax: Float! totalAfterTax: Float! locationName: String note: String item: ItemNode! }
  enum RequisitionNodeType { REQUEST RESPONSE }
  enum RequisitionNodeStatus { DRAFT NEW SENT FINALISED }
  input EqualFilterRequisitionTypeInput { equalTo: RequisitionNodeType equalAny: [RequisitionNodeType!] }
  input EqualFilterRequisitionStatusInput { equalTo: RequisitionNodeStatus equalAny: [RequisitionNodeStatus!] }
  input RequisitionFilterInput { type: EqualFilterRequisitionTypeInput status: EqualFilterRequisitionStatusInput createdDatetime: DatetimeFilterInput }
  enum RequisitionSortFieldInput { requisitionNumber type status otherPartyName sentDatetime createdDatetime finalisedDatetime }
  input RequisitionSortInput { key: RequisitionSortFieldInput! desc: Boolean }
  union RequisitionsResponse = RequisitionConnector
  type RequisitionConnector { totalCount: Int! nodes: [RequisitionNode!]! }
  type PeriodNode { id: String! name: String! }
  type RequisitionNode { id: String! requisitionNumber: Int! type: RequisitionNodeType! status: RequisitionNodeStatus! otherPartyName: String! theirReference: String comment: String
    createdDatetime: DateTime! sentDatetime: DateTime finalisedDatetime: DateTime programName: String period: PeriodNode user: UserNode lines: RequisitionLineConnector! }
  type RequisitionLineConnector { totalCount: Int! nodes: [RequisitionLineNode!]! }
  type RequisitionLineNode { id: String! itemId: String! itemName: String! requestedQuantity: Float! suggestedQuantity: Float! approvedQuantity: Float! supplyQuantity: Float!
    averageMonthlyConsumption: Float! availableStockOnHand: Float! comment: String item: ItemNode! }
`);

// ------------------------------------------------------------------ data
const STORES = [{ id: 'store-central', code: 'PC', nameId: 'n1', name: 'Pharmacie centrale' }, { id: 'store-nord', code: 'DN', nameId: 'n2', name: 'Dépôt Nord' }];
const USERS = { admin: { pw: 'pass', first: 'Fatoumata', last: 'Keita', stores: ['store-central', 'store-nord'] }, pharmacien: { pw: 'pass', first: 'Moussa', last: 'Coulibaly', stores: ['store-nord'] } };
const ITEMS = [['AMOX500', 'Amoxicilline 500 mg gélule', 'gélule', 100], ['PARA500', 'Paracétamol 500 mg comprimé', 'comprimé', 1000], ['ACT-AL', 'Artéméther-luméfantrine 20/120', 'comprimé', 24],
  ['SRO', 'Sels de réhydratation orale', 'sachet', 50], ['ZINC20', 'Zinc 20 mg comprimé', 'comprimé', 100], ['TDR-PALU', 'Test de diagnostic rapide paludisme', 'test', 25],
  ['OXY10', 'Ocytocine 10 UI injectable', 'ampoule', 50], ['GANTS-M', 'Gants d\'examen taille M', 'paire', 100]].map(([code, name, unitName, pack]) => ({ id: 'item-' + code, code, name, unitName, pack }));
const CUSTOMERS = ['CS Kati', 'CS Koulikoro', 'CSRéf Ségou', 'CS Sikasso', 'Hôpital de Kayes'];
const SUPPLIERS = ['CAMEG', 'PPM', 'UNICEF', 'Fonds mondial'];
const now = Date.now();
const dt = t => new Date(t).toISOString();
const dayOf = t => new Date(t).toISOString().slice(0, 10);

const stock = [];
for (const s of STORES) for (const it of ITEMS) for (let k = 0; k < 1 + Math.floor(rnd() * 3); k++) {
  const packs = Math.floor(rnd() * 300) - 20;
  stock.push({ id: id(), storeId: s.id, itemId: it.id, itemName: it.name, item: it, batch: `L${Math.floor(rnd() * 90000 + 10000)}`, packSize: it.pack,
    costPricePerPack: Math.round(rnd() * 20000) / 100, sellPricePerPack: Math.round(rnd() * 30000) / 100, totalNumberOfPacks: Math.max(0, packs), availableNumberOfPacks: Math.max(0, packs - 5),
    expiryDate: rnd() < 0.05 ? null : dayOf(now + (rnd() * 900 - 120) * 864e5), onHold: rnd() < 0.05, locationName: pick(['Étagère A', 'Étagère B', 'Chambre froide', null]) });
}
const invoices = [];
let invNo = 1;
const ORDER = ['NEW', 'ALLOCATED', 'PICKED', 'SHIPPED', 'DELIVERED', 'VERIFIED'];
function addInvoice(store, type, t, status) {
  const party = type === 'INBOUND_SHIPMENT' ? pick(SUPPLIERS) : type === 'PRESCRIPTION' ? `Patient ${Math.floor(rnd() * 900 + 100)}` : type.startsWith('INVENTORY') ? 'Inventaire' : pick(CUSTOMERS);
  const inv = { id: id(), storeId: store, invoiceNumber: invNo++, type, status, otherPartyName: party, otherPartyId: 'n-' + party, theirReference: rnd() < 0.5 ? `REF-${Math.floor(rnd() * 9999)}` : null,
    comment: rnd() < 0.2 ? 'Livraison partielle' : null, createdDatetime: dt(t), user: { userId: 'u1', username: pick(['admin', 'pharmacien']), stores: { totalCount: 0, nodes: [] } }, lines: [] };
  const idx = ORDER.indexOf(status);
  if (idx >= 3) inv.shippedDatetime = dt(t + 864e5);
  if (idx >= 4) inv.deliveredDatetime = dt(t + 3 * 864e5);
  if (idx >= 5) inv.verifiedDatetime = dt(t + 4 * 864e5);
  if (type === 'INBOUND_SHIPMENT' && idx >= 4) inv.receivedDatetime = dt(t + 3 * 864e5);
  const n = 1 + Math.floor(rnd() * 5);
  for (let k = 0; k < n; k++) {
    const it = pick(ITEMS);
    const packs = Math.ceil(rnd() * 40), price = Math.round(rnd() * 20000) / 100;
    inv.lines.push({ id: id(), invoiceId: inv.id, type: type === 'INBOUND_SHIPMENT' || type === 'INVENTORY_ADDITION' ? 'STOCK_IN' : 'STOCK_OUT', itemId: it.id, itemCode: it.code, itemName: it.name,
      batch: `L${Math.floor(rnd() * 90000 + 10000)}`, expiryDate: dayOf(t + 500 * 864e5), packSize: it.pack, numberOfPacks: packs, costPricePerPack: price, sellPricePerPack: price * 1.2,
      totalBeforeTax: Math.round(packs * price * 120) / 100, totalAfterTax: Math.round(packs * price * 120) / 100, locationName: null, note: null, item: it });
  }
  inv.pricing = { totalBeforeTax: inv.lines.reduce((a, l) => a + l.totalAfterTax, 0), totalAfterTax: Math.round(inv.lines.reduce((a, l) => a + l.totalAfterTax, 0) * 100) / 100 };
  invoices.push(inv);
  return inv;
}
for (const s of STORES) {
  for (let i = 0; i < 700; i++) addInvoice(s.id, 'OUTBOUND_SHIPMENT', now - rnd() * 400 * 864e5, pick([...ORDER, 'VERIFIED', 'VERIFIED', 'SHIPPED']));
  for (let i = 0; i < 120; i++) addInvoice(s.id, 'INBOUND_SHIPMENT', now - rnd() * 400 * 864e5, pick(['NEW', 'DELIVERED', 'VERIFIED', 'VERIFIED']));
  for (let i = 0; i < 300; i++) addInvoice(s.id, 'PRESCRIPTION', now - rnd() * 200 * 864e5, pick(['PICKED', 'VERIFIED']));
  for (let i = 0; i < 30; i++) addInvoice(s.id, pick(['INVENTORY_ADDITION', 'INVENTORY_REDUCTION']), now - rnd() * 300 * 864e5, 'VERIFIED');
}
const requisitions = [];
for (const s of STORES) for (const type of ['REQUEST', 'RESPONSE']) for (let i = 0; i < 60; i++) {
  const t = now - rnd() * 360 * 864e5;
  const r = { id: id(), storeId: s.id, requisitionNumber: i + 1, type, status: pick(['DRAFT', 'SENT', 'FINALISED', 'FINALISED']), otherPartyName: type === 'REQUEST' ? pick(SUPPLIERS) : pick(CUSTOMERS),
    theirReference: null, comment: null, createdDatetime: dt(t), sentDatetime: dt(t + 864e5), finalisedDatetime: dt(t + 10 * 864e5), programName: pick(['Paludisme', 'Santé maternelle', null]),
    period: { id: 'p' + i, name: new Date(t).toISOString().slice(0, 7) }, user: null, lines: [] };
  for (const it of ITEMS.filter(() => rnd() < 0.5)) {
    const amc = Math.round(rnd() * 400), soh = Math.round(rnd() * 900);
    r.lines.push({ id: id(), itemId: it.id, itemName: it.name, requestedQuantity: Math.max(0, amc * 3 - soh), suggestedQuantity: Math.max(0, amc * 3 - soh), approvedQuantity: 0,
      supplyQuantity: type === 'RESPONSE' ? Math.max(0, amc * 2 - soh) : 0, averageMonthlyConsumption: amc, availableStockOnHand: soh, comment: null, item: it });
  }
  requisitions.push(r);
}

// ------------------------------------------------------------------ GraphQL resolvers
const tokens = new Map();
let served = 0;
const err = (message, details) => Object.assign(new Error(message), { extensions: { details } });
function page(list, { page: pg, sort }, sortKeys) {
  let out = [...list];
  const s = Array.isArray(sort) ? sort[0] : sort;
  if (s) { const k = sortKeys[s.key] || s.key; out.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (s.desc ? -1 : 1)); }
  const first = pg && pg.first != null ? pg.first : 100, offset = (pg && pg.offset) || 0;
  return { totalCount: out.length, nodes: out.slice(offset, offset + first) };
}
const eq = (f, v) => !f || (f.equalTo == null || f.equalTo === v) && (!f.equalAny || f.equalAny.includes(v)) && (f.notEqualTo == null || f.notEqualTo !== v);
const dtf = (f, v) => !f || ((!f.afterOrEqualTo || v >= new Date(f.afterOrEqualTo).toISOString()) && (!f.beforeOrEqualTo || v <= new Date(f.beforeOrEqualTo).toISOString()));
function guard(ctx, storeId) {
  if (!ctx.user) throw err('Unauthenticated', 'Missing or invalid authentication token');
  if (storeId && !USERS[ctx.user].stores.includes(storeId)) throw err('Forbidden', `User has no access to store ${storeId}`);
}
const root = {
  authToken: ({ username, password }) => {
    const u = USERS[username];
    if (!u || u.pw !== password) return { __typename: 'AuthTokenError', error: { __typename: 'InvalidCredentials', description: 'Invalid credentials' } };
    const token = crypto.randomBytes(24).toString('hex');
    tokens.set(token, username);
    return { __typename: 'AuthToken', token, expiryDate: Math.floor(Date.now() / 1000) + 3600, userId: username };
  },
  me: (a, ctx) => { guard(ctx); const u = USERS[ctx.user]; const st = STORES.filter(s => u.stores.includes(s.id));
    return { __typename: 'UserNode', userId: ctx.user, username: ctx.user, firstName: u.first, lastName: u.last, defaultStore: st[0], stores: { totalCount: st.length, nodes: st } }; },
  logout: (a, ctx) => { tokens.delete(ctx.token); return { __typename: 'Logout', userId: ctx.user || '' }; },
  stockLines: (a, ctx) => { guard(ctx, a.storeId); const r = page(stock.filter(x => x.storeId === a.storeId), a, {}); served += r.nodes.length; return { __typename: 'StockLineConnector', ...r }; },
  invoices: (a, ctx) => {
    guard(ctx, a.storeId);
    const f = a.filter || {};
    const list = invoices.filter(x => x.storeId === a.storeId && eq(f.type, x.type) && eq(f.status, x.status) && dtf(f.createdDatetime, x.createdDatetime) && eq(f.id, x.id))
      .map(x => ({ ...x, lines: { totalCount: x.lines.length, nodes: x.lines } }));
    const r = page(list, a, {});
    if (!a.page || a.page.first !== 1) served += r.nodes.length;
    return { __typename: 'InvoiceConnector', ...r };
  },
  requisitions: (a, ctx) => {
    guard(ctx, a.storeId);
    const f = a.filter || {};
    const list = requisitions.filter(x => x.storeId === a.storeId && eq(f.type, x.type) && eq(f.status, x.status) && dtf(f.createdDatetime, x.createdDatetime))
      .map(x => ({ ...x, lines: { totalCount: x.lines.length, nodes: x.lines } }));
    return { __typename: 'RequisitionConnector', ...page(list, a, {}) };
  },
};

http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const u = new URL(req.url, 'http://x');
  const json = (o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/sim/stats') { const s = served; served = 0; return json({ served: s }); }
  if (u.pathname === '/sim/ship') { const inv = invoices.find(x => x.storeId === 'store-central' && x.type === 'OUTBOUND_SHIPMENT' && x.status === 'PICKED'); inv.status = 'SHIPPED'; inv.shippedDatetime = dt(Date.now()); return json({ id: inv.id }); }
  if (u.pathname === '/sim/new-invoice') return json({ id: addInvoice('store-central', 'OUTBOUND_SHIPMENT', Date.now(), 'NEW').id });
  if (u.pathname !== '/graphql' || req.method !== 'POST') { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('<html>Not found</html>'); }
  let q; try { q = JSON.parse(body); } catch { return json({ errors: [{ message: 'Invalid JSON' }] }, 400); }
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  const result = await graphql({ schema, source: q.query, rootValue: root, variableValues: q.variables, contextValue: { user: tokens.get(token) || null, token } });
  json(result);
}).listen(PORT, () => console.log(`Open mSupply simulé sur http://localhost:${PORT}/graphql`));

// ------------------------------------------------------------------ mSupply Desktop (REST API v4)
const DESK_USERS = { gestionnaire: { pw: 'pass', loginType: 'storeInvoice', first: 'Aminata', last: 'Diarra' }, client1: { pw: 'pass', loginType: 'invoice', first: 'CS', last: 'Kati' } };
const jwts = new Map();
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const u = new URL(req.url, 'http://x');
  const json = (o, c = 200, h = {}) => { res.writeHead(c, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/api/v4/login' && req.method === 'POST') {
    let b; try { b = JSON.parse(body); } catch { b = {}; }
    if (!b.username || !b.password || !b.loginType) return json({ error: 'Username/password/login type missing' }, 400);
    const usr = DESK_USERS[b.username];
    if (!usr || usr.pw !== b.password || usr.loginType !== b.loginType) return json({ error: 'Failed to authenticate/No store found for user' }, 401);
    const token = `${b64({ alg: 'HS256' })}.${b64({ user: b.username, exp: Math.floor(Date.now() / 1000) + 7200 })}.${crypto.randomBytes(12).toString('base64url')}`;
    jwts.set(token, b.username);
    // the JWT comes as a cookie (the documentation shows no token in the body)
    return json({ status: 'success', authenticated: true, username: b.username, userFirstName: usr.first, userLastName: usr.last, userJobTitle: '', userType: b.loginType === 'invoice' ? 'contact' : 'user',
      service: b.loginType, storeName: 'Pharmacie centrale' }, 200, { 'Set-Cookie': `jwt=${token}; Path=/; HttpOnly` });
  }
  const cookieJwt = ((req.headers.cookie || '').match(/(?:^|;\s*)jwt=([^;]+)/) || [])[1];
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  const who = jwts.get(bearer) || jwts.get(cookieJwt);
  if (!who) return json({ error: 'JWT token/user ID/store ID not found' }, 401);
  const usr = DESK_USERS[who];
  const lines = inv => inv.lines.map(l => ({ itemCode: l.itemCode, itemName: l.itemName, batchName: l.batch, expiryDate: `${l.expiryDate}T00:00:00.000Z`, unit: l.item.unitName, barcode: '',
    packPrice: l.sellPricePerPack, packSize: l.packSize, quantity: l.numberOfPacks, comment: '', lineTotal: l.totalAfterTax }));
  if (u.pathname === '/api/v4/storeCustomerInvoice') {
    if (usr.loginType !== 'storeInvoice') return json({ error: 'Selected store is not default for user' }, 401);
    const a = u.searchParams.get('startDate'), b = u.searchParams.get('endDate');
    if (!a || !b) return json({ error: 'End date/Start date is mandatory' }, 401);
    const list = invoices.filter(x => x.storeId === 'store-central' && x.type === 'OUTBOUND_SHIPMENT' && x.shippedDatetime && x.createdDatetime.slice(0, 10) >= a && x.createdDatetime.slice(0, 10) <= b);
    return json(list.map(x => ({ ID: x.id, customerName: x.otherPartyName, customerCode: x.otherPartyName.slice(0, 4).toUpperCase(), invoiceNumber: x.invoiceNumber, orderNumber: x.invoiceNumber + 1000,
      confirmedDate: x.createdDatetime, receivedDate: x.createdDatetime, invoiceReference: x.theirReference || '', comment: x.comment || '', storeName: 'Pharmacie centrale',
      invoiceTotal: x.pricing.totalAfterTax, lines: lines(x) })));
  }
  if (usr.loginType !== 'invoice') return json({ error: 'JWT token/user ID/store ID not found' }, 401);
  if (u.pathname === '/api/v4/stock') return json(stock.filter(s => s.storeId === 'store-central' && s.totalNumberOfPacks > 0).map(s => ({ itemCode: s.item.code, itemName: s.itemName, batchName: s.batch,
    expiryDate: s.expiryDate ? `${s.expiryDate}T00:00:00.000Z` : '', unit: s.item.unitName, barcode: '', packSize: s.packSize, quantity: s.totalNumberOfPacks, costPricePerPack: s.costPricePerPack,
    sellPricePerPack: s.sellPricePerPack, storeName: 'Pharmacie centrale' })));
  if (u.pathname === '/api/v4/customerInvoice') return json(invoices.filter(x => x.storeId === 'store-central' && x.otherPartyName === 'CS Kati' && x.status === 'SHIPPED').map(x => ({
    ID: x.id, invoiceNumber: x.invoiceNumber, confirmedDate: x.createdDatetime, receivedDate: '', acknowledgedDate: '', cancelledDate: '', invoiceReference: x.theirReference || '', comment: x.comment || '',
    orderNumber: x.invoiceNumber + 1000, storeName: 'Pharmacie centrale', invoiceTotal: x.pricing.totalAfterTax, lines: lines(x) })));
  json({ error: 'Not found' }, 404);
}).listen(PORT + 1, () => console.log(`mSupply Desktop (API REST v4) simulé sur http://localhost:${PORT + 1}`));
