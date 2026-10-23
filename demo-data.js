// Sample data used when ODK_URL is not configured, shaped exactly like ODK Central's OData output.

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }
const pick = (r, arr, weights) => {
  if (!weights) return arr[Math.floor(r() * arr.length)];
  const t = weights.reduce((a, b) => a + b, 0); let x = r() * t;
  for (let i = 0; i < arr.length; i++) { x -= weights[i]; if (x <= 0) return arr[i]; }
  return arr[arr.length - 1];
};

const REGIONS = { Zinder: ['Mirriah', 'Magaria', 'Matameye', 'Tanout'], Maradi: ['Aguié', 'Dakoro', 'Madarounfa'], Tahoua: ['Birni N\'Konni', 'Illéla', 'Keita'], Niamey: ['Commune I', 'Commune II', 'Commune III'] };
const ENUMERATORS = ['Abdou M.', 'Fatima I.', 'Moussa S.', 'Hadiza A.', 'Ibrahim K.', 'Zeinabou H.'];

let built = null;
function build() {
  if (built) return built;
  const r = rng(42);
  const subs = [], members = [];
  const start = new Date('2026-01-05T08:00:00Z').getTime();
  for (let i = 0; i < 1200; i++) {
    const region = pick(r, Object.keys(REGIONS), [4, 3, 2, 2]);
    const district = pick(r, REGIONS[region]);
    const submitted = new Date(start + Math.floor(r() * 290) * 86400000 + Math.floor(r() * 36000000));
    const visit = new Date(submitted.getTime() - Math.floor(r() * 3) * 86400000);
    const hhSize = 1 + Math.floor(r() * 10);
    const ill = ['malaria', 'diarrhoea', 'cough', 'fever', 'none'].filter(() => r() < 0.3);
    const id = `uuid:demo-${String(i).padStart(5, '0')}`;
    subs.push({
      __id: id,
      meta: { instanceID: id },
      start: visit.toISOString(),
      location: { region, district, gps: { type: 'Point', coordinates: [8.9 + r(), 13.8 + r(), 450] } },
      household: {
        visit_date: visit.toISOString().slice(0, 10),
        hh_size: hhSize,
        head_sex: pick(r, ['male', 'female'], [7, 3]),
        head_age: 18 + Math.floor(r() * 60),
        water_source: pick(r, ['borehole', 'protected_well', 'unprotected_well', 'tap', 'surface_water'], [4, 3, 2, 1, 1]),
        has_latrine: r() < 0.55 ? 'yes' : 'no',
        monthly_income: Math.round(15000 + r() * 120000),
        illnesses: ill.length ? ill.join(' ') : 'none',
      },
      members_count: Math.min(hhSize, 4),
      __system: {
        submissionDate: submitted.toISOString(),
        updatedAt: null,
        submitterId: String(10 + (i % 6)),
        submitterName: ENUMERATORS[i % 6],
        attachmentsPresent: 0,
        attachmentsExpected: 0,
        status: null,
        reviewState: pick(r, [null, 'approved', 'hasIssues', 'rejected'], [5, 4, 1, 0.5]),
        deviceId: `collect:${1000 + (i % 6)}`,
        edits: 0,
        formVersion: '2026010501',
      },
    });
    for (let m = 0; m < Math.min(hhSize, 4); m++) {
      members.push({
        __id: `${id}-m${m}`,
        '__Submissions-id': id,
        member_sex: pick(r, ['male', 'female']),
        member_age: Math.floor(r() * 70),
        in_school: pick(r, ['yes', 'no', 'not_applicable'], [4, 3, 2]),
        vaccinated: pick(r, ['yes', 'no', 'unknown'], [6, 2, 1]),
      });
    }
  }
  built = { subs, members };
  return built;
}

const FIELDS = [
  { path: 'start', name: 'start', type: 'dateTime' },
  { path: 'location/region', name: 'region', type: 'string' },
  { path: 'location/district', name: 'district', type: 'string' },
  { path: 'location/gps', name: 'gps', type: 'geopoint' },
  { path: 'household/visit_date', name: 'visit_date', type: 'date' },
  { path: 'household/hh_size', name: 'hh_size', type: 'int' },
  { path: 'household/head_sex', name: 'head_sex', type: 'string' },
  { path: 'household/head_age', name: 'head_age', type: 'int' },
  { path: 'household/water_source', name: 'water_source', type: 'string' },
  { path: 'household/has_latrine', name: 'has_latrine', type: 'string' },
  { path: 'household/monthly_income', name: 'monthly_income', type: 'decimal' },
  { path: 'household/illnesses', name: 'illnesses', type: 'string', selectMultiple: true },
  { path: 'members_count', name: 'members_count', type: 'int' },
  { path: 'members', name: 'members', type: 'repeat', repeat: true },
  { path: 'members/member_sex', name: 'member_sex', type: 'string' },
  { path: 'members/member_age', name: 'member_age', type: 'int' },
  { path: 'members/in_school', name: 'in_school', type: 'string' },
  { path: 'members/vaccinated', name: 'vaccinated', type: 'string' },
];

module.exports = {
  projects: () => [{ id: 1, name: 'Demo project' }],
  forms: () => [{ id: 'household_survey', name: 'Household survey (demo)', submissions: 1200, state: 'open' }],
  tables: () => ['Submissions', 'Submissions.members'],
  fields: () => FIELDS,
  data: (fid, table, q) => {
    const { subs, members } = build();
    if (table === 'Submissions.members') return { rows: members, fetchedAt: Date.now() };
    let rows = subs;
    if (q.from) rows = rows.filter(s => s.__system.submissionDate >= new Date(q.from).toISOString());
    if (q.to) rows = rows.filter(s => s.__system.submissionDate < new Date(new Date(q.to).getTime() + 86400000).toISOString());
    if (q.reviewState) {
      const st = q.reviewState.split(',');
      rows = rows.filter(s => st.includes(s.__system.reviewState === null ? 'null' : s.__system.reviewState));
    }
    return { rows, fetchedAt: Date.now() };
  },
};
