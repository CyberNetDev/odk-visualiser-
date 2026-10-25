// Demo data used by the "données de démonstration" login. Everything is shaped like ODK Central:
// OData rows, /fields output, an XForm (built like pyxform does, bilingual FR/EN) and a CSV attachment.

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }
const pick = (r, arr, weights) => {
  if (!weights) return arr[Math.floor(r() * arr.length)];
  const t = weights.reduce((a, b) => a + b, 0); let x = r() * t;
  for (let i = 0; i < arr.length; i++) { x -= weights[i]; if (x <= 0) return arr[i]; }
  return arr[arr.length - 1];
};

const FR = 'Français (fr)', EN = 'English (en)';

// ---------------------------------------------------------------- the form (XLSForm-like definition)
const LISTS = {
  regions: [['zinder', 'Zinder', 'Zinder'], ['maradi', 'Maradi', 'Maradi'], ['tahoua', 'Tahoua', 'Tahoua'], ['niamey', 'Niamey (communauté urbaine)', 'Niamey (urban community)']],
  sex: [['male', 'Homme', 'Male'], ['female', 'Femme', 'Female']],
  water: [['borehole', 'Forage', 'Borehole'], ['protected_well', 'Puits protégé', 'Protected well'], ['unprotected_well', 'Puits non protégé', 'Unprotected well'], ['tap', 'Robinet / borne-fontaine', 'Tap / standpipe'], ['surface_water', 'Eau de surface', 'Surface water']],
  yes_no: [['yes', 'Oui', 'Yes'], ['no', 'Non', 'No']],
  illness: [['malaria', 'Paludisme', 'Malaria'], ['diarrhoea', 'Diarrhée', 'Diarrhoea'], ['cough', 'Toux', 'Cough'], ['fever', 'Fièvre', 'Fever'], ['none', 'Aucune', 'None']],
  school: [['yes', 'Oui', 'Yes'], ['no', 'Non', 'No'], ['not_applicable', 'Non concerné(e)', 'Not applicable']],
  yes_no_dk: [['yes', 'Oui', 'Yes'], ['no', 'Non', 'No'], ['unknown', 'Ne sait pas', "Don't know"]],
  vaccine: [['bcg', 'BCG', 'BCG'], ['polio', 'Polio (VPO)', 'Polio (OPV)'], ['penta', 'Pentavalent', 'Pentavalent'], ['measles', 'Rougeole', 'Measles']],
};

const DISTRICTS = [
  ['mirriah', 'Mirriah', 'zinder'], ['magaria', 'Magaria', 'zinder'], ['matameye', 'Matamèye', 'zinder'], ['tanout', 'Tanout', 'zinder'],
  ['aguie', 'Aguié', 'maradi'], ['dakoro', 'Dakoro', 'maradi'], ['madarounfa', 'Madarounfa', 'maradi'],
  ['birni_nkonni', "Birni N'Konni", 'tahoua'], ['illela', 'Illéla', 'tahoua'], ['keita', 'Keita', 'tahoua'],
  ['niamey_1', 'Niamey I', 'niamey'], ['niamey_2', 'Niamey II', 'niamey'], ['niamey_3', 'Niamey III', 'niamey'],
];

// [path, type, fr, en, extra]   extra: { list, style: 'inline'|'itemset', multi, file }
const QUESTIONS = [
  ['start', 'dateTime', "Début de l'entretien", 'Interview start'],
  ['location', 'group', 'Localisation', 'Location'],
  ['location/region', 'select1', 'Région', 'Region', { list: 'regions', style: 'itemset' }],
  ['location/district', 'select1', 'District sanitaire', 'Health district', { file: 'districts.csv' }],
  ['location/gps', 'geopoint', 'Position GPS du ménage', 'Household GPS location'],
  ['household', 'group', 'Ménage', 'Household'],
  ['household/visit_date', 'date', 'Date de la visite', 'Visit date'],
  ['household/hh_size', 'int', 'Taille du ménage', 'Household size'],
  ['household/head_sex', 'select1', 'Sexe du chef de ménage', 'Sex of household head', { list: 'sex', style: 'inline' }],
  ['household/head_age', 'int', 'Âge du chef de ménage', 'Age of household head'],
  ['household/water_source', 'select1', "Principale source d'eau de boisson", 'Main drinking water source', { list: 'water', style: 'itemset' }],
  ['household/has_latrine', 'select1', 'Le ménage dispose-t-il de latrines ?', 'Does the household have a latrine?', { list: 'yes_no', style: 'itemset' }],
  ['household/monthly_income', 'decimal', 'Revenu mensuel (FCFA)', 'Monthly income (FCFA)'],
  ['household/illnesses', 'select', 'Maladies au cours des 2 dernières semaines', 'Illnesses in the last 2 weeks', { list: 'illness', style: 'itemset', multi: true }],
  ['members_count', 'int', 'Nombre de membres enregistrés', 'Number of members recorded'],
  ['members', 'repeat', 'Membres du ménage', 'Household members'],
  ['members/member_sex', 'select1', 'Sexe', 'Sex', { list: 'sex', style: 'inline' }],
  ['members/member_age', 'int', 'Âge (années)', 'Age (years)'],
  ['members/in_school', 'select1', 'Scolarisé(e) ?', 'Attending school?', { list: 'school', style: 'itemset' }],
  ['members/vaccinated', 'select1', 'Vacciné(e) ?', 'Vaccinated?', { list: 'yes_no_dk', style: 'itemset' }],
  ['members/vaccines', 'repeat', 'Vaccins reçus', 'Vaccines received'],
  ['members/vaccines/vaccine', 'select1', 'Vaccin', 'Vaccine', { list: 'vaccine', style: 'itemset' }],
  ['members/vaccines/vaccine_date', 'date', 'Date du vaccin', 'Vaccination date'],
];

const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildXForm() {
  const texts = { [FR]: [], [EN]: [] };
  const addText = (id, fr, en) => { texts[FR].push([id, fr]); texts[EN].push([id, en]); };
  const usedLists = new Set();
  const byPath = Object.fromEntries(QUESTIONS.map(q => [q[0], q]));
  const children = p => QUESTIONS.filter(q => q[0].split('/').slice(0, -1).join('/') === p);

  const control = q => {
    const [path, type, fr, en, x = {}] = q;
    const ref = `/data/${path}`;
    addText(`${ref}:label`, fr, en);
    const label = `<label ref="jr:itext('${ref}:label')"/>`;
    if (type === 'group') return `<group ref="${ref}">${label}${children(path).map(control).join('')}</group>`;
    if (type === 'repeat') return `<group ref="${ref}">${label}<repeat nodeset="${ref}">${children(path).map(control).join('')}</repeat></group>`;
    const tag = type === 'select' ? 'select' : type === 'select1' ? 'select1' : 'input';
    let inner = label;
    if (x.list && x.style === 'inline') {
      for (const [v, lfr, len] of LISTS[x.list]) {
        addText(`${ref}/${v}:label`, lfr, len);
        inner += `<item><label ref="jr:itext('${ref}/${v}:label')"/><value>${v}</value></item>`;
      }
    } else if (x.list) {
      usedLists.add(x.list);
      inner += `<itemset nodeset="instance('${x.list}')/root/item"><value ref="name"/><label ref="jr:itext(itextId)"/></itemset>`;
    } else if (x.file) {
      inner += `<itemset nodeset="instance('districts')/root/item[region= /data/location/region ]"><value ref="name"/><label ref="label"/></itemset>`;
    }
    return `<${tag} ref="${ref}">${inner}</${tag}>`;
  };
  const bodyXml = children('').map(control).join('\n      ');

  const instances = [...usedLists].map(list => {
    const items = LISTS[list].map(([v, lfr, len], i) => {
      addText(`static_instance-${list}-${i}`, lfr, len);
      return `<item><itextId>static_instance-${list}-${i}</itextId><name>${v}</name></item>`;
    }).join('');
    return `<instance id="${list}"><root>${items}</root></instance>`;
  }).join('\n        ');

  const dataNode = p => children(p).map(q => {
    const name = q[0].split('/').pop();
    return ['group', 'repeat'].includes(q[1]) ? `<${name}>${dataNode(q[0])}</${name}>` : `<${name}/>`;
  }).join('');
  const translation = lang => `<translation lang="${lang}"${lang === FR ? ' default="true()"' : ''}>${texts[lang].map(([id, v]) => `<text id="${xmlEsc(id)}"><value>${xmlEsc(v)}</value></text>`).join('')}</translation>`;
  const binds = QUESTIONS.filter(q => !['group', 'repeat'].includes(q[1])).map(q => `<bind nodeset="/data/${q[0]}" type="${q[1] === 'select1' || q[1] === 'select' ? 'string' : q[1]}"/>`).join('');
  void byPath;
  return `<?xml version="1.0"?>
<h:html xmlns="http://www.w3.org/2002/xforms" xmlns:h="http://www.w3.org/1999/xhtml" xmlns:jr="http://openrosa.org/javarosa" xmlns:odk="http://www.opendatakit.org/xforms">
  <h:head>
    <h:title>Enquête ménage (démo)</h:title>
    <model odk:xforms-version="1.0.0">
      <itext>${translation(FR)}${translation(EN)}</itext>
      <instance><data id="household_survey" version="2026010501">${dataNode('')}<meta><instanceID/></meta></data></instance>
        ${instances}
        <instance id="districts" src="jr://file-csv/districts.csv"/>
      ${binds}
    </model>
  </h:head>
  <h:body>
      ${bodyXml}
  </h:body>
</h:html>`;
}

const DISTRICTS_CSV = 'name,label,region\n' + DISTRICTS.map(([v, l, r]) => `${v},"${l}",${r}`).join('\n') + '\n';

// ---------------------------------------------------------------- data
let built = null;
function build() {
  if (built) return built;
  const r = rng(42);
  const subs = [], members = [], vaccines = [];
  const ENUMERATORS = ['Abdou M.', 'Fatima I.', 'Moussa S.', 'Hadiza A.', 'Ibrahim K.', 'Zeinabou H.'];
  const start = new Date('2026-01-05T08:00:00Z').getTime();
  for (let i = 0; i < 1200; i++) {
    const region = pick(r, ['zinder', 'maradi', 'tahoua', 'niamey'], [4, 3, 2, 2]);
    const district = pick(r, DISTRICTS.filter(d => d[2] === region))[0];
    const submitted = new Date(start + Math.floor(r() * 290) * 86400000 + Math.floor(r() * 36000000));
    const visit = new Date(submitted.getTime() - Math.floor(r() * 3) * 86400000);
    const hhSize = 1 + Math.floor(r() * 10);
    const urban = region === 'niamey';
    const ill = ['malaria', 'diarrhoea', 'cough', 'fever'].filter(() => r() < 0.3);
    const id = `uuid:demo-${String(i).padStart(5, '0')}`;
    const nMembers = Math.min(hhSize, 4);
    subs.push({
      __id: id,
      meta: { instanceID: id },
      start: visit.toISOString(),
      location: { region, district, gps: { type: 'Point', coordinates: [8.9 + r() * 1.2, 13.4 + r() * 1.1, 450] } },
      household: {
        visit_date: visit.toISOString().slice(0, 10),
        hh_size: hhSize,
        head_sex: pick(r, ['male', 'female'], [7, 3]),
        head_age: 18 + Math.floor(r() * 60),
        water_source: urban ? pick(r, ['tap', 'borehole', 'protected_well'], [6, 3, 1]) : pick(r, ['borehole', 'protected_well', 'unprotected_well', 'tap', 'surface_water'], [4, 3, 3, 1, 1]),
        has_latrine: r() < (urban ? 0.8 : 0.45) ? 'yes' : 'no',
        monthly_income: Math.round((urban ? 45000 : 15000) + r() * r() * 150000 + hhSize * 2500),
        illnesses: ill.length ? ill.join(' ') : 'none',
      },
      members_count: nMembers,
      'members@odata.navigationLink': `Submissions('${id}')/members`,
      __system: {
        submissionDate: submitted.toISOString(), updatedAt: null,
        submitterId: String(10 + (i % 6)), submitterName: ENUMERATORS[i % 6],
        attachmentsPresent: 0, attachmentsExpected: 0, status: null,
        reviewState: pick(r, [null, 'approved', 'hasIssues', 'rejected'], [5, 4, 1, 0.5]),
        deviceId: `collect:${1000 + (i % 6)}`, edits: 0, formVersion: '2026010501',
      },
    });
    for (let m = 0; m < nMembers; m++) {
      const age = Math.floor(r() * 70);
      const vacc = pick(r, ['yes', 'no', 'unknown'], [6, 2, 1]);
      const mid = `${id.replace('uuid:', '')}-m${m}`;
      members.push({
        __id: mid,
        '__Submissions-id': id,
        member_sex: pick(r, ['male', 'female']),
        member_age: age,
        in_school: age < 6 || age > 18 ? 'not_applicable' : pick(r, ['yes', 'no'], [urban ? 8 : 5, urban ? 2 : 4]),
        vaccinated: vacc,
      });
      if (vacc === 'yes') {
        const n = 1 + Math.floor(r() * 3);
        const shuffled = ['bcg', 'polio', 'penta', 'measles'].sort(() => r() - 0.5).slice(0, n);
        shuffled.forEach((v, k) => vaccines.push({
          __id: `${mid}-v${k}`,
          '__Submissions-members-id': mid,
          vaccine: v,
          vaccine_date: new Date(visit.getTime() - Math.floor(r() * 900) * 86400000).toISOString().slice(0, 10),
        }));
      }
    }
  }
  built = { subs, members, vaccines };
  return built;
}

// /v1/projects/:p/forms/:f/fields?odata=true  (select_one/select_multiple are "string", like Central)
const FIELDS = QUESTIONS.filter(q => q[1] !== 'group').map(([path, type, , , x = {}]) => ({
  path, name: path.split('/').pop(),
  type: type === 'select1' || type === 'select' ? 'string' : type,
  selectMultiple: !!x.multi, repeat: type === 'repeat',
}));

function inRange(s, q) {
  const d = s.__system.submissionDate;
  if (q.from && d < new Date(q.from).toISOString()) return false;
  if (q.to && d >= new Date(new Date(q.to).getTime() + 86400000).toISOString()) return false;
  if (q.reviewState && !q.reviewState.split(',').includes(s.__system.reviewState === null ? 'null' : s.__system.reviewState)) return false;
  return true;
}

module.exports = {
  projects: () => [{ id: 1, name: 'Projet de démonstration' }],
  forms: () => [{ id: 'household_survey', name: 'Enquête ménage (démo)', submissions: 1200, state: 'open' }],
  tables: () => ['Submissions', 'Submissions.members', 'Submissions.members.vaccines'],
  fields: () => FIELDS,
  formXml: () => buildXForm(),
  attachment: name => { if (name === 'districts.csv') return DISTRICTS_CSV; const e = new Error('Pièce jointe introuvable'); e.status = 404; throw e; },
  // Like Central, filters on sub-tables are applied through the root submission ($root/Submissions/...)
  data: (fid, table, q) => {
    const { subs, members, vaccines } = build();
    const okSubs = new Set(subs.filter(s => inRange(s, q)).map(s => s.__id));
    let rows;
    if (table === 'Submissions') rows = subs.filter(s => okSubs.has(s.__id));
    else if (table === 'Submissions.members') rows = members.filter(m => okSubs.has(m['__Submissions-id']));
    else if (table === 'Submissions.members.vaccines') {
      const okM = new Set(members.filter(m => okSubs.has(m['__Submissions-id'])).map(m => m.__id));
      rows = vaccines.filter(v => okM.has(v['__Submissions-members-id']));
    } else rows = [];
    return { rows, fetchedAt: Date.now() };
  },
};
