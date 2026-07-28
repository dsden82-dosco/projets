window.onerror = function(msg, url, line) {
  document.body.insertAdjacentHTML('beforeend',
    '<div class="js-error-banner">ERREUR JS ligne ' + line + ' : ' + msg + '</div>');
  return true;
};

/* ══════════════════════ CONFIGURATION ══════════════════════ */
const CONFIG = {
  webhookSession:      'https://n8n.incubateur.education.gouv.fr/webhook/e7a3319e-9447-44ed-af34-8e7672e473df',
  webhookProjEpci:     'https://n8n.incubateur.education.gouv.fr/webhook/ba68aacb-cc25-4fa3-a111-45eca61921d8',
  webhookEcoles:       'https://n8n.incubateur.education.gouv.fr/webhook/b0d39421-9814-4342-8bf9-7f73b4e201a8',
  webhookCirco:        'https://n8n.incubateur.education.gouv.fr/webhook/91ea886f-f504-4f9d-9834-2b1471101ffb',
  webhookRpi:          'https://n8n.incubateur.education.gouv.fr/webhook/a12f23f6-d1b9-48d3-993d-88dc4a62d5a9',
  // Journalisation (table Grist Sessions_logs_) : distinct du contrôle
  // d'accès synchrone webhookSession ci-dessus — cycle de vie propre (un
  // appel "start" à l'ouverture, un "end" en quittant la page), l'adresse IP
  // et les horodatages Debut/Fin étant renseignés côté n8n (pas dans cette
  // page, qui n'a pas accès à sa propre IP publique).
  webhookSessionsLog: 'https://n8n.incubateur.education.gouv.fr/webhook/e6c4aa41-a123-4f83-8811-71f7ed3ed30c',
  geojsonEpci:  './epci.geojson',
  geojsonCirco: './circonscriptions.geojson',
  // API officielle (Etalab) des contours de communes, utilisée uniquement
  // pour fusionner les polygones des communes d'un même RPI. Pas de fichier
  // local : cette couche n'est chargée qu'à la demande (mode "écoles").
  communesApi: 'https://geo.api.gouv.fr/communes',
};
const RENTREES_ALL = ['RS19','RS20','RS21','RS22','RS23','RS24','RS25','RS26','RS27','RS28','RS29','RS30'];
const RS_EXCLUDE_TIMELINE = new Set(['RS19','RS20']);

/* ══════════════════════ ÉTAT GLOBAL ══════════════════════ */
// Lecture des paramètres d'URL (echelle, vue, unite, ecoles, timeline) afin
// qu'une configuration donnée soit mémorisable en marque-page ; l'URL est
// ensuite tenue à jour (syncUrlFromState) à chaque changement d'état.
const urlParams = new URLSearchParams(window.location.search);
function paramEnum(name, allowed, fallback) {
  const v = urlParams.get(name);
  return allowed.includes(v) ? v : fallback;
}
const urlWantsSchools = urlParams.get('ecoles') === '1';
const urlTimeline = urlParams.get('timeline');
const urlWantsValues = urlParams.get('valeurs') !== '0';
const urlWantsUnite2 = urlParams.get('unite2') === '1';
const state = {
  sessId: urlParams.get('SessID'),
  echelle: paramEnum('echelle', ['epci', 'circo'], 'epci'),       // 'epci' | 'circo'
  vue: paramEnum('vue', ['carte', 'courbes', 'tableau'], 'carte'), // 'carte' | 'courbes' | 'tableau'
  type: paramEnum('unite', ['effectifs', 'variation', 'pourcentage'], 'variation'), // 'effectifs' | 'variation' | 'pourcentage'
  rentreeIdx: null,       // index dans RENTREES (scale courante)
  sessionActive: null,   // null tant que non vérifié, puis true/false
  sessionMessage: '',
  showValues: urlWantsValues,       // étiquettes carte : nom + valeur (sinon nom seul)
  showSecondUnit: urlWantsUnite2,   // étiquettes carte : 3e ligne (unité complémentaire)
};
// Reconstruit les paramètres d'URL de zéro (plutôt que de réutiliser
// `new URLSearchParams(window.location.search)`, qui conserve l'ordre
// existant des clés) afin que les variables d'état apparaissent toujours en
// premier, SessID en dernier.
function syncUrlFromState() {
  const params = new URLSearchParams();
  params.set('echelle', state.echelle);
  params.set('vue', state.vue);
  params.set('unite', state.type);
  params.set('ecoles', schoolsModeActive ? '1' : '0');
  const cache = scaleCache[state.echelle];
  const rentree = cache?.model?.RENTREES_DISPO?.[state.rentreeIdx];
  if (rentree) params.set('timeline', rentree);
  params.set('valeurs', state.showValues ? '1' : '0');
  params.set('unite2', state.showSecondUnit ? '1' : '0');
  if (state.sessId) params.set('SessID', state.sessId);
  history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${window.location.hash}`);
}

/* Cache par échelle : { geojson, records, model } */
const scaleCache = { epci: {}, circo: {} };

async function postJson(url, sessId) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ SessID: sessId }),
  });
  if (!res.ok) throw new Error(`Erreur serveur (HTTP ${res.status}).`);
  return await res.json();
}
// Journalisation Sessions_logs_ (Grist) : un appel "start" à l'ouverture et
// un "end" en quittant (fetch keepalive:true dans les deux cas — fiable
// pendant le déchargement de la page, contrairement à un fetch normal qui
// peut être annulé à ce moment-là). navigator.sendBeacon() serait une
// alternative pour "end", mais envoie toujours la requête avec les
// identifiants (cookies) sans possibilité de désactiver ça : sans l'en-tête
// Access-Control-Allow-Credentials (non nécessaire ici, on n'utilise pas de
// cookie), le navigateur bloque la réponse en CORS. fetch keepalive n'envoie
// pas d'identifiants vers une origine différente par défaut, évitant le
// problème. n8n distingue les deux appels via "action" et upsert la ligne
// Grist par SessID (Debut/Fin/Adresse_IP renseignés côté n8n).
function logSessionEvent(action) {
  if (!state.sessId) return;
  const payload = JSON.stringify({ SessID: state.sessId, action });
  fetch(CONFIG.webhookSessionsLog, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true })
    .catch(err => console.error('[dataviz] Erreur journalisation session :', err));
}
async function fetchGeojson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Erreur chargement géométrie (HTTP ${res.status}).`);
  return await res.json();
}

/* ══════════════════════ TRAITEMENT DES DONNÉES ══════════════════════ */
const NEG_PALETTE = ['#ffffb2','#fdd49e','#fdbb84','#fc8d59','#ef6548','#d7301f','#b30000','#7f0000','#67000d'];
const POS_PALETTE = ['#c7e9c0','#74c476','#238b45'];
const COLORS_ABSOLU_DEF = ['#f7fbff','#deebf7','#c6dbef','#9ecae1','#6baed6','#4292c6','#2171b5','#08519c'];
// Palette dédiée à la heatmap du Tableau (unité Effectifs), reprise telle
// quelle du widget d'origine (courbes_et_heatmap.html) : jaune -> rouge foncé,
// distincte de la palette bleue utilisée pour les cartes choroplèthes.
const COLORS_ABSOLU_HEAT_DEF = ['#fff7ec','#fee8c8','#fdd49e','#fdbb84','#fc8d59','#ef6548','#d7301f','#990000'];

function buildRelatifColors(breaks) {
  const n = breaks.length - 1;
  let nNeg = 0;
  for (let i = 0; i < n; i++) if (breaks[i+1] <= 0) nNeg++;
  const colors = []; let ni = 0, pi = 0;
  for (let i = 0; i < n; i++) {
    if (breaks[i+1] <= 0) {
      const idx = nNeg > 1 ? Math.round((nNeg-1-ni) * (NEG_PALETTE.length-1) / (nNeg-1)) : NEG_PALETTE.length-1;
      colors.push(NEG_PALETTE[idx]); ni++;
    } else { colors.push(POS_PALETTE[Math.min(pi, POS_PALETTE.length-1)]); pi++; }
  }
  return colors;
}

// Algorithme de Jenks (ruptures naturelles / Fisher-Jenks) : classification
// en k classes minimisant la variance intra-classe. Retourne k+1 bornes.
function jenksBreaks(values, nClasses) {
  const data = [...values].sort((a, b) => a - b);
  const n = data.length;
  const k = Math.max(1, Math.min(nClasses, n));
  if (k === 1) return [data[0], data[n - 1]];
  const mat1 = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0));
  const mat2 = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0));
  for (let i = 1; i <= k; i++) {
    mat1[1][i] = 1;
    mat2[1][i] = 0;
    for (let j = 2; j <= n; j++) mat2[j][i] = Infinity;
  }
  let v = 0;
  for (let l = 2; l <= n; l++) {
    let s1 = 0, s2 = 0, w = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = data[i3 - 1];
      s2 += val * val; s1 += val; w++;
      v = s2 - (s1 * s1) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= k; j++) {
          if (mat2[l][j] >= v + mat2[i4][j - 1]) {
            mat1[l][j] = i3;
            mat2[l][j] = v + mat2[i4][j - 1];
          }
        }
      }
    }
    mat1[l][1] = 1;
    mat2[l][1] = v;
  }
  const breaks = new Array(k + 1);
  breaks[k] = data[n - 1];
  breaks[0] = data[0];
  let kk = n;
  for (let j = k; j >= 2; j--) {
    const id = mat1[kk][j] - 2;
    breaks[j - 1] = data[id];
    kk = mat1[kk][j] - 1;
  }
  return breaks;
}
// Classification en ruptures naturelles (Jenks), coloration selon la même
// logique divergente que l'unité Variation (buildRelatifColors : rouge pour
// les classes négatives, vert pour les positives).
function buildJenksColors(values, nClasses) {
  const finite = values.filter(v => v != null && Number.isFinite(v));
  if (finite.length === 0) return { breaks: [], colors: [] };
  const uniq = [...new Set(finite)];
  const k = Math.min(nClasses, uniq.length);
  const breaks = jenksBreaks(finite, k);
  return { breaks, colors: buildRelatifColors(breaks) };
}

// Détection souple des colonnes selon l'échelle (les webhooks n8n peuvent
// renvoyer des libellés de colonnes légèrement différents d'une table à l'autre).
function detectColumns(sample, echelle) {
  const keys = Object.keys(sample);
  const find = re => keys.find(k => re.test(k));
  let colCode, colNom;
  if (echelle === 'epci') {
    colCode = find(/code/i);
    colNom  = keys.find(k => k !== colCode && /(epci|nom|libell)/i.test(k));
  } else {
    colCode = find(/uai.*circo|circo.*uai/i) || find(/circo/i);
    colNom  = keys.find(k => k !== colCode && /(nom|libell|circo)/i.test(k)) || colCode;
  }
  const colRentree = find(/rent/i);
  let colEleves = find(/eleve|effectif|total/i);
  const colEtat = find(/etat|tat/i);
  if (!colEleves) {
    // Repli : la première colonne numérique restante (hors code/rentrée/état/nom).
    const excluded = new Set([colCode, colRentree, colEtat, colNom]);
    colEleves = keys.find(k => !excluded.has(k) && typeof sample[k] === 'number');
  }
  console.debug(`[dataviz] colonnes détectées (${echelle}) :`, { colCode, colNom, colRentree, colEleves, colEtat });
  return { colCode, colNom, colRentree, colEleves, colEtat };
}

function buildModel(records, echelle) {
  const model = {
    EFFECTIFS: {}, NOM_BY_CODE: {}, VARIATIONS: {}, VARIATIONS_PCT: {},
    CUMUL: {}, CUMUL_PCT: {}, RENTREES_DISPO: [], PREVISION_RS: [],
    BREAKS: {}, COLORS: {}, N: {},
  };
  if (!records || records.length === 0) return model;
  const { colCode, colNom, colRentree, colEleves, colEtat } = detectColumns(records[0], echelle);

  for (const row of records) {
    const code = String(row[colCode]);
    const r = row[colRentree];
    const eff = Number(row[colEleves]);
    if (!Number.isFinite(eff)) continue;
    if (!model.EFFECTIFS[code]) model.EFFECTIFS[code] = {};
    model.EFFECTIFS[code][r] = eff;
    if (colNom && row[colNom] && !model.NOM_BY_CODE[code]) model.NOM_BY_CODE[code] = String(row[colNom]);
  }
  for (const code of Object.keys(model.EFFECTIFS))
    if (!model.NOM_BY_CODE[code]) model.NOM_BY_CODE[code] = code;

  const rsSet = new Set();
  for (const row of records) rsSet.add(row[colRentree]);
  const rentreesAll = RENTREES_ALL.filter(r => rsSet.has(r));

  for (const [code, years] of Object.entries(model.EFFECTIFS)) {
    model.VARIATIONS[code] = {}; model.VARIATIONS_PCT[code] = {};
    for (let i = 1; i < rentreesAll.length; i++) {
      const r = rentreesAll[i], prev = rentreesAll[i-1];
      if (years[r] != null && years[prev] != null) {
        model.VARIATIONS[code][r] = years[r] - years[prev];
        if (years[prev] !== 0) model.VARIATIONS_PCT[code][r] = (years[r] - years[prev]) / years[prev] * 100;
      }
    }
  }

  let cumulRange;
  if (colEtat) {
    const prevRows = records.filter(r => (r[colEtat]||'').toLowerCase().includes('vision'));
    const prevRS = [...new Set(prevRows.map(r => r[colRentree]))].sort();
    cumulRange = prevRS.slice(0, 5);
  } else { cumulRange = rentreesAll.slice(-5); }
  model.PREVISION_RS = cumulRange;

  if (cumulRange.length >= 2) {
    const lastRS = cumulRange[cumulRange.length-1];
    const idxFirst = rentreesAll.indexOf(cumulRange[0]);
    const prevFirstRS = idxFirst > 0 ? rentreesAll[idxFirst-1] : null;
    for (const code of Object.keys(model.EFFECTIFS)) {
      const vLast = model.EFFECTIFS[code]?.[lastRS];
      const vPrev = prevFirstRS != null ? model.EFFECTIFS[code]?.[prevFirstRS] : null;
      if (vLast != null && vPrev != null) {
        model.CUMUL[code] = vLast - vPrev;
        if (vPrev !== 0) model.CUMUL_PCT[code] = (vLast - vPrev) / vPrev * 100;
      }
    }
  }

  model.RENTREES_DISPO = rentreesAll.filter(r => !RS_EXCLUDE_TIMELINE.has(r)).concat(['CUMUL']);

  // Classes "variation" (annuelle)
  {
    let minA = 0;
    for (const c of Object.keys(model.VARIATIONS))
      for (const [r,v] of Object.entries(model.VARIATIONS[c]))
        if (!RS_EXCLUDE_TIMELINE.has(r) && v < minA) minA = v;
    const s = 25, n = 9;
    const lo = Math.floor(minA / s) * s;
    let breaks = Array.from({length:n+1}, (_,i)=> lo + i*s);
    if (breaks[breaks.length-1] <= 0) breaks.push(25);
    model.BREAKS.variation = breaks;
    model.COLORS.variation = buildRelatifColors(breaks);
    model.N.variation = breaks.length - 1;
  }
  // Classes "cumul" (variation cumulée RS26-RS30) : ruptures naturelles
  // (Jenks, 5 classes max), sur le même modèle que "cumul pourcentage",
  // plus adaptées que le pas fixe sur ce point.
  {
    const vals = Object.values(model.CUMUL);
    const { breaks, colors } = buildJenksColors(vals, 5);
    model.BREAKS.cumul = breaks;
    model.COLORS.cumul = colors;
    model.N.cumul = breaks.length - 1;
  }
  // Classes "effectifs" (absolu)
  {
    const allVals = [];
    for (const code of Object.keys(model.EFFECTIFS))
      for (const r of rentreesAll) if (model.EFFECTIFS[code][r] != null) allVals.push(model.EFFECTIFS[code][r]);
    allVals.sort((a,b)=>a-b);
    if (allVals.length > 0) {
      const n = 8;
      const step = Math.max(1, Math.floor(allVals.length / n));
      let breaks = [];
      for (let i=0;i<n;i++) breaks.push(Math.round(allVals[i*step]/50)*50);
      breaks.push(Math.round((allVals[allVals.length-1]+50)/50)*50);
      model.BREAKS.effectifs = breaks;
      model.COLORS.effectifs = COLORS_ABSOLU_DEF.slice();
      model.N.effectifs = n;
      model.BREAKS.effectifsHeat = breaks;
      model.COLORS.effectifsHeat = COLORS_ABSOLU_HEAT_DEF.slice();
      model.N.effectifsHeat = n;
    } else {
      model.BREAKS.effectifs = []; model.COLORS.effectifs = []; model.N.effectifs = 0;
      model.BREAKS.effectifsHeat = []; model.COLORS.effectifsHeat = []; model.N.effectifsHeat = 0;
    }
  }
  // Classes "pourcentage"
  {
    let mn=0, mx=0;
    for (const c of Object.keys(model.VARIATIONS_PCT))
      for (const [r,v] of Object.entries(model.VARIATIONS_PCT[c]))
        if (!RS_EXCLUDE_TIMELINE.has(r)) { if (v<mn) mn=v; if (v>mx) mx=v; }
    const span = (Math.max(mx,0)-Math.min(mn,0)) || 1;
    const niceStep = x => { const p=Math.pow(10,Math.floor(Math.log10(x))); const f=x/p;
      const nn = f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10; return nn*p; };
    const st = niceStep(span/9);
    const lo = Math.floor(Math.min(mn,0)/st)*st, hi = Math.ceil(Math.max(mx,0)/st)*st;
    let breaks = [];
    for (let v=lo; v<=hi+st*1e-6; v+=st) breaks.push(Math.round(v*100)/100);
    if (breaks.length<2) breaks=[Math.min(0,lo), Math.max(0,hi)||1];
    model.BREAKS.pourcentage = breaks;
    model.COLORS.pourcentage = buildRelatifColors(breaks);
    model.N.pourcentage = breaks.length-1;
  }
  // Classes "cumul pourcentage" (variation cumulée RS26-RS30, en %) : ruptures
  // naturelles (Jenks) à 8 classes, plus adaptées que le pas fixe sur ce point.
  {
    const vals = Object.values(model.CUMUL_PCT);
    const { breaks, colors } = buildJenksColors(vals, 8);
    model.BREAKS.cumulPourcentage = breaks;
    model.COLORS.cumulPourcentage = colors;
    model.N.cumulPourcentage = breaks.length - 1;
  }

  return model;
}

/* ══════════════════════ CHARGEMENT (session + données par échelle) ══════════════════════ */
async function ensureScaleData(echelle) {
  const cache = scaleCache[echelle];
  if (cache.model) return cache;

  const [geojson, records] = await Promise.all([
    fetchGeojson(echelle === 'epci' ? CONFIG.geojsonEpci : CONFIG.geojsonCirco),
    postJson(echelle === 'epci' ? CONFIG.webhookProjEpci : CONFIG.webhookCirco, state.sessId),
  ]);
  cache.geojson = geojson;
  cache.records = records;
  cache.model = buildModel(records, echelle);
  cache.codeProp = echelle === 'epci' ? 'code' : 'UAI_circo';
  return cache;
}

/* ══════════════════════ CARTE (Leaflet) ══════════════════════ */
const map = L.map('map', { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.25 });
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd', maxZoom: 19, detectRetina: true,
}).addTo(map);
let geojsonLayer = null, labelMarkers = [];
let lastFitBounds = null;
// Le calage en grille des écoles superposées est calculé en pixels écran :
// il doit être recalculé à chaque changement de niveau de zoom (molette,
// boutons +/-, double-clic…), pas seulement lors d'un zoom sur polygone.
map.on('zoomend', () => { if (schoolsModeActive) showSchoolsForFeature(); });

function ringCentroid(ring) {
  let lat=0,lng=0,area=0,n=ring.length;
  for (let i=0;i<n-1;i++){const [x0,y0]=ring[i],[x1,y1]=ring[i+1];const a=x0*y1-x1*y0;area+=a;lng+=(x0+x1)*a;lat+=(y0+y1)*a;}
  area/=2;
  if (Math.abs(area)<1e-12){const lats=ring.map(c=>c[1]),lngs=ring.map(c=>c[0]);
    return [(Math.min(...lats)+Math.max(...lats))/2,(Math.min(...lngs)+Math.max(...lngs))/2];}
  return [lat/(6*area), lng/(6*area)];
}
function featureCenter(feature) {
  const geom = feature.geometry;
  const rings = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.map(p=>p[0]);
  const mainRing = rings.reduce((b,r)=>r.length>b.length?r:b, []);
  return ringCentroid(mainRing);
}
function wrapName(name) {
  const short = String(name)
    .replace(/^Communauté de Communes\s*/i,'CC ').replace(/^Communauté d'Agglomération\s*/i,'CA ')
    .replace(/^Communauté Urbaine\s*/i,'CU ').replace(/^Métropole\s*/i,'Met. ').trim();
  const words = short.split(' '); const lines=[]; let cur='';
  for (const w of words){ if(!cur) cur=w; else if((cur+' '+w).length<=18) cur+=' '+w; else {lines.push(cur); cur=w;} }
  if (cur) lines.push(cur);
  // escXml par ligne (pas sur le résultat joint) : le nom vient de Grist et
  // sert de source à une étiquette carte insérée via innerHTML — seuls les
  // <br> ajoutés ici doivent rester des balises, le texte doit être échappé.
  return lines.map(escXml).join('<br>');
}

function currentRentree() {
  const cache = scaleCache[state.echelle];
  if (!cache.model || state.rentreeIdx == null) return null;
  return cache.model.RENTREES_DISPO[state.rentreeIdx];
}
function isCumulMode() { return currentRentree() === 'CUMUL' && state.type === 'variation'; }
// Clé de classification active : le point Cumul RS26-RS30 utilise ses propres
// ruptures naturelles (Jenks), calculées sur les valeurs cumulées et non sur
// celles de la variation annuelle — en Pourcentage comme en Variation.
function activeBreakKey() {
  if (currentRentree() === 'CUMUL' && state.type === 'pourcentage') return 'cumulPourcentage';
  if (isCumulMode()) return 'cumul';
  return state.type;
}

function getValAt(code, r) {
  const cache = scaleCache[state.echelle];
  if (state.type === 'effectifs') return (cache.model.EFFECTIFS[code]||{})[r] ?? null;
  if (r === 'CUMUL') return state.type === 'pourcentage' ? (cache.model.CUMUL_PCT[code] ?? null) : (cache.model.CUMUL[code] ?? null);
  if (state.type === 'pourcentage') return (cache.model.VARIATIONS_PCT[code]||{})[r] ?? null;
  return (cache.model.VARIATIONS[code]||{})[r] ?? null;
}
function getVal(code) { return getValAt(code, currentRentree()); }
// Valeur de l'unité complémentaire (Variation <-> Pourcentage), pour la même
// échelle/rentrée que la valeur principale — utilisée par le bouton carte
// "+ Autre unité" (n'a pas de sens en unité Effectifs).
function getSecondaryVal(code) {
  const cache = scaleCache[state.echelle];
  const r = currentRentree();
  if (state.type === 'variation') {
    if (r === 'CUMUL') return cache.model.CUMUL_PCT[code] ?? null;
    return (cache.model.VARIATIONS_PCT[code]||{})[r] ?? null;
  }
  if (state.type === 'pourcentage') {
    if (r === 'CUMUL') return cache.model.CUMUL[code] ?? null;
    return (cache.model.VARIATIONS[code]||{})[r] ?? null;
  }
  return null;
}
function formatSecondaryVal(v) {
  if (v == null) return '';
  const sign = v>0 ? '+' : '';
  if (state.type === 'variation') return sign + v.toLocaleString('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1}) + ' %';
  return sign + Math.round(v).toLocaleString('fr-FR') + ' él.';
}
// breakKey optionnel : par défaut la classification du point actuellement
// sélectionné (carte) ; le tableau (colonnes annuelles) impose state.type
// explicitement pour ne jamais utiliser les ruptures du point Cumul.
function getColor(val, breakKey) {
  if (val == null) return '#dddddd';
  const cache = scaleCache[state.echelle];
  const key = breakKey || activeBreakKey();
  const breaks = cache.model.BREAKS[key], colors = cache.model.COLORS[key], n = cache.model.N[key];
  if (!breaks || !breaks.length) return '#dddddd';
  for (let i=0;i<n;i++) if (val < breaks[i+1]) return colors[i];
  return colors[n-1];
}
function formatVal(v) {
  if (v == null) return '';
  if (state.type === 'effectifs') return Math.round(v).toLocaleString('fr-FR') + ' él.';
  const sign = v>0 ? '+' : '';
  if (state.type === 'pourcentage') return sign + v.toLocaleString('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1}) + ' %';
  return sign + Math.round(v).toLocaleString('fr-FR') + ' él.';
}
// Vue Tableau : les cellules n'affichent plus l'unité ("él.") en Effectifs
// (grille trop dense sinon), Variation et Pourcentage gardent la leur.
function formatCellVal(v) {
  if (v == null) return '';
  if (state.type === 'effectifs') return Math.round(v).toLocaleString('fr-FR');
  return formatVal(v);
}
// Vue Tableau : les totaux n'affichent jamais d'unité, sauf en Pourcentage.
function formatTotalVal(v) {
  if (v == null) return '';
  if (state.type === 'pourcentage') return formatVal(v);
  const sign = state.type === 'effectifs' ? '' : (v > 0 ? '+' : '');
  return sign + Math.round(v).toLocaleString('fr-FR');
}

function styleFeature(feature) {
  const cache = scaleCache[state.echelle];
  const code = String(feature.properties[cache.codeProp]);
  return { fillColor: getColor(getVal(code)), fillOpacity: 1, color: '#333', weight: 1.2, opacity: 0.85 };
}
/* Mode "Afficher les écoles" : les polygones ne sont cliquables / survolables
   que lorsque ce mode est actif (bouton dédié sous la section Échelle). */
let schoolsModeActive = false;
// Emprise (tight, avant le padding de fitBounds) du polygone actuellement
// zoomé en mode écoles (clic sur une circo/EPCI), null en vue d'ensemble —
// réutilisée par l'export carte pour un cadrage aussi serré que la carte
// choroplèthe (cf. buildMapExportSVG), plutôt que le viewport courant de la
// carte en direct (map.getBounds()), plus lâche (zoom arrondi, marge de
// fitBounds, pan manuel...).
let schoolsZoomedBounds = null;
function simplifiedPolygonStyle() { return { weight: 4, color: '#111', fillOpacity: 0 }; }
function onEachFeature(feature, layer) {
  layer.on({
    mouseover(e){
      if (!schoolsModeActive) return;
      e.target.setStyle({ weight:5, color:'#ff6600', fillOpacity:0 });
      e.target.bringToFront();
      // Les points-écoles doivent rester cliquables : ne jamais laisser un
      // polygone survolé passer devant la couche des écoles. L.LayerGroup
      // n'a pas de bringToFront() propre : on le fait marqueur par marqueur.
      if (schoolLayerGroup) schoolLayerGroup.eachLayer(m => m.bringToFront());
    },
    mouseout(e){ if (!schoolsModeActive) return; e.target.setStyle(simplifiedPolygonStyle()); },
    click(){ onFeatureClick(feature, layer); },
  });
}
function onFeatureClick(feature, layer) {
  if (!schoolsModeActive) return;
  schoolsZoomedBounds = layer.getBounds();
  map.fitBounds(schoolsZoomedBounds, { padding: [20,20], animate: false });
  // Le calage en grille des points-écoles est fait en pixels écran : sans
  // recalcul après le zoom, l'espacement (fixé à l'ancien niveau de zoom)
  // paraît trop large une fois zoomé sur le polygone.
  showSchoolsForFeature();
  showFeatureInfo(feature);
}
function updateLegendOffset() {
  const panel = document.getElementById('map-info-panel');
  const shown = panel.classList.contains('show');
  const collapsed = panel.classList.contains('collapsed');
  document.getElementById('map-legend').classList.toggle('legend-shifted', shown && !collapsed);
  const toggleBtn = document.getElementById('info-panel-toggle');
  toggleBtn.classList.toggle('show', shown);
  toggleBtn.classList.toggle('panel-collapsed', collapsed);
}
function closeInfoPanel() {
  document.getElementById('map-info-panel').classList.remove('show', 'collapsed');
  document.getElementById('info-school-block').hidden = true;
  clearFeatureSchoolsList();
  closeSchoolChartModal();
  updateLegendOffset();
}
function enterSchoolsMode() {
  schoolsModeActive = true;
  schoolsZoomedBounds = null;
  clearLabels();
  if (geojsonLayer) geojsonLayer.eachLayer(l => l.setStyle(simplifiedPolygonStyle()));
  if (lastFitBounds) map.fitBounds(lastFitBounds, { padding: [10,10] });
  closeInfoPanel();
  showSchoolsForFeature();
  showRpiLayer();
  buildTimeline();
  refreshSegButtons();
  updateTitle();
  syncUrlFromState();
}
function exitSchoolsMode() {
  schoolsModeActive = false;
  schoolsZoomedBounds = null;
  clearSchoolLayer();
  clearRpiLayer();
  if (geojsonLayer) { geojsonLayer.eachLayer(l => geojsonLayer.resetStyle(l)); addLabels(); }
  closeInfoPanel();
  updateLegend();
  buildTimeline();
  refreshSegButtons();
  updateTitle();
  syncUrlFromState();
}
function showFeatureInfo(feature) {
  const cache = scaleCache[state.echelle];
  const code = String(feature.properties[cache.codeProp]);
  const nom = cache.model.NOM_BY_CODE[code] || feature.properties.circo || feature.properties.nom || code;
  const label = state.echelle === 'circo' ? `Circonscription : ${nom}` : nom;
  document.getElementById('info-feature-name').textContent = label;
  const valueEl = document.getElementById('info-feature-value');
  valueEl.hidden = false;
  if (schoolsModeActive) {
    // En mode "écoles", la carte et les points sont toujours sur le cumul
    // RS26-RS30, indépendamment du point sélectionné sur la timeline (gelée) :
    // on affiche donc explicitement cette valeur, pas getVal(code).
    const v = (state.type === 'pourcentage' ? cache.model.CUMUL_PCT[code] : cache.model.CUMUL[code]) ?? null;
    valueEl.textContent = 'Cumul RS26-RS30 : ' + formatVal(v);
  } else {
    valueEl.textContent = formatVal(getVal(code));
  }
  document.getElementById('info-school-block').hidden = true;
  document.getElementById('map-info-panel').classList.add('show');
  updateLegendOffset();
  if (schoolsModeActive) showFeatureSchoolsList(feature);
  else clearFeatureSchoolsList();
}
function clearFeatureSchoolsList() {
  const el = document.getElementById('info-schoolslist-block');
  el.hidden = true; el.innerHTML = '';
}
// Liste des écoles situées dans le polygone cliqué (mode "écoles"),
// regroupées par commune (ordre alphabétique croissant), avec la variation
// ou le pourcentage cumulé RS26-RS30 selon l'unité actuellement affichée.
async function showFeatureSchoolsList(feature) {
  const el = document.getElementById('info-schoolslist-block');
  el.hidden = false;
  el.innerHTML = '<p class="fsl-empty">Chargement…</p>';
  let model;
  try { model = await ensureSchoolData(); }
  catch (err) { console.error('[dataviz] Erreur chargement des écoles :', err); el.innerHTML = ''; el.hidden = true; return; }
  const cache = scaleCache[state.echelle];
  const code = String(feature.properties[cache.codeProp]);
  const inside = model.points.filter(p => schoolAreaCode(p, state.echelle) === code);
  if (!inside.length) { el.innerHTML = '<p class="fsl-empty">Aucune école dans cette zone.</p>'; return; }
  const byCommune = {};
  for (const s of inside) {
    const commune = s.commune || '·';
    (byCommune[commune] ||= []).push(s);
  }
  const communes = Object.keys(byCommune).sort((a, b) => a.localeCompare(b, 'fr'));
  const isPct = state.type === 'pourcentage';
  let html = '';
  for (const commune of communes) {
    const schools = byCommune[commune].slice().sort((a, b) => schoolDisplayName(a, false).localeCompare(schoolDisplayName(b, false), 'fr'));
    html += `<div class="fsl-commune">${escXml(commune)}</div>`;
    for (const s of schools) {
      const val = isPct ? s.cumulPct : s.cumul;
      const fmt = isPct ? fmtSchoolPct(val) : (val == null ? '·' : formatSchoolVal(val));
      // Le nom de la commune est déjà l'en-tête de groupe ci-dessus : pas
      // besoin de le répéter après chaque école.
      html += `<div class="fsl-row"><span class="fsl-name">${escXml(schoolDisplayName(s, false))}</span><span class="fsl-value">${fmt}</span></div>`;
    }
  }
  html += `<p class="fsl-disclaimer">Du fait des arrondis, la somme des variations peut ne pas correspondre à la variation totale. C'est cette dernière qu'il faut retenir.</p>`;
  el.innerHTML = html;
}
/* ── Rattachement école ↔ EPCI/circo (pour le titre du volet) ── */
function pointInRing(pt, ring) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointInPolygonGeom(pt, geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  return polys.some(rings => {
    if (!pointInRing(pt, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) if (pointInRing(pt, rings[k])) return false;
    return true;
  });
}
function findContainingFeature(lng, lat, cache = scaleCache[state.echelle]) {
  if (!cache.geojson) return null;
  return cache.geojson.features.find(f => pointInPolygonGeom([lng, lat], f.geometry)) || null;
}
// Code EPCI/circonscription d'une école pour une échelle donnée : priorité
// aux colonnes Circo_UAI/EPCI_code de Projections_Scenarios (jointes côté
// Grist aux tables Corresp_EPCI/Corresp_Circos, donc fiables même près d'une
// frontière) ; repli sur le test géométrique point-dans-polygone seulement
// si la colonne est absente pour cette école.
function schoolAreaCode(school, echelle) {
  const direct = echelle === 'epci' ? school.epciCode : school.circoUai;
  if (direct) return direct;
  const cache = scaleCache[echelle];
  const feature = findContainingFeature(school.lng, school.lat, cache);
  return feature ? String(feature.properties[cache.codeProp]) : null;
}
function showSchoolInfo(school) {
  clearFeatureSchoolsList();
  const cache = scaleCache[state.echelle];
  const code = schoolAreaCode(school, state.echelle);
  if (code) {
    const nom = cache.model.NOM_BY_CODE[code] || (state.echelle === 'circo' ? school.circoNom : '') || code;
    const label = state.echelle === 'circo' ? `Circonscription : ${nom}` : nom;
    document.getElementById('info-feature-name').textContent = label;
  }
  document.getElementById('info-feature-value').hidden = true;
  document.getElementById('info-school-title').textContent = schoolDisplayName(school);
  document.getElementById('info-school-uai').textContent = school.uai;
  document.getElementById('info-school-block').hidden = false;
  document.getElementById('map-info-panel').classList.add('show');
  updateLegendOffset();
  renderSchoolCompareChart(school, code);
  showSchoolRpiInfo(school, ++infoSchoolToken);
}
// Chargement asynchrone (webhook RPI) après affichage du reste du volet ;
// token = protection contre un second clic pendant le chargement.
let infoSchoolToken = 0;
async function showSchoolRpiInfo(school, token) {
  const rpiEl = document.getElementById('info-school-rpi');
  rpiEl.hidden = true; rpiEl.textContent = '';
  let rpi;
  try { rpi = await ensureRpiData(); }
  catch (err) { console.error('[dataviz] Erreur chargement des RPI :', err); return; }
  if (token !== infoSchoolToken) return;
  const group = findRpiForSchool(school, rpi);
  if (!group) return;
  rpiEl.textContent = `RPI ${group.communeNames.join(' / ')} (${group.uaiRpi})`;
  rpiEl.hidden = false;
}

/* ── Comparaison en base 100 (école vs EPCI/circo), volet école ──
   Même logique que le widget de référence (indice base 100, zone
   Prévisions, part école/EPCI en fond), adaptée aux données déjà chargées
   par l'app (pas de scénarios séparés : une seule série d'effectifs par
   année, constats et prévisions confondus). Comparaison avec l'EPCI ou la
   circonscription selon l'échelle active. Un même viewBox SVG fixe est
   réutilisé pour la version compacte du volet et l'agrandissement en popup :
   seule la taille CSS du <svg> change, le texte grossit avec elle. */
let schoolCompareData = null, schoolCompareTitle = '';
function computeSchoolCompareData(school, code) {
  if (!code) return null;
  const cache = scaleCache[state.echelle];
  const areaName = cache.model.NOM_BY_CODE[code] || code;
  const areaLabel = state.echelle === 'epci' ? 'EPCI' : 'Circonscription';
  const years = RENTREES_ALL.filter(r => !RS_EXCLUDE_TIMELINE.has(r));
  const schoolVals = years.map(r => school.years[r] ?? null);
  const areaVals = years.map(r => cache.model.EFFECTIFS[code]?.[r] ?? null);
  const baseIdx = years.findIndex((r, i) => schoolVals[i] != null && areaVals[i] != null);
  if (baseIdx === -1) {
    const areaMention = state.echelle === 'epci' ? 'son EPCI' : 'sa circonscription';
    return { years, error: `Aucune année de référence commune entre l’école et ${areaMention}.` };
  }
  const schoolBase = schoolVals[baseIdx], areaBase = areaVals[baseIdx];
  const school100 = schoolVals.map(v => (v == null || !schoolBase) ? null : Math.round(v / schoolBase * 1000) / 10);
  const area100 = areaVals.map(v => (v == null || !areaBase) ? null : Math.round(v / areaBase * 1000) / 10);
  const pct = years.map((r, i) => (schoolVals[i] == null || !areaVals[i]) ? null : Math.round(schoolVals[i] / areaVals[i] * 1000) / 10);
  const fp = firstPrevIdx(years);
  const pivotIdx = fp >= 1 ? fp - 1 : (fp === 0 ? 0 : years.length - 1);

  // Deux scénarios de projection pour l'école elle-même (webhook
  // Projections_Scenarios), raccordés au dernier constat puis indexés sur la
  // même base que la courbe "École" : leur écart forme le "Delta des
  // projections". Vides sur les anciens formats de données (dégradation
  // silencieuse : pas de lignes tracées).
  const cibleEpciArr = years.map((r, i) => i === pivotIdx ? schoolVals[pivotIdx] : (i > pivotIdx ? (school.cibleEpci?.[r] ?? null) : null));
  const tendanceEcoleArr = years.map((r, i) => i === pivotIdx ? schoolVals[pivotIdx] : (i > pivotIdx ? (school.tendanceEcole?.[r] ?? null) : null));
  const cibleEpci100 = cibleEpciArr.map(v => (v == null || !schoolBase) ? null : Math.round(v / schoolBase * 1000) / 10);
  const tendanceEcole100 = tendanceEcoleArr.map(v => (v == null || !schoolBase) ? null : Math.round(v / schoolBase * 1000) / 10);

  return { years, schoolVals, areaVals, school100, area100, pct, baseIdx, areaName, areaLabel, fp, pivotIdx, cibleEpciArr, tendanceEcoleArr, cibleEpci100, tendanceEcole100 };
}
function drawSchoolCompareChart(svgEl, data) {
  svgEl.innerHTML = '';
  if (!data || data.error) return;
  const { years, school100, area100, pct, fp, schoolVals, areaVals, cibleEpci100, tendanceEcole100, areaLabel } = data;
  const W = 420, H = 190;
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const mL = 28, mR = 26, mT = 20, mB = 16;
  const plotW = W - mL - mR, plotH = H - mT - mB;
  const n = years.length;
  const x = i => mL + (n === 1 ? plotW / 2 : i * plotW / (n - 1));

  let lo = 100, hi = 100;
  for (const arr of [school100, area100, cibleEpci100, tendanceEcole100]) for (const v of arr) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const pad = Math.max(2, (hi - lo) * 0.12);
  lo = Math.floor(lo - pad); hi = Math.ceil(hi + pad);
  if (lo === hi) { lo -= 5; hi += 5; }
  const y = v => mT + plotH - (v - lo) / (hi - lo) * plotH;

  // Barres "part école" en fond, échelle indépendante (axe secondaire à droite)
  const finitePct = pct.filter(v => v != null);
  const maxPct = finitePct.length ? Math.max(1, ...finitePct) : 1;
  const pctAxisMax = maxPct * 1.3;
  const barFrac = 0.4; // les barres n'occupent au plus que 40% de la hauteur du tracé
  const barH = v => (v / pctAxisMax) * plotH * barFrac;
  const barW = Math.max(2, plotW / n * 0.5);
  years.forEach((r, i) => {
    if (pct[i] == null) return;
    const h = barH(pct[i]);
    svgEl.appendChild(el('rect', { class: 'sc-bar', x: x(i) - barW / 2, y: mT + plotH - h, width: barW, height: h }));
  });

  // Zone Prévisions (même convention que la vue Courbes)
  let dashFromIdx = null, labelBoundaryX = null;
  if (fp >= 1) { dashFromIdx = fp - 1; labelBoundaryX = (x(fp - 1) + x(fp)) / 2; }
  else if (fp === 0) { dashFromIdx = 0; labelBoundaryX = mL; }
  if (labelBoundaryX != null) {
    svgEl.appendChild(el('rect', { x: labelBoundaryX, y: mT, width: (mL + plotW) - labelBoundaryX, height: plotH, fill: 'rgba(255,170,30,0.08)' }));
  }

  // Delta des projections : zone ombrée entre les deux scénarios de
  // prévision de l'école (Tendance EPCI / Tendance école, webhook
  // Projections_Scenarios), sur la période de prévision (widget de référence).
  {
    const segIdx = [];
    for (let i = 0; i < n; i++) if (cibleEpci100[i] != null && tendanceEcole100[i] != null) segIdx.push(i);
    if (segIdx.length >= 2) {
      const forward = segIdx.map(i => [x(i), y(cibleEpci100[i])]);
      const backward = segIdx.slice().reverse().map(i => [x(i), y(tendanceEcole100[i])]);
      const poly = [...forward, ...backward];
      const d = poly.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') + ' Z';
      svgEl.appendChild(el('path', { d, fill: 'rgba(100,150,230,0.16)', stroke: 'none' }));
    }
  }

  // La graduation "100" (base de l'indice) doit toujours apparaître, en gras :
  // dessinée à part, plutôt que de dépendre d'une coïncidence avec l'une des
  // graduations également réparties ci-dessous (qui l'omettent si "100" ne
  // tombe pas exactement sur l'un des pas). lo/hi englobent toujours 100 par
  // construction (initialisés à 100 avant d'être élargis par les données).
  const steps = 3;
  for (let i = 0; i <= steps; i++) {
    const v = lo + (hi - lo) * i / steps, yy = y(v);
    svgEl.appendChild(el('line', { class: 'sc-grid', x1: mL, y1: yy, x2: mL + plotW, y2: yy }));
    if (Math.round(v) === 100) continue;
    const t = el('text', { class: 'sc-tick', x: mL - 4, y: yy + 3, 'text-anchor': 'end' }); t.textContent = Math.round(v); svgEl.appendChild(t);
  }
  if (100 >= lo && 100 <= hi) {
    const y100 = y(100);
    svgEl.appendChild(el('line', { class: 'sc-ref', x1: mL, y1: y100, x2: mL + plotW, y2: y100 }));
    const t100 = el('text', { class: 'sc-tick sc-tick-100', x: mL - 4, y: y100 + 3, 'text-anchor': 'end' }); t100.textContent = '100'; svgEl.appendChild(t100);
  }

  // Axe secondaire (droite) : échelle des barres "part école/zone" en %
  const pctTicks = [0, pctAxisMax / 2, pctAxisMax];
  for (const v of pctTicks) {
    const yy = mT + plotH - barH(v);
    const t = el('text', { class: 'sc-tick2', x: mL + plotW + 4, y: yy + 3, 'text-anchor': 'start' });
    t.textContent = (Math.round(v * 10) / 10) + ' %';
    svgEl.appendChild(t);
  }

  svgEl.appendChild(el('line', { class: 'sc-axis', x1: mL, y1: mT + plotH, x2: mL + plotW, y2: mT + plotH }));
  years.forEach((r, i) => {
    const t = el('text', { class: 'sc-xtick', x: x(i), y: mT + plotH + 12, 'text-anchor': 'middle' }); t.textContent = r; svgEl.appendChild(t);
  });

  // Titre de l'axe Y (indice base 100), texte vertical. Pivot décalé de la
  // bordure (x=12, pas 9) : le texte pivoté déborde du point de pivot d'à
  // peu près la moitié de sa hauteur de police de part et d'autre — trop
  // près du bord, il sort du viewBox même sur un libellé court.
  const yTitle = el('text', {
    class: 'sc-ytitle', x: 13, y: mT + plotH / 2,
    'text-anchor': 'middle', transform: `rotate(-90, 13, ${mT + plotH / 2})`,
  });
  yTitle.textContent = 'Base 100';
  svgEl.appendChild(yTitle);

  // Titre de l'axe secondaire (droite) : échelle des barres "part école"
  const rTitleX = W - 13;
  const rTitle = el('text', {
    class: 'sc-ytitle', x: rTitleX, y: mT + plotH / 2,
    'text-anchor': 'middle', transform: `rotate(90, ${rTitleX}, ${mT + plotH / 2})`,
  });
  // Texte volontairement court ("Part école (%)", sans répéter "dans
  // l'EPCI"/"dans la circonscription" — déjà dans le titre du graphique) :
  // en texte pivoté à 90°, sa longueur devient l'extension verticale autour
  // du point de pivot, qui doit tenir dans plotH sous peine d'être rognée en
  // haut/bas du chart pour les libellés de zone longs.
  rTitle.textContent = 'Part école (%)';
  svgEl.appendChild(rTitle);

  if (labelBoundaryX != null) {
    const lblC = el('text', { class: 'sc-zone-lbl', x: (mL + labelBoundaryX) / 2, y: mT - 6, 'text-anchor': 'middle', fill: '#777' }); lblC.textContent = 'Constats'; svgEl.appendChild(lblC);
    const lblP = el('text', { class: 'sc-zone-lbl', x: (labelBoundaryX + mL + plotW) / 2, y: mT - 6, 'text-anchor': 'middle', fill: '#c08400' }); lblP.textContent = 'Prévisions'; svgEl.appendChild(lblP);
  }

  const drawSeries = (arr, color) => {
    const pts = []; arr.forEach((v, i) => { if (v != null) pts.push([x(i), y(v), i, v]); });
    const pathD = a => a.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const addPath = (a, dashed) => {
      if (a.length < 2) return;
      const attrs = { class: 'sc-line', d: pathD(a), stroke: color };
      if (dashed) attrs['stroke-dasharray'] = '4 3';
      svgEl.appendChild(el('path', attrs));
    };
    if (dashFromIdx == null) addPath(pts, false);
    else { addPath(pts.filter(p => p[2] <= dashFromIdx), false); addPath(pts.filter(p => p[2] >= dashFromIdx), true); }
    for (const p of pts) svgEl.appendChild(el('circle', { class: 'sc-dot', cx: p[0], cy: p[1], r: 2, fill: color }));
  };
  drawSeries(area100, '#E07A1F');
  drawSeries(school100, '#1563C2');

  // Tendance EPCI / Tendance école : les deux scénarios de prévision pour
  // l'école (webhook Projections_Scenarios), toujours en pointillé fin,
  // uniquement présentes sur la zone de prévision.
  const drawTrend = (arr, color) => {
    const pts = []; arr.forEach((v, i) => { if (v != null) pts.push([x(i), y(v)]); });
    if (pts.length < 2) return;
    const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    svgEl.appendChild(el('path', { class: 'sc-trend', d, stroke: color }));
  };
  drawTrend(cibleEpci100, '#9A9A9A');
  drawTrend(tendanceEcole100, '#4DA6E8');

  // Infobulle "colonne" : au survol, résume à la verticale du curseur toutes
  // les séries (École, EPCI/circo, part en %) pour l'année la plus proche,
  // plutôt qu'un seul point à la fois.
  let crosshair = null;
  const overlay = el('rect', { x: mL, y: mT, width: plotW, height: plotH, fill: 'transparent', class: 'sc-overlay' });
  overlay.addEventListener('mousemove', ev => {
    const pt = svgEl.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const ctm = svgEl.getScreenCTM();
    if (!ctm) return;
    const loc = pt.matrixTransform(ctm.inverse());
    let i = Math.round((loc.x - mL) / (plotW / Math.max(1, n - 1)));
    i = Math.max(0, Math.min(n - 1, i));
    if (crosshair) crosshair.remove();
    crosshair = el('line', { class: 'sc-crosshair', x1: x(i), y1: mT, x2: x(i), y2: mT + plotH });
    svgEl.appendChild(crosshair);
    showTip(schoolCompareTipHtml(data, i), ev.clientX, ev.clientY, true);
  });
  overlay.addEventListener('mouseleave', () => {
    if (crosshair) { crosshair.remove(); crosshair = null; }
    hideTip();
  });
  svgEl.appendChild(overlay);
}
// Infobulle combinée pour l'année à l'index i : reprend le principe du
// widget de référence (toutes les séries à la verticale du curseur), avec un
// format corrigé — l'indice est bien un pourcentage ("101,8 %") et la
// variation par rapport à n-1 est exprimée en points de pourcentage signés.
function schoolCompareTipHtml(data, i) {
  const { years, school100, area100, pct, schoolVals, areaVals, areaLabel, pivotIdx, cibleEpci100, tendanceEcole100, cibleEpciArr, tendanceEcoleArr } = data;
  const fmtIdx = v => v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmtVar = (arr) => {
    if (i === 0 || arr[i] == null || arr[i - 1] == null) return '';
    const diff = Math.round((arr[i] - arr[i - 1]) * 10) / 10;
    if (diff === 0) return '';
    const arrow = diff > 0 ? '▲' : '▼', cls = diff > 0 ? 'tip-pos' : 'tip-neg', sign = diff > 0 ? '+' : '';
    return ` <span class="${cls}">${arrow} ${sign}${fmtIdx(diff)}% (/n-1)</span>`;
  };
  let html = `<strong>${years[i]}</strong>`;
  const rows = [
    { label: 'École', idx: school100[i], raw: schoolVals[i], arr: school100, cls: 'tip-color-ecole' },
    { label: areaLabel, idx: area100[i], raw: areaVals[i], arr: area100, cls: 'tip-color-area' },
  ];
  // Les deux scénarios de prévision n'ont de sens que sur la période de
  // prévision, et sont redondants avec "École" au point de raccord (pivot).
  if (i > pivotIdx) {
    rows.push({ label: 'Tendance EPCI', idx: cibleEpci100[i], raw: cibleEpciArr[i], arr: cibleEpci100, cls: 'tip-color-tendance-epci' });
    rows.push({ label: 'Tendance école', idx: tendanceEcole100[i], raw: tendanceEcoleArr[i], arr: tendanceEcole100, cls: 'tip-color-tendance-ecole' });
  }
  for (const r of rows) {
    if (r.idx == null) continue;
    const rawTxt = r.raw != null ? ` (${Math.round(r.raw).toLocaleString('fr-FR')} élèves)` : '';
    html += `<br><span class="${r.cls}">●</span> ${escXml(r.label)} : ${fmtIdx(r.idx)} %${rawTxt}${fmtVar(r.arr)}`;
  }
  if (pct[i] != null) {
    html += `<br><span class="tip-color-part">■</span> Part école/${escXml(areaLabel)} : ${fmtIdx(pct[i])} %`;
  }
  return html;
}
function buildSchoolCompareLegend(legendEl, data) {
  if (!data || data.error) { legendEl.innerHTML = ''; return; }
  const baseLabel = data.years[data.baseIdx];
  legendEl.innerHTML =
    `<span class="scl-item"><span class="scl-swatch scl-color-ecole"></span>École</span>`
    + `<span class="scl-item"><span class="scl-swatch scl-color-area"></span>${escXml(data.areaLabel)}</span>`
    + `<span class="scl-item"><span class="scl-line dashed"></span>Référence (base 100 = ${baseLabel})</span>`
    + `<span class="scl-item"><span class="scl-swatch scl-color-part"></span>Part école dans ${escXml(data.areaLabel)} (%, axe droit)</span>`
    + `<span class="scl-item"><span class="scl-line dashed scl-color-tendance-epci"></span>Tendance EPCI</span>`
    + `<span class="scl-item"><span class="scl-line dashed scl-color-tendance-ecole"></span>Tendance école</span>`
    + `<span class="scl-item"><span class="scl-swatch scl-color-delta"></span>Delta des projections</span>`;
}
function renderSchoolCompareChart(school, code) {
  schoolCompareData = computeSchoolCompareData(school, code);
  const areaBit = schoolCompareData && !schoolCompareData.error
    ? ` — Comparaison base 100 (${schoolCompareData.areaLabel} ${schoolCompareData.areaName})` : '';
  schoolCompareTitle = schoolDisplayName(school) + areaBit;
  const statusEl = document.getElementById('info-school-chart-status');
  const svg = document.getElementById('info-school-chart');
  const legend = document.getElementById('info-school-chart-legend');
  const header = document.getElementById('info-school-chart-header');
  if (!schoolCompareData || schoolCompareData.error) {
    statusEl.textContent = schoolCompareData ? schoolCompareData.error : 'Comparaison indisponible (zone non identifiée).';
    statusEl.hidden = false;
    svg.innerHTML = ''; legend.innerHTML = ''; header.hidden = true;
    return;
  }
  statusEl.hidden = true; header.hidden = false;
  drawSchoolCompareChart(svg, schoolCompareData);
  buildSchoolCompareLegend(legend, schoolCompareData);
}
function openSchoolChartModal() {
  if (!schoolCompareData || schoolCompareData.error) return;
  document.getElementById('chart-modal-title').textContent = schoolCompareTitle;
  drawSchoolCompareChart(document.getElementById('chart-modal-svg'), schoolCompareData);
  buildSchoolCompareLegend(document.getElementById('chart-modal-legend'), schoolCompareData);
  document.getElementById('chart-modal').hidden = false;
}
function closeSchoolChartModal() {
  document.getElementById('chart-modal').hidden = true;
}

/* ── Conversion de coordonnées écoles (Lambert-93 ou lat/lng inversés) ── */
function lambert93ToWGS84(X, Y) {
  const a = 6378137, e2 = 0.00669438002290, e = Math.sqrt(e2);
  const phi1 = 44 * Math.PI/180, phi2 = 49 * Math.PI/180, phi0 = 46.5 * Math.PI/180, lambda0 = 3 * Math.PI/180;
  const X0 = 700000, Y0 = 6600000;
  const m = phi => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi)**2);
  const t = phi => Math.tan(Math.PI/4 - phi/2) / Math.pow((1 - e*Math.sin(phi)) / (1 + e*Math.sin(phi)), e/2);
  const m1 = m(phi1), m2 = m(phi2), t1 = t(phi1), t2 = t(phi2), t0 = t(phi0);
  const n = (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
  const F = m1 / (n * Math.pow(t1, n));
  const rho0 = a * F * Math.pow(t0, n);
  const dx = X - X0, dy = rho0 - (Y - Y0);
  const rho = Math.sign(n) * Math.sqrt(dx*dx + dy*dy);
  const theta = Math.atan2(dx, dy);
  const lambda = lambda0 + theta / n;
  const tPrime = Math.pow(rho / (a * F), 1 / n);
  let phi = Math.PI/2 - 2 * Math.atan(tPrime);
  for (let i = 0; i < 6; i++) {
    phi = Math.PI/2 - 2 * Math.atan(tPrime * Math.pow((1 - e*Math.sin(phi)) / (1 + e*Math.sin(phi)), e/2));
  }
  return [lambda * 180/Math.PI, phi * 180/Math.PI]; // [lng, lat]
}
// Déduit [lng, lat] à partir de deux valeurs brutes, quel que soit leur système
// d'origine : degrés décimaux (dans le bon ordre ou inversés) ou Lambert-93 (mètres).
function resolveSchoolCoords(rawX, rawY) {
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return [NaN, NaN];
  const looksLikeDegrees = Math.abs(rawX) <= 20 && Math.abs(rawY) <= 90 || Math.abs(rawY) <= 20 && Math.abs(rawX) <= 90;
  if (looksLikeDegrees) {
    // En France métropolitaine, la longitude est toujours < la latitude.
    return rawX < rawY ? [rawX, rawY] : [rawY, rawX];
  }
  return lambert93ToWGS84(rawX, rawY);
}

/* ── Données écoles (webhook Effectifs_RS19_RS30) ── */
let schoolModel = null;
function buildSchoolModel(records) {
  const model = { points: [] };
  if (!records || records.length === 0) return model;
  console.debug('[dataviz] premier enregistrement école brut :', records[0]);
  const keys = Object.keys(records[0]);
  const find = re => keys.find(k => re.test(k));
  const colUai = find(/uai.*texte/i) || find(/^uai$/i) || find(/gristHelper_Display/i) || find(/uai/i);
  const colUaiRpi = find(/uai.*rpi/i) || find(/rpi/i);
  const colX = find(/coordx/i) || find(/longitude|lng|lon/i) || find(/^x$/i);
  const colY = find(/coordy/i) || find(/latitude|lat/i) || find(/^y$/i);
  const colSigle = find(/sigle/i);
  const colCommune = find(/commune/i);
  const colDenomination = find(/denomination/i) || find(/ecole.*nom/i) || keys.find(k => k !== colUai && k !== colSigle && k !== colCommune && /nom|libell|ecole/i.test(k));
  const colType = find(/^nature$/i) || find(/type.*etab|nature.*etab|type.*ecole/i)
    || keys.find(k => /^E\.[A-Z]\.[A-Z]{2}$/.test(String(records[0][k])));
  const colScenario = find(/scenario/i);
  const colRentree = find(/rent/i);
  const colEffectif = find(/effectif|eleve|total/i);
  // Rattachement EPCI/circonscription : colonnes ajoutées à Projections_Scenarios
  // (formules Grist qui vont chercher dans Corresp_EPCI / Corresp_Circos), à
  // privilégier sur le test géométrique point-dans-polygone (findContainingFeature)
  // — plus fiable près d'une frontière ou si les coordonnées de l'école sont
  // légèrement fausses.
  const colCircoNom = keys.find(k => /circo/i.test(k) && /nom/i.test(k));
  const colCircoUai = keys.find(k => /circo/i.test(k) && /uai/i.test(k));
  const colEpciCode = keys.find(k => /epci/i.test(k) && /code/i.test(k));

  // Trois formats possibles, détectés dans cet ordre : "large" (une colonne
  // par rentrée RS19..RS30), "dépivoté à scénarios" (Projections_Scenarios :
  // une ligne par école × rentrée × scénario — constat/moy/cible_EPCI/
  // tendance_ecole), ou dépivoté simple (une ligne par école × rentrée,
  // sans notion de scénario).
  const rsKeyMap = {};
  for (const rs of RENTREES_ALL) {
    const k = keys.find(kk => kk.toLowerCase() === rs.toLowerCase());
    if (k) rsKeyMap[rs] = k;
  }
  const isWide = Object.keys(rsKeyMap).length >= 2;
  const isScenarioFormat = !isWide && !!colScenario && !!colRentree && !!colEffectif;
  const format = isWide ? 'large (1 colonne par rentrée)' : isScenarioFormat ? 'dépivoté à scénarios (Projections_Scenarios)' : 'dépivoté simple (1 ligne par rentrée)';
  console.debug('[dataviz] format écoles détecté :', format,
    { colUai, colUaiRpi, colX, colY, colSigle, colDenomination, colCommune, colType, colScenario, colRentree, colEffectif, colCircoNom, colCircoUai, colEpciCode, rsKeyMap });

  const makeSchool = (uai, lng, lat, row) => ({
    uai, lng, lat,
    sigle: colSigle ? row[colSigle] : '',
    denomination: colDenomination ? row[colDenomination] : uai,
    commune: colCommune ? row[colCommune] : '',
    type: colType ? row[colType] : null,
    uaiRpi: colUaiRpi ? String(row[colUaiRpi] ?? '').trim() : '',
    circoNom: colCircoNom ? String(row[colCircoNom] ?? '').trim() : '',
    circoUai: colCircoUai ? String(row[colCircoUai] ?? '').trim() : '',
    epciCode: colEpciCode ? String(row[colEpciCode] ?? '').trim() : '',
    years: {}, cibleEpci: {}, tendanceEcole: {},
  });
  const byUai = {};
  if (isWide) {
    for (const row of records) {
      const uai = String(row[colUai]);
      const [lng, lat] = resolveSchoolCoords(Number(row[colX]), Number(row[colY]));
      const s = makeSchool(uai, lng, lat, row);
      for (const [rs, k] of Object.entries(rsKeyMap)) {
        const v = Number(row[k]);
        if (Number.isFinite(v)) s.years[rs] = v;
      }
      byUai[uai] = s;
    }
  } else if (isScenarioFormat) {
    // "moy" alimente les vues normales de l'app (constat sur RS19-RS25,
    // moyenne projetée sur RS26-RS30) ; cible_EPCI et tendance_ecole ne
    // servent qu'au Delta des projections du graphique de comparaison.
    for (const row of records) {
      const uai = String(row[colUai]);
      const scenario = String(row[colScenario] ?? '').trim();
      const rs = row[colRentree];
      const eff = Number(row[colEffectif]);
      if (!Number.isFinite(eff)) continue;
      if (!byUai[uai]) {
        const [lng, lat] = resolveSchoolCoords(Number(row[colX]), Number(row[colY]));
        byUai[uai] = makeSchool(uai, lng, lat, row);
      }
      const s = byUai[uai];
      if (scenario === 'constat' || scenario === 'moy') s.years[rs] = eff;
      else if (scenario === 'cible_EPCI') s.cibleEpci[rs] = eff;
      else if (scenario === 'tendance_ecole') s.tendanceEcole[rs] = eff;
    }
  } else {
    let colEleves = colEffectif;
    if (!colEleves) {
      const colEtat = find(/etat|tat/i);
      const excluded = new Set([colUai, colX, colY, colRentree, colEtat]);
      colEleves = keys.find(k => !excluded.has(k) && typeof records[0][k] === 'number');
    }
    for (const row of records) {
      const uai = String(row[colUai]);
      const eff = Number(row[colEleves]);
      if (!Number.isFinite(eff)) continue;
      if (!byUai[uai]) {
        const [lng, lat] = resolveSchoolCoords(Number(row[colX]), Number(row[colY]));
        byUai[uai] = makeSchool(uai, lng, lat, row);
      }
      byUai[uai].years[row[colRentree]] = eff;
    }
  }

  const rentreesAll = RENTREES_ALL.filter(r => Object.values(byUai).some(s => s.years[r] != null));
  const cumulRange = rentreesAll.slice(-5);
  for (const s of Object.values(byUai)) {
    if (!Number.isFinite(s.lng) || !Number.isFinite(s.lat)) continue;
    if (cumulRange.length >= 2) {
      const lastRS = cumulRange[cumulRange.length-1];
      const idxFirst = rentreesAll.indexOf(cumulRange[0]);
      const prevFirstRS = idxFirst > 0 ? rentreesAll[idxFirst-1] : null;
      const vLast = s.years[lastRS], vPrev = prevFirstRS != null ? s.years[prevFirstRS] : null;
      if (vLast != null && vPrev != null) {
        s.cumul = vLast - vPrev;
        // Une école fermée (effectif nul à la dernière rentrée du cumul)
        // affiche toujours exactement -100%, une valeur dégénérée (pas une
        // mesure de déclin comparable aux autres écoles) qui fausserait les
        // classes (Jenks) et la légende en unité Pourcentage : cumulPct
        // reste donc non défini pour ces écoles (le cumul en effectifs
        // bruts, lui, reste pertinent et n'est pas affecté).
        if (vPrev !== 0 && vLast !== 0) s.cumulPct = (vLast - vPrev) / vPrev * 100;
      }
    }
    model.points.push(s);
  }
  const sample = model.points.slice(0, 3).map(s => ({ uai: s.uai, lng: s.lng, lat: s.lat, cumul: s.cumul }));
  console.debug('[dataviz] écoles résolues (échantillon) :', sample);
  return model;
}
async function ensureSchoolData() {
  if (schoolModel) return schoolModel;
  const records = await postJson(CONFIG.webhookEcoles, state.sessId);
  schoolModel = buildSchoolModel(records);
  return schoolModel;
}

/* ── Données RPI (webhook correspondance UAI_RPI ↔ communes) ── */
// Un code INSEE commune fait toujours 5 caractères (ex. 82121, 2A004,
// 97411) : si Grist stocke la colonne en nombre plutôt qu'en texte, un zéro
// initial peut être perdu (ex. "01001" -> 1001). On le restitue ici pour que
// la clé corresponde bien au champ "code" renvoyé par geo.api.gouv.fr.
function normalizeInseeCode(v) {
  const s = String(v ?? '').trim();
  return /^\d+$/.test(s) && s.length < 5 ? s.padStart(5, '0') : s;
}
let rpiModel = null;
function buildRpiModel(records) {
  const model = { groups: [] }; // [{ uaiRpi, communeCodes:[...], communeNames:[...] }]
  if (!records || records.length === 0) return model;
  const keys = Object.keys(records[0]);
  const find = re => keys.find(k => re.test(k));
  const colUaiRpi = find(/uai.*rpi/i) || find(/rpi/i);
  const colCommuneCode = find(/code.*insee/i) || find(/insee/i) || find(/code.*commune/i);
  const colCommuneNom = find(/nom.*commune/i) || keys.find(k => k !== colUaiRpi && k !== colCommuneCode && /commune/i.test(k));
  console.debug('[dataviz] colonnes détectées (RPI) :', { colUaiRpi, colCommuneCode, colCommuneNom });
  const byRpi = {};
  for (const row of records) {
    const uaiRpi = String(row[colUaiRpi] ?? '').trim();
    const code = colCommuneCode ? normalizeInseeCode(row[colCommuneCode]) : '';
    const nom = colCommuneNom ? String(row[colCommuneNom] ?? '').trim() : '';
    if (!uaiRpi || !code) continue;
    if (!byRpi[uaiRpi]) byRpi[uaiRpi] = { uaiRpi, communeCodes: [], communeNames: [] };
    byRpi[uaiRpi].communeCodes.push(code);
    byRpi[uaiRpi].communeNames.push(nom || code);
  }
  model.groups = Object.values(byRpi);
  return model;
}
async function ensureRpiData() {
  if (rpiModel) return rpiModel;
  const records = await postJson(CONFIG.webhookRpi, state.sessId);
  rpiModel = buildRpiModel(records);
  return rpiModel;
}
// Rattachement école → RPI par UAI_RPI (colonne ajoutée à la source écoles
// pour fiabiliser ce rapprochement ; le rattachement par nom de commune
// produisait des incohérences).
function findRpiForSchool(school, rpi) {
  if (!school?.uaiRpi || !rpi?.groups?.length) return null;
  return rpi.groups.find(g => g.uaiRpi === school.uaiRpi) || null;
}

/* ── Contours communes (geo.api.gouv.fr) + fusion des polygones d'un RPI ──
   Couche annexe, indépendante des webhooks n8n : les contours de communes
   ne changent quasiment jamais, on les charge à la demande (mode "écoles"
   uniquement) et on les met en cache par département. */
function deptFromInseeCode(code) {
  return /^(97|98)/.test(code) ? code.slice(0, 3) : code.slice(0, 2);
}
let communeByCode = {};
const communeDeptsLoaded = new Set();
async function fetchCommunesForDept(dept) {
  const url = `${CONFIG.communesApi}?codeDepartement=${encodeURIComponent(dept)}&geometry=contour&format=geojson&fields=nom,code`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Erreur chargement des contours communes (HTTP ${res.status}).`);
  return await res.json();
}
async function ensureCommuneGeometries(codes) {
  const depts = [...new Set(codes.map(deptFromInseeCode))].filter(d => !communeDeptsLoaded.has(d));
  await Promise.all(depts.map(async dept => {
    let fc;
    try { fc = await fetchCommunesForDept(dept); }
    catch (err) { console.error(`[dataviz] Erreur chargement communes du département ${dept} :`, err); communeDeptsLoaded.add(dept); return; }
    for (const f of (fc.features || [])) {
      const code = normalizeInseeCode(f.properties?.code);
      if (!code) continue;
      communeByCode[code] = { code, nom: f.properties?.nom || code, geometry: f.geometry };
    }
    communeDeptsLoaded.add(dept);
  }));
}
function unionCommuneGroup(codes) {
  const feats = codes.map(c => communeByCode[c]).filter(Boolean)
    .map(c => ({ type: 'Feature', properties: {}, geometry: c.geometry }));
  if (feats.length === 0) return null;
  if (feats.length === 1) return feats[0];
  try {
    return turf.union({ type: 'FeatureCollection', features: feats });
  } catch (err) {
    console.error('[dataviz] Erreur fusion des polygones communes (RPI) :', err);
    return feats[0];
  }
}
let rpiGeojson = null;
async function ensureRpiGeometry() {
  if (rpiGeojson) return rpiGeojson;
  const rpi = await ensureRpiData();
  if (!rpi.groups.length) { rpiGeojson = { type: 'FeatureCollection', features: [] }; return rpiGeojson; }
  const allCodes = rpi.groups.flatMap(g => g.communeCodes);
  await ensureCommuneGeometries(allCodes);
  const features = [];
  for (const g of rpi.groups) {
    const merged = unionCommuneGroup(g.communeCodes);
    if (!merged) continue;
    features.push({
      type: 'Feature',
      properties: { uaiRpi: g.uaiRpi, communeNames: g.communeNames },
      geometry: merged.geometry,
    });
  }
  rpiGeojson = { type: 'FeatureCollection', features };
  return rpiGeojson;
}

/* ── Couche "Écoles" (drill-down) ── */
let schoolLayerGroup = null;
function clearSchoolLayer() {
  if (schoolLayerGroup) { schoolLayerGroup.remove(); schoolLayerGroup = null; }
}
/* ── Couche "RPI" (regroupements pédagogiques intercommunaux) : contours
   fusionnés des communes membres, visible uniquement en mode "écoles". ── */
let rpiLayer = null;
function clearRpiLayer() {
  if (rpiLayer) { rpiLayer.remove(); rpiLayer = null; }
}
function rpiPolygonStyle() {
  // Moins gras que le contour simplifié des EPCI/circo (weight 4) en mode
  // écoles ; pointillé gris pour bien le distinguer, aucun remplissage.
  return { weight: 2, color: '#777', dashArray: '5 4', fillOpacity: 0, interactive: false };
}
async function showRpiLayer() {
  let fc;
  try { fc = await ensureRpiGeometry(); }
  catch (err) { console.error('[dataviz] Erreur chargement des contours RPI :', err); return; }
  if (!schoolsModeActive) return; // le mode a pu être désactivé pendant le chargement
  clearRpiLayer();
  if (!fc.features.length) return;
  rpiLayer = L.geoJSON(fc, { style: rpiPolygonStyle }).addTo(map);
}
// Classes à pas fixe (5 élèves en Variation, 1 point en Pourcentage), même
// palette divergente que les légendes EPCI/circo (buildRelatifColors).
function buildSchoolBreaksFixed(values, step) {
  const finite = values.filter(v => v != null && Number.isFinite(v));
  if (finite.length === 0) return { breaks: [], colors: [] };
  const mn = Math.min(...finite), mx = Math.max(...finite);
  const lo = Math.floor(Math.min(mn, 0) / step) * step;
  const hi = Math.ceil(Math.max(mx, 0) / step) * step;
  const breaks = [];
  for (let v = lo; v <= hi + step*1e-9; v += step) breaks.push(Math.round(v*100)/100);
  if (breaks.length < 2) breaks.push(lo + step);
  return { breaks, colors: buildRelatifColors(breaks) };
}
function getColorFromBreaks(val, breaks, colors) {
  if (val == null || !colors.length) return '#999';
  for (let i = 0; i < colors.length - 1; i++) if (val <= breaks[i+1]) return colors[i];
  return colors[colors.length-1];
}
function formatSchoolVal(v) {
  const sign = v > 0 ? '+' : '';
  return sign + Math.round(v).toLocaleString('fr-FR') + ' él.';
}
function fmtSchoolPct(v) {
  if (v == null) return '·';
  const sign = v > 0 ? '+' : '';
  return sign + v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
}
// Même style de plage que la légende EPCI/circo (fmtLegendRange).
function fmtSchoolLegendRange(lo, hi, isPct) {
  const unit = isPct ? ' %' : ' élèves';
  const fmt = isPct ? v => v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : v => v.toLocaleString('fr-FR');
  if (hi <= 0) return fmt(hi) + ' à ' + fmt(lo) + unit;
  const fmtLo = lo === 0 ? (isPct ? '0,0' : '0') : '+' + fmt(lo);
  return fmtLo + ' à +' + fmt(hi) + unit;
}
function schoolLegendTitle(isPct) {
  return isPct ? "Variation cumulée (%) RS26–RS30" : "Variation en nombre d'élèves cumulée RS26-RS30";
}
function showSchoolLegend(breaks, colors, isPct) {
  const el = document.getElementById('map-legend');
  let html = `<h4>${schoolLegendTitle(isPct)}</h4>`;
  if (!colors.length) html += `<em class="legend-empty">Aucune école avec données.</em>`;
  for (let i = colors.length - 1; i >= 0; i--) {
    html += `<div class="legend-item"><div class="legend-color" data-swatch-bg="${colors[i]}"></div><span>${fmtSchoolLegendRange(breaks[i], breaks[i+1], isPct)}</span></div>`;
  }
  el.innerHTML = html;
  applySwatchColors(el);
}
function schoolDisplayName(school, withCommune = true) {
  const main = [school.sigle, school.denomination].filter(Boolean).join(' ');
  return (withCommune && school.commune) ? `${main} (${school.commune})` : main;
}
// Ordre de priorité dans la grille : maternelle publique, puis élémentaire
// publique, puis primaire (1er degré) publique.
const SCHOOL_TYPE_ORDER = { 'E.M.PU': 0, 'E.E.PU': 1, 'E.P.PU': 2 };
// Écarte les points-écoles trop proches à l'écran (chevauchement visuel) :
// grille aussi carrée que possible (2 à 5 colonnes), triée par type d'école.
// mapInstance : la carte Leaflet dont projeter les points — la carte en
// direct par défaut, ou une carte hors-écran dédiée à l'export (résolution
// différente, donc seuils de proximité différents — cf. appelants).
function declusterSchoolPoints(points, mapInstance = map, thresholdPx = 16, spacingPx = 14) {
  const THRESHOLD_PX = thresholdPx, SPACING_PX = spacingPx;
  const pts = points.map(p => {
    const xy = mapInstance.latLngToLayerPoint([p.lat, p.lng]);
    return { school: p, x: xy.x, y: xy.y };
  });
  const visited = new Array(pts.length).fill(false);
  const clusters = [];
  for (let i = 0; i < pts.length; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const stack = [i], cluster = [];
    while (stack.length) {
      const idx = stack.pop();
      cluster.push(idx);
      for (let j = 0; j < pts.length; j++) {
        if (visited[j]) continue;
        const dx = pts[idx].x - pts[j].x, dy = pts[idx].y - pts[j].y;
        if (Math.sqrt(dx*dx + dy*dy) < THRESHOLD_PX) { visited[j] = true; stack.push(j); }
      }
    }
    cluster.sort((a, b) => (SCHOOL_TYPE_ORDER[pts[a].school.type] ?? 99) - (SCHOOL_TYPE_ORDER[pts[b].school.type] ?? 99));
    clusters.push(cluster);
  }
  const placed = [];
  for (const cluster of clusters) {
    const n = cluster.length;
    if (n === 1) { const p = pts[cluster[0]]; placed.push({ school: p.school, x: p.x, y: p.y }); continue; }
    const cols = Math.max(2, Math.min(5, Math.round(Math.sqrt(n))));
    const rows = Math.ceil(n / cols);
    const cx = cluster.reduce((s,i) => s + pts[i].x, 0) / n;
    const cy = cluster.reduce((s,i) => s + pts[i].y, 0) / n;
    cluster.forEach((idx, k) => {
      const col = k % cols, row = Math.floor(k / cols);
      placed.push({
        school: pts[idx].school,
        x: cx + (col - (cols-1)/2) * SPACING_PX,
        y: cy + (row - (rows-1)/2) * SPACING_PX,
      });
    });
  }
  return placed.map(({ school, x, y }) => {
    const ll = mapInstance.layerPointToLatLng([x, y]);
    return { school, lat: ll.lat, lng: ll.lng };
  });
}
// Contenu de l'infobulle d'un point-école : nom en gras, puis effectifs
// RS25/RS26 et cumul RS26-RS30, indépendamment de l'unité affichée sur la
// carte (variation/pourcentage colorent le point mais ne changent pas
// l'infobulle).
function schoolTooltipHtml(school) {
  const fmtN = v => v == null ? '·' : Math.round(v).toLocaleString('fr-FR') + ' élèves';
  const fmtSigned = v => {
    if (v == null) return '·';
    const sign = v > 0 ? '+' : '';
    return sign + Math.round(v).toLocaleString('fr-FR') + ' élèves';
  };
  return `<b>${escXml(schoolDisplayName(school))}</b><br>`
    + `Effectifs RS25 : ${fmtN(school.years.RS25)}<br>`
    + `Effectifs RS30 : ${fmtN(school.years.RS30)}<br>`
    + `Cumul RS26-RS30 : ${fmtSigned(school.cumul)}`;
}
async function showSchoolsForFeature() {
  let model;
  try { model = await ensureSchoolData(); }
  catch (err) { console.error('[dataviz] Erreur chargement des écoles :', err); return; }
  const isPct = state.type === 'pourcentage';
  const valueOf = p => isPct ? p.cumulPct : p.cumul;
  const withValue = model.points.filter(p => valueOf(p) != null);
  if (schoolLayerGroup) schoolLayerGroup.remove();
  const { breaks, colors } = isPct
    ? buildJenksColors(withValue.map(valueOf), 8)
    : buildSchoolBreaksFixed(withValue.map(valueOf), 5);
  const placed = declusterSchoolPoints(withValue);
  schoolLayerGroup = L.layerGroup();
  for (const { school: p, lat, lng } of placed) {
    const val = valueOf(p);
    L.circleMarker([lat, lng], {
      radius: 6, weight: 1, color: '#333',
      fillColor: getColorFromBreaks(val, breaks, colors), fillOpacity: 0.9,
    }).bindTooltip(schoolTooltipHtml(p))
      .on('click', () => showSchoolInfo(p))
      .addTo(schoolLayerGroup);
  }
  schoolLayerGroup.addTo(map);
  showSchoolLegend(breaks, colors, isPct);
}
function clearLabels(){ labelMarkers.forEach(m=>m.remove()); labelMarkers=[]; }
function addLabels() {
  const cache = scaleCache[state.echelle];
  for (const feature of cache.geojson.features) {
    const code = String(feature.properties[cache.codeProp]);
    const nom = cache.model.NOM_BY_CODE[code] || feature.properties.circo || feature.properties.nom || code;
    const center = featureCenter(feature);
    // Bouton "Afficher les valeurs" : nom seul si désactivé. Bouton "Seconde
    // unité" (Variation/Pourcentage) : 3e ligne avec l'unité complémentaire,
    // uniquement si la valeur principale est elle-même affichée.
    const delta = state.showValues ? getVal(code) : null;
    let varHtml = '';
    if (delta != null) {
      const cls = delta>0?'var-pos':delta<0?'var-neg':'var-zero';
      varHtml = `<span class="epci-variation ${cls}">${formatVal(delta)}</span>`;
    }
    let unit2Html = '';
    if (delta != null && state.showSecondUnit && state.type !== 'effectifs') {
      const secondary = getSecondaryVal(code);
      if (secondary != null) {
        const cls2 = secondary>0?'var-pos':secondary<0?'var-neg':'var-zero';
        unit2Html = `<span class="epci-variation2 ${cls2}">${formatSecondaryVal(secondary)}</span>`;
      }
    }
    const nameText = wrapName(nom);
    const nLines = (nameText.match(/<br>/g)||[]).length + 1;
    const anchorY = Math.round((nLines*19 + (delta!=null?20:0) + (unit2Html?16:0)) / 2);
    const icon = L.divIcon({ className:'epci-label', html:`<div class="epci-label-inner">${nameText}${varHtml}${unit2Html}</div>`,
      iconSize:[150,null], iconAnchor:[75,anchorY] });
    labelMarkers.push(L.marker(center, {icon, interactive:false}).addTo(map));
  }
}
function fmtLegendRange(lo, hi) {
  if (lo==null||hi==null) return '';
  if (state.type === 'effectifs') return lo.toLocaleString('fr-FR') + ' à ' + (hi-1).toLocaleString('fr-FR') + ' élèves';
  const isPct = state.type === 'pourcentage';
  const unit = isPct ? ' %' : ' élèves';
  const fmt = isPct ? v=>v.toLocaleString('fr-FR',{minimumFractionDigits:1,maximumFractionDigits:1}) : v=>v.toLocaleString('fr-FR');
  if (hi<=0) return fmt(hi) + ' à ' + fmt(lo) + unit;
  const fmtLo = lo===0 ? (isPct?'0,0':'0') : '+'+fmt(lo);
  return fmtLo + ' à +' + fmt(hi) + unit;
}
function legendTitle() {
  const cumul = currentRentree() === 'CUMUL';
  if (state.type === 'effectifs') return "Nombre d'élèves";
  if (state.type === 'pourcentage') return cumul ? "Variation cumulée (%) RS26–RS30" : "Variation (%) par rapport à n−1";
  return cumul ? "Variation en nombre d'élèves cumulée RS26-RS30" : "Variation du nombre d'élèves par rapport à n−1";
}
function updateLegend() {
  const cache = scaleCache[state.echelle];
  const key = activeBreakKey();
  const breaks = cache.model.BREAKS[key], colors = cache.model.COLORS[key], n = cache.model.N[key];
  const el = document.getElementById('map-legend');
  if (!breaks || breaks.length < 2 || !n) { el.innerHTML = `<h4>${legendTitle()}</h4>`; return; }
  let html = `<h4>${legendTitle()}</h4>`;
  for (let i = n-1; i >= 0; i--) {
    html += `<div class="legend-item"><div class="legend-color" data-swatch-bg="${colors[i]}"></div><span>${fmtLegendRange(breaks[i], breaks[i+1])}</span></div>`;
  }
  el.innerHTML = html;
  applySwatchColors(el);
}

function renderMap() {
  const cache = scaleCache[state.echelle];
  clearSchoolLayer();
  closeInfoPanel();
  if (geojsonLayer) geojsonLayer.remove();
  clearLabels();
  geojsonLayer = L.geoJSON(cache.geojson, { style: styleFeature, onEachFeature }).addTo(map);
  schoolsZoomedBounds = null;
  lastFitBounds = geojsonLayer.getBounds();
  map.fitBounds(lastFitBounds, { padding: [10,10] });
  if (schoolsModeActive) {
    geojsonLayer.eachLayer(l => l.setStyle(simplifiedPolygonStyle()));
    showSchoolsForFeature();
  } else {
    addLabels();
    updateLegend();
  }
}

/* ── Frise (RS19…RS30 + Cumul) ── */
function buildTimeline() {
  const cache = scaleCache[state.echelle];
  document.getElementById('tl-wrap').classList.toggle('disabled', schoolsModeBlocksControls());
  const tlRail = document.getElementById('tl-rail'), tlZones = document.getElementById('tl-zones');
  tlRail.innerHTML = ''; tlZones.innerHTML = '';
  const rentrees = cache.model.RENTREES_DISPO.filter(r => state.type !== 'effectifs' || r !== 'CUMUL');
  let idxPrev = rentrees.findIndex(r => r === 'CUMUL' || r > 'RS25');
  if (idxPrev < 0) idxPrev = rentrees.length - 1;
  const nPrev = rentrees.length - idxPrev;
  const zc = document.createElement('div'); zc.className='tl-zone constat'; zc.style.flex=idxPrev;
  zc.innerHTML = '<span class="tl-zone-label">Constat</span>'; tlZones.appendChild(zc);
  const zp = document.createElement('div'); zp.className='tl-zone previsions'; zp.style.flex=nPrev;
  zp.innerHTML = '<span class="tl-zone-label">Prévisions</span>'; tlZones.appendChild(zp);
  // selectRentree() reconstruit entièrement la frise (tlRail.innerHTML vidé
  // par buildTimeline), donc l'élément DOM cliqué/focus est détruit à chaque
  // sélection : on refocalise explicitement le nouvel item actif après coup
  // pour que les flèches gauche/droite restent utilisables d'une pression à
  // l'autre sans repasser par un clic.
  const selectRentree = rr => {
    if (schoolsModeBlocksControls()) return;
    state.rentreeIdx = cache.model.RENTREES_DISPO.indexOf(rr);
    buildTimeline();
    if (!schoolsModeActive && geojsonLayer) { geojsonLayer.setStyle(styleFeature); clearLabels(); addLabels(); updateLegend(); }
    updateTitle();
    syncUrlFromState();
    const active = tlRail.querySelector('.tl-item.active');
    if (active) active.focus();
  };
  rentrees.forEach((r,i) => {
    const isCumul = r === 'CUMUL';
    const item = document.createElement('div');
    item.className = 'tl-item' + (isCumul?' cumul':'') + (r===currentRentree()?' active':'');
    item.tabIndex = 0;
    item.innerHTML = `<span class="tl-label">${isCumul?'Cumul<br>RS26–RS30':r}</span><div class="tl-dot"></div>`;
    item.addEventListener('click', () => selectRentree(r));
    item.addEventListener('keydown', ev => {
      if (ev.key === 'ArrowRight' && i < rentrees.length - 1) { ev.preventDefault(); selectRentree(rentrees[i+1]); }
      else if (ev.key === 'ArrowLeft' && i > 0) { ev.preventDefault(); selectRentree(rentrees[i-1]); }
    });
    tlRail.appendChild(item);
  });
}

/* ══════════════════════ TITRE / NAVIGATION ══════════════════════ */
function scaleLabel() { return state.echelle === 'epci' ? 'EPCI' : 'circonscriptions'; }
function typeLabel() {
  if (state.type === 'effectifs') return "en nombre total d'élèves";
  if (state.type === 'pourcentage') return "en pourcentage de variation";
  return "en variation du nombre d'élèves";
}
function titlePrefix() {
  return state.type === 'variation' ? 'Variation' : 'Evolution';
}
function updateTitle() {
  const unite = typeLabel();
  const uniteCap = unite.charAt(0).toUpperCase() + unite.slice(1);
  const mainWord = titlePrefix();
  let periodPart;
  if (schoolsModeActive) {
    periodPart = ' — Cumul RS26-RS30';
  } else if (state.vue === 'carte') {
    const r = currentRentree();
    periodPart = ' — ' + (r === 'CUMUL' ? 'RS26 à RS30 (cumul)' : (r || ''));
  } else {
    periodPart = '';
  }
  document.getElementById('page-title').innerHTML =
    `${mainWord} des effectifs du 1er degré public par ${scaleLabel()}${periodPart}`
    + `<span class="title-unit">${uniteCap}</span>`;
  syncTimelineHeight();
}
// La frise (timeline) doit avoir la même hauteur que le bandeau de titre,
// dont la hauteur varie avec la longueur du texte (deux lignes possibles).
function syncTimelineHeight() {
  const h = document.getElementById('header').getBoundingClientRect().height;
  if (h > 0) document.getElementById('map-toolbar').style.height = h + 'px';
}

function showPane(vue) {
  document.querySelectorAll('.view-pane').forEach(p => p.classList.remove('show'));
  document.getElementById('pane-' + vue).classList.add('show');
  document.getElementById('section-schools').classList.toggle('show', vue === 'carte');
  if (vue === 'carte') setTimeout(() => map.invalidateSize(), 50);
}

/* ══════════════════════ VUE COURBES ══════════════════════ */
const SVG_NS = 'http://www.w3.org/2000/svg';
function el(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
const tooltipEl = document.getElementById('tooltip');
function showTip(html, x, y, light) {
  tooltipEl.innerHTML = html; tooltipEl.style.display = 'block';
  tooltipEl.classList.toggle('tooltip-light', !!light);
  const margin = 8;
  const tw = tooltipEl.offsetWidth, th = tooltipEl.offsetHeight;
  let left = x + 12, top = y + 12;
  if (left + tw > window.innerWidth - margin) left = x - 12 - tw;
  if (top + th > window.innerHeight - margin) top = y - 12 - th;
  left = Math.max(margin, Math.min(left, window.innerWidth - tw - margin));
  top = Math.max(margin, Math.min(top, window.innerHeight - th - margin));
  tooltipEl.style.left = left + 'px'; tooltipEl.style.top = top + 'px';
}
function hideTip() { tooltipEl.style.display = 'none'; }

const LINE_PALETTE = ['#1f77b4','#ff7f0e','#2ca02c','#d62728','#9467bd','#8c564b','#e377c2','#7f7f7f','#bcbd22','#17becf','#393b79','#637939'];
let focusCodes = new Set();

function sortedCodes() {
  const cache = scaleCache[state.echelle];
  return Object.keys(cache.model.EFFECTIFS).sort((a,b) =>
    (cache.model.NOM_BY_CODE[a]||a).localeCompare(cache.model.NOM_BY_CODE[b]||b, 'fr'));
}
function colorByCode(code) {
  const codes = sortedCodes();
  return LINE_PALETTE[Math.max(0, codes.indexOf(code)) % LINE_PALETTE.length];
}
function legendOrder() {
  if (state.type === 'pourcentage') return sortedCodes();
  const cache = scaleCache[state.echelle];
  const years = cache.model.RENTREES_DISPO.filter(r => r !== 'CUMUL');
  const yr = years.length ? years[years.length-1] : null;
  return sortedCodes().sort((a,b) => {
    const va = yr ? getValAt(a,yr) : null, vb = yr ? getValAt(b,yr) : null;
    if (va == null && vb == null) return (cache.model.NOM_BY_CODE[a]||a).localeCompare(cache.model.NOM_BY_CODE[b]||b, 'fr');
    if (va == null) return 1;
    if (vb == null) return -1;
    return vb - va;
  });
}
function firstPrevIdx(years) {
  const prevSet = new Set(scaleCache[state.echelle].model.PREVISION_RS);
  for (let i = 0; i < years.length; i++) if (prevSet.has(years[i])) return i;
  return -1;
}

function renderCurves() {
  const cache = scaleCache[state.echelle];
  const chart = document.getElementById('curves-chart');
  const svg = document.getElementById('curves-svg');
  svg.innerHTML = '';
  const years = cache.model.RENTREES_DISPO.filter(r => r !== 'CUMUL');
  if (years.length === 0) return;
  const W = chart.clientWidth || 800, H = chart.clientHeight || 500;
  const codes = sortedCodes();
  drawCurvesChart(svg, W, H, cache, years, codes, true);
  buildCurvesLegend();
  applyCurvesFocus();
}
// Dessine le graphique dans svgEl aux dimensions W×H fournies (pas
// nécessairement celles de #curves-chart en direct) : réutilisé par l'export
// (cf. serializeCurvesSVG) avec un ratio de référence indépendant de la
// fenêtre du navigateur — le conteneur #curves-chart en direct est presque
// toujours plus proche du carré que du format d'export 1980×1200 une fois
// bandeau titre + légende ajoutés (vérifié : ratio < 1.65 sur tous les
// viewports usuels), ce qui rognerait fortement le bas du graphique si on
// réutilisait tel quel ses dimensions en direct avec une mise à l'échelle
// uniquement par la largeur (cf. wrapExportSVG). withLabels contrôle les
// étiquettes de valeur par point (survol uniquement en direct, jamais utiles
// à l'export, qui les retirait de toute façon après coup).
function drawCurvesChart(svgEl, W, H, cache, years, codes, withLabels) {
  svgEl.innerHTML = '';
  svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const svg = svgEl;
  const mL = 64, mR = 64, mT = 34, mB = 34;
  const plotW = Math.max(10, W - mL - mR), plotH = Math.max(10, H - mT - mB);
  const n = years.length;
  const x = i => mL + (n === 1 ? plotW/2 : i * plotW / (n - 1));

  let lo = Infinity, hi = -Infinity;
  for (const c of codes) for (const r of years) {
    const v = getValAt(c, r);
    if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (state.type !== 'effectifs') { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (lo === hi) { lo -= 1; hi += 1; }
  let mainStep, subStep;
  if (state.type === 'effectifs') { mainStep = 500; subStep = 250; }
  else if (state.type === 'pourcentage') { mainStep = 1; subStep = 0.25; }
  else { mainStep = 50; subStep = 25; }
  lo = Math.floor(lo / mainStep) * mainStep;
  hi = Math.ceil(hi / mainStep) * mainStep;
  if (lo === hi) hi = lo + mainStep;
  const y = v => mT + plotH - (v - lo) / (hi - lo) * plotH;

  const fp = firstPrevIdx(years);
  const idxRS25 = fp >= 1 ? fp - 1 : (fp === 0 ? -1 : years.length - 1);
  let dashFromIdx = null;
  if (fp >= 1) dashFromIdx = fp - 1; else if (fp === 0) dashFromIdx = 0;
  let labelBoundaryX = fp >= 1 ? (x(fp-1) + x(fp)) / 2 : (fp === 0 ? mL : null);

  if (labelBoundaryX != null && labelBoundaryX < mL + plotW) {
    const defs = el('defs', {});
    const pat = el('pattern', { id:'prevStripesCurve', width:8, height:8, patternUnits:'userSpaceOnUse', patternTransform:'rotate(135)' });
    pat.appendChild(el('rect', { width:3, height:8, fill:'#ffaa1e', 'fill-opacity':0.12 }));
    defs.appendChild(pat); svg.appendChild(defs);
    svg.appendChild(el('rect', { x:labelBoundaryX, y:mT, width:(mL+plotW)-labelBoundaryX, height:plotH, fill:'url(#prevStripesCurve)' }));
  }

  const fmtTick = val => state.type === 'pourcentage'
    ? (Math.round(val*100)/100).toLocaleString('fr-FR') + ' %'
    : Math.round(val).toLocaleString('fr-FR');
  const isMainVal = v => Math.abs(v / mainStep - Math.round(v / mainStep)) < 1e-6;
  const nSub = Math.round((hi - lo) / subStep);
  for (let i = 0; i <= nSub; i++) {
    const v = lo + i * subStep;
    if (isMainVal(v)) continue;
    const yy = y(v);
    svg.appendChild(el('line', { class:'c-grid2', x1:mL, y1:yy, x2:mL+plotW, y2:yy }));
    svg.appendChild(el('line', { class:'c-axtick', x1:mL-4, y1:yy, x2:mL, y2:yy }));
    svg.appendChild(el('line', { class:'c-axtick', x1:mL+plotW, y1:yy, x2:mL+plotW+4, y2:yy }));
  }
  const nMain = Math.max(1, Math.round((hi - lo) / mainStep));
  const stride = Math.max(1, Math.ceil(16 / (plotH / nMain)));
  for (let i = 0; i <= nMain; i++) {
    const v = lo + i * mainStep, yy = y(v);
    svg.appendChild(el('line', { class:'c-grid', x1:mL, y1:yy, x2:mL+plotW, y2:yy }));
    svg.appendChild(el('line', { class:'c-axtick', x1:mL-7, y1:yy, x2:mL, y2:yy }));
    svg.appendChild(el('line', { class:'c-axtick', x1:mL+plotW, y1:yy, x2:mL+plotW+7, y2:yy }));
    if (i % stride === 0) {
      const tx = el('text', { class:'c-tick', x:mL-10, y:yy+3, 'text-anchor':'end' }); tx.textContent = fmtTick(v); svg.appendChild(tx);
      const txR = el('text', { class:'c-tick', x:mL+plotW+10, y:yy+3, 'text-anchor':'start' }); txR.textContent = fmtTick(v); svg.appendChild(txR);
    }
  }
  if (state.type !== 'effectifs' && lo < 0 && hi > 0) {
    svg.appendChild(el('line', { class:'c-zero', x1:mL, y1:y(0), x2:mL+plotW, y2:y(0) }));
  }

  svg.appendChild(el('line', { class:'c-axis', x1:mL, y1:mT+plotH, x2:mL+plotW, y2:mT+plotH }));
  svg.appendChild(el('line', { class:'c-axis', x1:mL, y1:mT, x2:mL, y2:mT+plotH }));
  svg.appendChild(el('line', { class:'c-axis', x1:mL+plotW, y1:mT, x2:mL+plotW, y2:mT+plotH }));
  years.forEach((r,i) => {
    const tx = el('text', { class:'c-xtick', x:x(i), y:mT+plotH+18, 'text-anchor':'middle' }); tx.textContent = r; svg.appendChild(tx);
  });

  if (labelBoundaryX != null) {
    const lblC = el('text', { class:'c-zone-lbl', x:(mL+labelBoundaryX)/2, y:mT-10, 'text-anchor':'middle', fill:'#777' }); lblC.textContent = 'Constats'; svg.appendChild(lblC);
    const lblP = el('text', { class:'c-zone-lbl', x:(labelBoundaryX+mL+plotW)/2, y:mT-10, 'text-anchor':'middle', fill:'#c08400' }); lblP.textContent = 'Prévisions'; svg.appendChild(lblP);
  } else {
    const lblC = el('text', { class:'c-zone-lbl', x:mL+plotW/2, y:mT-10, 'text-anchor':'middle', fill:'#777' }); lblC.textContent = 'Constats'; svg.appendChild(lblC);
  }

  const pathD = arr => arr.map((p,i) => (i===0?'M':'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const labelPts = [];
  for (const c of codes) {
    const color = colorByCode(c);
    const pts = [];
    years.forEach((r,i) => { const v = getValAt(c,r); if (v != null) pts.push([x(i), y(v), r, v, i]); });
    if (pts.length === 0) continue;
    const addPath = (arr, dashed) => {
      if (arr.length < 2) return;
      const attrs = { class:'c-line', d:pathD(arr), stroke:color, 'data-code':c };
      if (dashed) attrs['stroke-dasharray'] = '5 4';
      const path = el('path', attrs);
      path.addEventListener('mouseenter', () => highlightCurve(c));
      path.addEventListener('mouseleave', () => highlightCurve(null));
      svg.appendChild(path);
    };
    if (dashFromIdx == null) addPath(pts, false);
    else { addPath(pts.filter(p => p[4] <= dashFromIdx), false); addPath(pts.filter(p => p[4] >= dashFromIdx), true); }
    for (const p of pts) {
      const isConstat = p[4] <= idxRS25;
      let mark, r;
      if (isConstat) { const s=8; r = s/2; mark = el('rect', { class:'c-dot', x:p[0]-s/2, y:p[1]-s/2, width:s, height:s, fill:color, 'data-code':c }); }
      else { r = 2.6; mark = el('circle', { class:'c-dot', cx:p[0], cy:p[1], r:r, fill:color, 'data-code':c }); }
      mark.addEventListener('mousemove', ev => showTip(`<strong>${escXml(cache.model.NOM_BY_CODE[c]||c)}</strong><br>${p[2]} : ${formatVal(p[3])}`, ev.clientX, ev.clientY));
      mark.addEventListener('mouseleave', hideTip);
      svg.appendChild(mark);
      labelPts.push({ x:p[0], y:p[1], r, val:p[3], color, code:c });
    }
  }
  if (withLabels) renderCurveValueLabels(svg, labelPts, W, H);
}
// Étiquettes de valeur par point : fond semi-transparent coloré selon la
// courbe, centrées au-dessus du point par défaut ; si ça chevauche un autre
// point ou une étiquette déjà placée, on essaie d'autres positions autour
// (dessous, diagonales, côtés) avant de se rabattre sur la 1re en dernier recours.
function renderCurveValueLabels(svg, pts, W, H) {
  const placed = pts.map(p => ({ l: p.x - p.r - 1, r: p.x + p.r + 1, t: p.y - p.r - 1, b: p.y + p.r + 1 }));
  const overlaps = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const gap = 4, padX = 4, padY = 2;
  pts.forEach((p, idx) => {
    const txt = el('text', { class:'c-label-text', 'text-anchor':'middle', 'dominant-baseline':'central', x:0, y:0 });
    txt.textContent = formatCellVal(p.val);
    svg.appendChild(txt);
    let bbox;
    try { bbox = txt.getBBox(); } catch (e) { bbox = null; }
    const boxW = (bbox ? bbox.width : String(txt.textContent).length * 6.5) + padX * 2;
    const boxH = (bbox ? bbox.height : 11) + padY * 2;
    const off = p.r + gap;
    const diagY = off * 0.55 + boxH * 0.3, diagX = boxW / 2 + 3;
    const candidates = [
      { cx: p.x, cy: p.y - off - boxH / 2 },
      { cx: p.x, cy: p.y + off + boxH / 2 },
      { cx: p.x + diagX, cy: p.y - diagY - boxH / 2 },
      { cx: p.x - diagX, cy: p.y - diagY - boxH / 2 },
      { cx: p.x + diagX, cy: p.y + diagY + boxH / 2 },
      { cx: p.x - diagX, cy: p.y + diagY + boxH / 2 },
      { cx: p.x + off + boxW / 2, cy: p.y },
      { cx: p.x - off - boxW / 2, cy: p.y },
    ];
    let chosen = null;
    for (const c of candidates) {
      const rect = { l: c.cx - boxW / 2, r: c.cx + boxW / 2, t: c.cy - boxH / 2, b: c.cy + boxH / 2 };
      if (rect.l < 2 || rect.r > W - 2 || rect.t < 2 || rect.b > H - 2) continue;
      if (placed.some(ex => overlaps(rect, ex))) continue;
      chosen = { cx: c.cx, cy: c.cy, rect };
      break;
    }
    if (!chosen) {
      const c = candidates[0];
      const l = Math.max(2, Math.min(c.cx - boxW / 2, W - 2 - boxW));
      const t = Math.max(2, Math.min(c.cy - boxH / 2, H - 2 - boxH));
      chosen = { cx: l + boxW / 2, cy: t + boxH / 2, rect: { l, r: l + boxW, t, b: t + boxH } };
    }
    placed.push(chosen.rect);
    const bg = el('rect', {
      class: 'c-label-bg', 'data-code': p.code,
      x: chosen.rect.l.toFixed(1), y: chosen.rect.t.toFixed(1),
      width: boxW.toFixed(1), height: boxH.toFixed(1), rx: 3,
      fill: p.color, 'fill-opacity': 0.78,
    });
    svg.insertBefore(bg, txt);
    txt.setAttribute('x', chosen.cx.toFixed(1));
    txt.setAttribute('y', chosen.cy.toFixed(1));
    txt.setAttribute('data-code', p.code);
  });
}
function applyCurvesFocus() {
  const foc = focusCodes.size > 0;
  document.querySelectorAll('.c-line').forEach(p => { p.classList.remove('hi'); p.classList.toggle('dim', foc && !focusCodes.has(p.getAttribute('data-code'))); });
  document.querySelectorAll('.c-dot').forEach(p => p.classList.toggle('dim', foc && !focusCodes.has(p.getAttribute('data-code'))));
  // Les étiquettes de valeur ne s'affichent que sur survol (cf. highlightCurve) :
  // en dehors d'un survol, elles restent toutes masquées, y compris en focus.
  document.querySelectorAll('.c-label-bg, .c-label-text').forEach(p => p.classList.remove('hi'));
}
function highlightCurve(code) {
  if (!code) { applyCurvesFocus(); return; }
  document.querySelectorAll('.c-line').forEach(p => { const on = p.getAttribute('data-code') === code; p.classList.toggle('hi', on); p.classList.toggle('dim', !on); });
  document.querySelectorAll('.c-dot').forEach(p => p.classList.toggle('dim', p.getAttribute('data-code') !== code));
  document.querySelectorAll('.c-label-bg, .c-label-text').forEach(p => p.classList.toggle('hi', p.getAttribute('data-code') === code));
}
function buildCurvesLegend() {
  const cache = scaleCache[state.echelle];
  const lg = document.getElementById('curves-legend');
  lg.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'lg-title';
  title.textContent = 'Évolution par ' + (state.echelle === 'epci' ? 'EPCI' : 'circonscription');
  lg.appendChild(title);
  const foc = focusCodes.size > 0;
  const allRow = document.createElement('div');
  allRow.className = 'lg-row lg-all' + (!foc ? ' disabled' : '');
  allRow.innerHTML = `<span class="lg-allicon">▣</span><span class="lg-name">Tout afficher</span>`;
  allRow.addEventListener('click', () => { if (focusCodes.size === 0) return; focusCodes.clear(); buildCurvesLegend(); applyCurvesFocus(); });
  lg.appendChild(allRow);
  for (const c of legendOrder()) {
    const isFoc = focusCodes.has(c);
    const row = document.createElement('div');
    row.className = 'lg-row' + (foc && !isFoc ? ' off' : '') + (isFoc ? ' active' : '');
    row.innerHTML = `<span class="lg-swatch" data-swatch-bg="${colorByCode(c)}"></span><span class="lg-name">${escXml(cache.model.NOM_BY_CODE[c]||c)}</span>`;
    applySwatchColors(row);
    row.addEventListener('click', () => { if (focusCodes.has(c)) focusCodes.delete(c); else focusCodes.add(c); buildCurvesLegend(); applyCurvesFocus(); });
    row.addEventListener('mouseenter', () => highlightCurve(c));
    row.addEventListener('mouseleave', () => highlightCurve(null));
    lg.appendChild(row);
  }
}

/* ══════════════════════ VUE TABLEAU (heatmap) ══════════════════════ */
let sortKey = 'NAME', sortDir = 'asc';
function textColor(bg) {
  if (!bg || bg.length < 7) return '#222';
  const r = parseInt(bg.substr(1,2),16), g = parseInt(bg.substr(3,2),16), b = parseInt(bg.substr(5,2),16);
  const lum = (0.2126*r + 0.7152*g + 0.0722*b) / 255;
  return lum < 0.55 ? '#fff' : '#1a1a1a';
}
function sortValue(code) {
  const cache = scaleCache[state.echelle];
  if (sortKey === 'NAME') return null;
  if (sortKey === 'CUMUL') return state.type === 'pourcentage' ? (cache.model.CUMUL_PCT[code] ?? null) : (cache.model.CUMUL[code] ?? null);
  return getValAt(code, sortKey);
}
function sortedCodesBy() {
  const cache = scaleCache[state.echelle];
  const codes = Object.keys(cache.model.EFFECTIFS);
  if (sortKey === 'NAME') {
    codes.sort((a,b) => (cache.model.NOM_BY_CODE[a]||a).localeCompare(cache.model.NOM_BY_CODE[b]||b, 'fr'));
    if (sortDir === 'desc') codes.reverse();
    return codes;
  }
  const dir = sortDir === 'asc' ? 1 : -1;
  codes.sort((a,b) => {
    const va = sortValue(a), vb = sortValue(b);
    if (va == null && vb == null) return (cache.model.NOM_BY_CODE[a]||a).localeCompare(cache.model.NOM_BY_CODE[b]||b, 'fr');
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va - vb) * dir;
  });
  return codes;
}
function sumEff(r) {
  const cache = scaleCache[state.echelle];
  let s = null;
  for (const code of Object.keys(cache.model.EFFECTIFS)) { const v = cache.model.EFFECTIFS[code]?.[r]; if (v != null) s = (s ?? 0) + v; }
  return s;
}
function totalForYear(r) {
  if (state.type === 'effectifs') return sumEff(r);
  const idx = RENTREES_ALL.indexOf(r);
  const prev = idx > 0 ? RENTREES_ALL[idx-1] : null;
  const a = sumEff(r), b = prev ? sumEff(prev) : null;
  if (a == null || b == null) return null;
  if (state.type === 'pourcentage') return b !== 0 ? (a-b)/b*100 : null;
  return a - b;
}
function totalCumul() {
  const range = scaleCache[state.echelle].model.PREVISION_RS;
  if (!range || range.length < 1) return null;
  const lastRS = range[range.length-1];
  const idxFirst = RENTREES_ALL.indexOf(range[0]);
  const prevRS = idxFirst > 0 ? RENTREES_ALL[idxFirst-1] : null;
  const a = sumEff(lastRS), b = prevRS ? sumEff(prevRS) : null;
  if (a == null || b == null) return null;
  if (state.type === 'pourcentage') return b !== 0 ? (a-b)/b*100 : null;
  return a - b;
}
function setSort(key) {
  if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  else { sortKey = key; sortDir = key === 'NAME' ? 'asc' : 'desc'; }
  renderHeatmap();
}
function makeHeader(labelHTML, key, extraClass) {
  const h = document.createElement('div');
  const active = sortKey === key;
  h.className = 'h-cell h-yhead sortable' + (extraClass ? ' ' + extraClass : '') + (active ? ' sort-active' : '');
  const tri = active ? (sortDir === 'asc' ? '▲' : '▼') : '▽';
  h.innerHTML = `<span>${labelHTML}</span><span class="sort-tri">${tri}</span>`;
  h.title = 'Trier';
  h.addEventListener('click', () => setSort(key));
  return h;
}
function bindHeatRowHover() {
  const grid = document.getElementById('heat-grid');
  if (!grid || grid.dataset.hoverBound) return;
  grid.dataset.hoverBound = '1';
  let lastRow = null;
  const apply = r => grid.querySelectorAll('[data-row]').forEach(cell => cell.classList.toggle('row-dim', r != null && cell.dataset.row !== r));
  grid.addEventListener('mousemove', e => {
    const cell = e.target.closest('[data-row]');
    const r = cell ? cell.dataset.row : null;
    if (r === lastRow) return;
    lastRow = r; apply(r);
  });
  grid.addEventListener('mouseleave', () => { lastRow = null; apply(null); });
}
function renderHeatmap() {
  const cache = scaleCache[state.echelle];
  const grid = document.getElementById('heat-grid');
  grid.innerHTML = '';
  bindHeatRowHover();
  const years = cache.model.RENTREES_DISPO.filter(r => r !== 'CUMUL');
  if (years.length === 0) return;
  const showCumul = state.type !== 'effectifs';
  const fp = firstPrevIdx(years);
  grid.style.gridTemplateColumns = `minmax(11rem,auto) repeat(${years.length}, minmax(3.4rem,1fr))` + (showCumul ? ' minmax(4.6rem,1fr)' : '');
  const isPrev = i => fp >= 0 && i >= fp;
  const frag = document.createDocumentFragment();

  const corner = document.createElement('div'); corner.className = 'h-cell h-corner'; frag.appendChild(corner);
  const nConstat = fp < 0 ? years.length : fp;
  const nPrevYears = fp < 0 ? 0 : years.length - fp;
  if (nConstat > 0) { const zc = document.createElement('div'); zc.className = 'h-cell h-zone constat'; zc.style.gridColumn = `span ${nConstat}`; zc.textContent = 'Constats'; frag.appendChild(zc); }
  if (nPrevYears > 0) { const zp = document.createElement('div'); zp.className = 'h-cell h-zone previsions'; zp.style.gridColumn = `span ${nPrevYears}`; zp.textContent = 'Prévisions'; frag.appendChild(zp); }
  if (showCumul) { const zCum = document.createElement('div'); zCum.className = 'h-cell h-corner'; frag.appendChild(zCum); }

  const hName = makeHeader(state.echelle === 'epci' ? 'EPCI' : 'Circonscription', 'NAME', 'h-name');
  hName.style.borderBottom = '2px solid #2d2d2d';
  frag.appendChild(hName);
  years.forEach((r,i) => frag.appendChild(makeHeader(r, r, isPrev(i) ? 'prev' : '')));
  if (showCumul) frag.appendChild(makeHeader('Cumul<br>RS26-RS30', 'CUMUL', 'h-cumul'));

  for (const code of sortedCodesBy()) {
    const nameCell = document.createElement('div'); nameCell.className = 'h-cell h-name'; nameCell.dataset.row = code;
    nameCell.textContent = cache.model.NOM_BY_CODE[code] || code; frag.appendChild(nameCell);
    years.forEach((r,i) => {
      const v = getValAt(code, r);
      const cell = document.createElement('div');
      cell.className = 'h-cell h-val' + (isPrev(i) ? ' prev' : '');
      cell.dataset.row = code;
      if (v == null) { cell.classList.add('h-empty'); cell.textContent = '·'; }
      else {
        const bg = getColor(v, state.type === 'effectifs' ? 'effectifsHeat' : state.type);
        cell.style.background = bg; cell.style.color = textColor(bg);
        cell.textContent = formatCellVal(v);
        cell.title = `${cache.model.NOM_BY_CODE[code]||code} — ${r} : ${formatVal(v)}`;
      }
      frag.appendChild(cell);
    });
    if (showCumul) {
      const v = state.type === 'pourcentage' ? (cache.model.CUMUL_PCT[code] ?? null) : (cache.model.CUMUL[code] ?? null);
      const cell = document.createElement('div'); cell.className = 'h-cell h-cumul'; cell.dataset.row = code;
      if (v == null) { cell.classList.add('h-empty'); cell.textContent = '·'; }
      else { cell.textContent = formatCellVal(v); cell.title = `${cache.model.NOM_BY_CODE[code]||code} — Cumul RS26-RS30 : ${formatVal(v)}`; }
      frag.appendChild(cell);
    }
  }
  const tName = document.createElement('div'); tName.className = 'h-cell h-name h-total'; tName.dataset.row = '__TOTAL__'; tName.textContent = 'TOTAL'; frag.appendChild(tName);
  years.forEach(r => {
    const v = totalForYear(r);
    const cell = document.createElement('div'); cell.className = 'h-cell h-total'; cell.dataset.row = '__TOTAL__';
    cell.textContent = v == null ? '·' : formatTotalVal(v);
    if (v != null) cell.title = `TOTAL — ${r} : ${formatVal(v)}`;
    frag.appendChild(cell);
  });
  if (showCumul) {
    const v = totalCumul();
    const cell = document.createElement('div'); cell.className = 'h-cell h-total h-cumul'; cell.dataset.row = '__TOTAL__';
    cell.textContent = v == null ? '·' : formatTotalVal(v);
    if (v != null) cell.title = `TOTAL — Cumul RS26-RS30 : ${formatVal(v)}`;
    frag.appendChild(cell);
  }
  grid.appendChild(frag);
}

/* ══════════════════════ EXPORT (SVG / PNG / XLSX) ══════════════════════ */
function exportName(ext) {
  const d = new Date().toISOString().slice(0,10);
  return `${state.echelle}_${state.vue}_${state.type}_${d}.${ext}`;
}
function triggerDownload(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}
function escXml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// Couleurs de légende issues d'une palette calculée à l'affichage (Jenks,
// dégradé relatif...) : appliquées après coup via la CSSOM (élément.style.*)
// plutôt qu'un attribut style="" inline dans le HTML, pour rester compatible
// avec une CSP stricte (style-src sans 'unsafe-inline').
function applySwatchColors(container) {
  container.querySelectorAll('[data-swatch-bg]').forEach(el => { el.style.background = el.dataset.swatchBg; });
}
function currentTitleText() {
  return document.getElementById('page-title').textContent.replace(/\s+/g,' ').trim();
}
// Sépare le titre principal de sa mention d'unité complémentaire (span
// .title-unit, ex. "En pourcentage de variation") : à l'export, cette
// mention est précédée d'un tiret et rendue en texte normal (non gras),
// contrairement au reste du titre — cf. exportTitleBanner.
function currentTitleParts() {
  const titleEl = document.getElementById('page-title');
  const unitEl = titleEl.querySelector('.title-unit');
  const unit = unitEl ? unitEl.textContent.replace(/\s+/g,' ').trim() : '';
  const clone = titleEl.cloneNode(true);
  const unitInClone = clone.querySelector('.title-unit');
  if (unitInClone) unitInClone.remove();
  const main = clone.textContent.replace(/\s+/g,' ').trim();
  return { main, unit };
}
// Toutes les images exportées (PNG/SVG, les 4 vues) sortent au format fixe
// 1980×1200px/96dpi. Le contenu (bandeau titre + contenu principal +
// légende) est toujours mis à l'échelle par la largeur (jamais par
// contenance) puis ancré en haut à gauche : le titre et le contenu occupent
// ainsi toujours 100% de la largeur du cadre, sans marge horizontale.
// Chaque vue dimensionne son propre contenu (cw/ch) pour que la hauteur mise
// à l'échelle tienne dans EXPORT_H (voir buildMapExportSVG, dont le canevas
// carte est calé sur l'espace disponible sous le bandeau plutôt que sur le
// ratio propre du territoire) ; un éventuel dépassement serait simplement
// rogné par le viewBox fixe plutôt que de réintroduire une marge.
const EXPORT_W = 1980, EXPORT_H = 1200;
function wrapExportSVG(inner, cw, ch) {
  // Toujours mis à l'échelle par la largeur (jamais par un min(largeur,
  // hauteur) qui laisserait une marge à droite dès que le contenu est
  // proportionnellement plus étroit que 1980:1200) : le titre et le contenu
  // doivent occuper 100% de la largeur du cadre d'export sur les 4 vues,
  // sans exception. Si le contenu s'avère plus haut que EXPORT_H une fois mis
  // à l'échelle, l'excédent est simplement rogné par le viewBox fixe plutôt
  // que de réintroduire une marge horizontale.
  const scale = EXPORT_W / cw;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${EXPORT_W}" height="${EXPORT_H}" viewBox="0 0 ${EXPORT_W} ${EXPORT_H}">`
    + `<rect width="${EXPORT_W}" height="${EXPORT_H}" fill="#ffffff"/>`
    + `<g transform="scale(${scale.toFixed(6)})">${inner}</g>`
    + `</svg>`;
  return { svg, width: EXPORT_W, height: EXPORT_H };
}
function wrapTitleLines(titleTxt, maxChars) {
  const words = String(titleTxt).split(/\s+/);
  const lines = []; let cur = '';
  for (const w of words) { const test = cur ? cur + ' ' + w : w; if (!cur || test.length <= maxChars) cur = test; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  return lines;
}
// Bandeau titre partagé par les 4 exports (école / courbes / tableau /
// carte) : rendu final IDENTIQUE quelle que soit la vue (calibré sur
// l'export Tableau). Chaque export a sa propre largeur de contenu "totalW"
// (420 pour le graphique école, ~700-900 pour courbes/tableau, ~2000 pour
// la carte) avant d'être mis à l'échelle vers EXPORT_W=1980px de large (cf.
// wrapExportSVG) : une même taille de police en unités de contenu ne rend
// donc PAS à la même taille finale sur les 4 exports (22px de police
// rendrait ≈104px de haut une fois l'école agrandie à 1980px de large,
// contre ≈22px pour la carte). Toutes les dimensions du bandeau (police,
// marges, contour) sont donc dérivées de totalW plutôt qu'en valeurs
// absolues, pour un rendu final identique sur les 4 vues.
const TITLE_FONT_TARGET_PX = 26, TITLE_PAD_X_TARGET_PX = 16, TITLE_PAD_Y_TARGET_PX = 11,
      TITLE_STROKE_TARGET_PX = 2, TITLE_GAP_TARGET_PX = 14;
// mainTxt/unitTxt : texte brut (non échappé, escXml appliqué ici). unitTxt
// est la mention d'unité complémentaire (ex. "En pourcentage de variation",
// cf. currentTitleParts) : précédée d'un tiret et rendue en texte normal
// (non gras), à la différence du reste du titre — reprend telle quelle
// depuis un simple appel avec unitTxt='' pour un titre entièrement gras
// (graphique école, qui n'a pas cette mention).
const TITLE_MARK = '\u0001';
function exportTitleBanner(mainTxt, unitTxt, totalW) {
  const scale = totalW / EXPORT_W;
  const fontSize = TITLE_FONT_TARGET_PX * scale, padX = TITLE_PAD_X_TARGET_PX * scale,
        padY = TITLE_PAD_Y_TARGET_PX * scale, strokeW = TITLE_STROKE_TARGET_PX * scale;
  const maxChars = Math.max(6, Math.floor((totalW - padX * 2) / (fontSize * 0.56)));
  const combined = unitTxt ? mainTxt + TITLE_MARK + ' - ' + unitTxt : mainTxt;
  const lines = wrapTitleLines(combined, maxChars);
  const lineH = fontSize * 1.3;
  const height = padY * 2 + lines.length * lineH;
  let svg = `<rect x="${(strokeW/2).toFixed(2)}" y="${(strokeW/2).toFixed(2)}" width="${(totalW-strokeW).toFixed(1)}" height="${(height-strokeW).toFixed(1)}" fill="#ffffff" stroke="#000000" stroke-width="${strokeW.toFixed(2)}"/>`;
  lines.forEach((ln, i) => {
    const ty = padY + fontSize * 0.85 + i * lineH;
    const markIdx = ln.indexOf(TITLE_MARK);
    const textStyle = `font-family:Arial,Helvetica,sans-serif;font-size:${fontSize.toFixed(2)}px;fill:#161616`;
    if (markIdx === -1) {
      svg += `<text x="${padX.toFixed(1)}" y="${ty.toFixed(1)}" style="${textStyle};font-weight:bold">${escXml(ln)}</text>`;
    } else {
      const boldPart = ln.slice(0, markIdx), normalPart = ln.slice(markIdx + TITLE_MARK.length);
      svg += `<text x="${padX.toFixed(1)}" y="${ty.toFixed(1)}" style="${textStyle}">`
        + (boldPart ? `<tspan style="font-weight:bold">${escXml(boldPart)}</tspan>` : '')
        + `<tspan style="font-weight:400">${escXml(normalPart)}</tspan></text>`;
    }
  });
  return { svg, height, gap: TITLE_GAP_TARGET_PX * scale };
}
const CURVE_EXPORT_CSS = `text{font-family:'Public Sans',Arial,sans-serif}
.c-grid{stroke:#c6c6c6;stroke-width:1}.c-grid2{stroke:#e3e3e3;stroke-width:1}
.c-axis{stroke:#888;stroke-width:1}.c-axtick{stroke:#888;stroke-width:1}
.c-zero{stroke:#b0b0b0;stroke-width:1.4;stroke-dasharray:2 3}
.c-tick{font-size:15px;fill:#555}.c-xtick{font-size:16px;fill:#333;font-weight:700}
.c-zone-lbl{font-size:14px;font-weight:700;letter-spacing:0.08em}
.c-line{fill:none;stroke-width:2.6;opacity:0.95}.c-line.dim{opacity:0.12}.c-dot.dim{opacity:0.12}
.c-label-text{font-size:11px;font-weight:700;fill:#fff}`;
// Format de référence du graphique à l'export : indépendant de la taille
// réelle de #curves-chart en direct (cf. drawCurvesChart), choisi
// suffisamment large par rapport à sa hauteur pour que le total (bandeau +
// graphique + légende) reste toujours contraint par la largeur dans
// wrapExportSVG plutôt que par la hauteur, quel que soit le nombre de lignes
// de légende — sans quoi le rendu en direct (souvent proche du carré une
// fois la fenêtre du navigateur prise en compte) rognerait fortement le bas
// du graphique une fois mis à l'échelle par la largeur.
const CURVE_EXPORT_W = 1600;
// Légende en ligne(s) sous le graphique (comme l'export école) plutôt qu'un
// panneau latéral de largeur fixe : minimise son emprise et laisse le chart
// utiliser toute la largeur disponible.
function serializeCurvesSVG() {
  const cache = scaleCache[state.echelle];
  const years = cache.model.RENTREES_DISPO.filter(r => r !== 'CUMUL');
  const W = CURVE_EXPORT_W;
  const titleParts = currentTitleParts();
  const codes = legendOrder();
  const foc = focusCodes.size > 0;

  const rowGap = 18, itemGap = 26, swatchW = 22, swatchGap = 8, lineH = 22, itemCharW = 7.6;
  const rows = [];
  let row = [], rowW = 0;
  for (const c of codes) {
    const label = cache.model.NOM_BY_CODE[c] || c;
    const itemW = swatchW + swatchGap + String(label).length * itemCharW;
    const addGap = row.length ? itemGap : 0;
    if (row.length && rowW + addGap + itemW > W) { rows.push({ items: row, w: rowW }); row = []; rowW = 0; }
    row.push({ label, color: colorByCode(c), dim: foc && !focusCodes.has(c), w: itemW });
    rowW += (row.length > 1 ? itemGap : 0) + itemW;
  }
  if (row.length) rows.push({ items: row, w: rowW });
  const legendH = rows.length ? (rowGap + rows.length * lineH + 6) : 0;

  const totalW = W;
  const banner = exportTitleBanner(titleParts.main, titleParts.unit, totalW);
  const contentY = banner.height + banner.gap;
  // Le graphique est redessiné à une hauteur H calculée pour que le total
  // (bandeau + graphique + légende) remplisse exactement EXPORT_H une fois
  // mis à l'échelle par la largeur (cf. wrapExportSVG) : le contenu occupe
  // ainsi 100% de la hauteur disponible sous le bandeau, comme de la largeur,
  // plutôt que de laisser une marge blanche en bas (cf. CURVE_EXPORT_W,
  // choisi assez large pour garantir que H reste positif et confortable même
  // avec plusieurs lignes de légende).
  const totalHTarget = EXPORT_H * (totalW / EXPORT_W);
  const H = totalHTarget - contentY - legendH;
  const tmp = document.createElementNS(SVG_NS, 'svg');
  drawCurvesChart(tmp, W, H, cache, years, sortedCodes(), false);
  const srcInnerHTML = tmp.innerHTML;

  let leg = '', ly = H + rowGap;
  for (const r of rows) {
    let lx = (W - r.w) / 2;
    for (const it of r.items) {
      const op = it.dim ? ' opacity="0.4"' : '';
      leg += `<g${op}><rect x="${lx.toFixed(1)}" y="${(ly-14).toFixed(1)}" width="20" height="4.5" rx="2" fill="${it.color}"/>`
        + `<text x="${(lx+swatchW+swatchGap-2).toFixed(1)}" y="${ly.toFixed(1)}" style="font-family:Arial,Helvetica,sans-serif;font-size:15px;fill:#333">${escXml(it.label)}</text></g>`;
      lx += it.w + itemGap;
    }
    ly += lineH;
  }

  const totalH = contentY + H + legendH;
  const inner = `<style>${CURVE_EXPORT_CSS}</style>`
    + `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#ffffff"/>`
    + banner.svg
    + `<g transform="translate(0,${contentY.toFixed(1)})">` + srcInnerHTML + leg + `</g>`;
  return wrapExportSVG(inner, totalW, totalH);
}
// Polices plus petites que celles du chart en direct (le même viewBox
// 420×190 est réutilisé, mais l'export l'agrandit ensuite jusqu'au format
// fixe 1980×1200 — sans ce correctif les textes tuné pour un petit aperçu à
// l'écran paraissent disproportionnés une fois le chart affiché en grand).
// Le graphique école (420×190) est bien plus étroit que les autres vues
// (courbes/tableau font plusieurs centaines d'unités de plus) : à largeur de
// sortie fixe (1980px), il subit un facteur d'agrandissement bien plus fort
// (1980/420 ≈ 4.7× contre ~2.5× pour un contenu deux fois plus large) — des
// polices proportionnées à son propre petit aperçu paraissent donc bien plus
// grosses que celles des autres exports une fois toutes ramenées à la même
// largeur finale. D'où des tailles nettement plus petites ici qu'ailleurs.
const SCHOOL_CHART_EXPORT_CSS = `text{font-family:'Public Sans',Arial,sans-serif}
.sc-grid{stroke:#e6e6e6;stroke-width:0.6}.sc-axis{stroke:#999;stroke-width:0.6}
.sc-ref{stroke:#aaa;stroke-width:0.6;stroke-dasharray:2 2}
.sc-tick{font-size:8px;fill:#777}.sc-tick-100{font-weight:700;fill:#333}.sc-tick2{font-size:7px;fill:#b8860b}
.sc-xtick{font-size:7px;fill:#555}
.sc-ytitle{font-size:7px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;fill:#777}
.sc-zone-lbl{font-size:7px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase}
.sc-line{fill:none;stroke-width:1.4}.sc-trend{fill:none;stroke-width:1.1;stroke-dasharray:3 2}
.sc-bar{fill:#E8B93B;fill-opacity:0.28}.sc-dot{r:1.8}`;
// Export du graphique de comparaison base 100 (volet école) : redessine le
// chart dans un <svg> détaché (même viewBox fixe que l'affichage), puis
// reconstitue une légende en SVG (le HTML de #info-school-chart-legend
// n'est pas exportable tel quel). Légende enroulée en ligne(s) dans la
// largeur du chart (W) plutôt que d'agrandir le canevas total : les
// dimensions d'export suivent désormais exactement le contenu (cf.
// wrapExportSVG), donc élargir totalW au-delà du nécessaire n'a plus l'effet
// pervers d'avant (rétrécir le chart par lettrboxing) mais reste inutile.
function serializeSchoolCompareSVG() {
  if (!schoolCompareData || schoolCompareData.error) return null;
  const data = schoolCompareData;
  const tmp = document.createElementNS(SVG_NS, 'svg');
  drawSchoolCompareChart(tmp, data);
  const vb = (tmp.getAttribute('viewBox') || '0 0 420 190').split(/\s+/).map(Number);
  const W = vb[2], H = vb[3];
  const titleTxt = schoolCompareTitle || 'Comparaison base 100';
  const baseLabel = data.years[data.baseIdx];
  const items = [
    { label: 'École', color: '#1563C2', swatch: 'line' },
    { label: data.areaLabel, color: '#E07A1F', swatch: 'line' },
    { label: `Base 100 = ${baseLabel}`, color: '#999', swatch: 'dash' },
    { label: 'Part école (%)', color: '#E8B93B', swatch: 'box' },
    { label: 'Tendance EPCI', color: '#9A9A9A', swatch: 'dash' },
    { label: 'Tendance école', color: '#4DA6E8', swatch: 'dash' },
    { label: 'Delta projections', color: 'rgba(100,150,230,0.5)', swatch: 'box' },
  ];

  // Légende : enroulée en ligne(s) dans la largeur du chart. Taille réduite
  // par rapport aux autres légendes d'export (swatchW/police plus petits) :
  // le graphique école reste étroit (420 unités) même une fois élargi au
  // format d'export, une légende à l'échelle des autres vues y paraît
  // disproportionnée.
  const rowGap = 10, itemGap = 12, swatchW = 11, swatchGap = 4, lineH = 12, itemCharW = 4.2;
  const rows = [];
  let row = [], rowW = 0;
  for (const it of items) {
    const itemW = swatchW + swatchGap + it.label.length * itemCharW;
    const addGap = row.length ? itemGap : 0;
    if (row.length && rowW + addGap + itemW > W) { rows.push({ items: row, w: rowW }); row = []; rowW = 0; }
    row.push({ ...it, w: itemW });
    rowW += (row.length > 1 ? itemGap : 0) + itemW;
  }
  if (row.length) rows.push({ items: row, w: rowW });

  let leg = '', ly = H + rowGap;
  for (const r of rows) {
    let lx = (W - r.w) / 2;
    for (const it of r.items) {
      if (it.swatch === 'line') leg += `<rect x="${lx.toFixed(1)}" y="${(ly-3).toFixed(1)}" width="${swatchW}" height="1.8" rx="0.9" fill="${it.color}"/>`;
      else if (it.swatch === 'dash') leg += `<line x1="${lx.toFixed(1)}" y1="${(ly-2.2).toFixed(1)}" x2="${(lx+swatchW).toFixed(1)}" y2="${(ly-2.2).toFixed(1)}" stroke="${it.color}" stroke-width="1.2" stroke-dasharray="2.5 1.5"/>`;
      else leg += `<rect x="${lx.toFixed(1)}" y="${(ly-6).toFixed(1)}" width="9" height="6.5" fill="${it.color}"/>`;
      leg += `<text x="${(lx+swatchW+swatchGap).toFixed(1)}" y="${ly.toFixed(1)}" style="font-family:Arial,Helvetica,sans-serif;font-size:8px;fill:#333">${escXml(it.label)}</text>`;
      lx += it.w + itemGap;
    }
    ly += lineH;
  }
  const legendH = rows.length ? (ly - H + 6) : 0;

  const totalW = W;
  const banner = exportTitleBanner(titleTxt, '', totalW);
  const contentY = banner.height + banner.gap;
  const totalH = contentY + H + legendH;
  const inner = `<style>${SCHOOL_CHART_EXPORT_CSS}</style>`
    + `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#ffffff"/>`
    + banner.svg
    + `<g transform="translate(0,${contentY.toFixed(1)})">` + tmp.innerHTML + leg + `</g>`;
  return wrapExportSVG(inner, totalW, totalH);
}
async function exportSchoolCompareChart(format) {
  try {
    const result = serializeSchoolCompareSVG();
    if (!result) { alert("Aucun graphique à exporter."); return; }
    const filename = `comparaison_base100_${new Date().toISOString().slice(0,10)}.${format}`;
    if (format === 'svg') {
      triggerDownload(filename, new Blob([result.svg], { type: 'image/svg+xml' }));
    } else {
      const blob = await svgToPngBlob(result.svg, result.width, result.height);
      triggerDownload(filename, blob);
    }
  } catch (err) {
    alert('Export échoué : ' + err.message);
    console.error('[dataviz] Erreur export graphique école :', err);
  }
}
function heatmapToSVG() {
  const grid = document.getElementById('heat-grid');
  const cells = [...grid.children];
  const gb = grid.getBoundingClientRect();
  const W = Math.ceil(grid.scrollWidth), H = Math.ceil(grid.scrollHeight);
  const parts = [
    `<defs><pattern id="expPrev" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">`
      + `<rect width="3" height="9" fill="#ffaa1e" fill-opacity="0.18"/></pattern></defs>`,
  ];
  for (const cell of cells) {
    const r = cell.getBoundingClientRect();
    const cx = r.left - gb.left + grid.scrollLeft, cy = r.top - gb.top + grid.scrollTop;
    const w = r.width, h = r.height;
    const cs = getComputedStyle(cell);
    const bg = cs.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      parts.push(`<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${bg}"/>`);
    }
    if (cell.classList.contains('previsions') || cell.classList.contains('prev')) {
      parts.push(`<rect x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="url(#expPrev)"/>`);
    }
    // Le triangle de tri (▲▼▽) des entêtes de colonnes (cf. makeHeader) est
    // un indicateur d'interaction propre à l'affichage web, sans sens dans
    // une image exportée : exclu du texte des cellules.
    const sortTri = cell.querySelector('.sort-tri');
    const rawText = cell.innerText || cell.textContent || '';
    const cellText = sortTri ? rawText.replace(sortTri.textContent, '') : rawText;
    const lines = cellText.split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length) {
      const color = cs.color || '#222', fw = cs.fontWeight || '400';
      const fs = parseFloat(cs.fontSize) || 13;
      const anchor = cs.textAlign === 'left' || cs.justifyContent === 'flex-start' ? 'start' : 'middle';
      const tx = anchor === 'start' ? cx + 6 : cx + w/2;
      const lineH = fs * 1.15;
      let ty = cy + h/2 - (lines.length*lineH)/2 + fs*0.85;
      for (const ln of lines) {
        parts.push(`<text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}" style="font-family:Arial,Helvetica,sans-serif;font-size:${fs.toFixed(1)}px;font-weight:${fw};fill:${color}">${escXml(ln)}</text>`);
        ty += lineH;
      }
    }
  }
  const titleParts = currentTitleParts();
  const totalW = W;
  const banner = exportTitleBanner(titleParts.main, titleParts.unit, totalW);
  const contentY = banner.height + banner.gap;
  const totalH = contentY + H;
  const inner = `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#ffffff"/>`
    + banner.svg
    + `<g transform="translate(0,${contentY.toFixed(1)})">` + parts.join('') + `</g>`;
  return wrapExportSVG(inner, totalW, totalH);
}
/* ── Export de la vue Carte (PNG / SVG) ──
   Reprend le principe du widget de référence (carte Leaflet hors-écran,
   fitBounds sur l'emprise des polygones, tuiles CARTO) mais avec les
   dimensions dérivées du contenu (pas de cadre fixe 1980×1200) et le bandeau
   titre + légende minimisée communs aux 3 autres vues, plutôt qu'un titre et
   une légende surimposés à la carte elle-même. PNG intègre le fond de carte
   (tuiles rasterisées) ; SVG reste vectoriel (polygones seuls, sans fond de
   carte — une mosaïque de tuiles en base64 serait impraticable dans un .svg
   téléchargé), comme dans le widget de référence. */
function mapExportLabelLines(nom) {
  const short = String(nom)
    .replace(/^Communauté de Communes\s*/i,'CC ').replace(/^Communauté d'Agglomération\s*/i,'CA ')
    .replace(/^Communauté Urbaine\s*/i,'CU ').replace(/^Métropole\s*/i,'Met. ').trim();
  const words = short.split(' '); const lines = []; let cur = '';
  for (const w of words) { if (!cur) cur = w; else if ((cur+' '+w).length <= 18) cur += ' '+w; else { lines.push(cur); cur = w; } }
  if (cur) lines.push(cur);
  return lines;
}
async function buildMapExportInstance(mapW, mapH, bounds) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:'+mapW+'px;height:'+mapH+'px;pointer-events:none;';
  document.body.appendChild(holder);
  const exportMap = L.map(holder, {
    zoomControl: false, attributionControl: false, fadeAnimation: false,
    zoomSnap: 0.05, zoomDelta: 0.05,
  });
  const tileLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19, crossOrigin: true,
  }).addTo(exportMap);
  const margin = 28;
  exportMap.fitBounds(bounds, { padding: [margin, margin], animate: false });
  await new Promise(resolve => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    tileLayer.once('load', finish);
    setTimeout(finish, 2500); // filet de sécurité
  });
  await new Promise(r => setTimeout(r, 150)); // laisser le DOM se stabiliser
  return { exportMap, holder };
}
// Récupère les tuiles déjà chargées dans la carte hors-écran (mêmes <img>
// que Leaflet a positionnées) et les redessine dans un <canvas> à la même
// position — nécessaire pour ensuite lire les pixels (toDataURL), ce qu'un
// <img> affiché par Leaflet ne permet pas directement.
async function rasterizeMapTiles(holder, mapW, mapH) {
  const canvas = document.createElement('canvas');
  canvas.width = mapW; canvas.height = mapH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f5f5f5'; ctx.fillRect(0, 0, mapW, mapH);
  const holderRect = holder.getBoundingClientRect();
  const tileEls = holder.querySelectorAll('.leaflet-tile-pane img.leaflet-tile');
  await Promise.all([...tileEls].map(img => new Promise(res => {
    if (!img.src) return res();
    const r = img.getBoundingClientRect();
    const i = new Image(); i.crossOrigin = 'anonymous';
    i.onload = () => { ctx.drawImage(i, r.left - holderRect.left, r.top - holderRect.top, r.width, r.height); res(); };
    i.onerror = () => res();
    i.src = img.src;
  })));
  return canvas;
}
function mapPolygonPathD(feature, latLng2px) {
  const geom = feature.geometry;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let d = '';
  for (const rings of polys) {
    for (const ring of rings) {
      const [x0, y0] = latLng2px(ring[0][1], ring[0][0]);
      d += 'M' + x0.toFixed(1) + ',' + y0.toFixed(1);
      for (let i = 1; i < ring.length; i++) { const [x, y] = latLng2px(ring[i][1], ring[i][0]); d += 'L' + x.toFixed(1) + ',' + y.toFixed(1); }
      d += 'Z';
    }
  }
  return d;
}
function buildMapPolygonsSVG(cache, latLng2px) {
  let parts = '';
  for (const feature of cache.geojson.features) {
    const code = String(feature.properties[cache.codeProp]);
    const fill = getColor(getVal(code));
    parts += `<path d="${mapPolygonPathD(feature, latLng2px)}" fill="${fill}" stroke="#333" stroke-width="1.6" stroke-opacity="0.85"/>`;
  }
  return parts;
}
function drawMapPolygonsCanvas(ctx, cache, latLng2px) {
  for (const feature of cache.geojson.features) {
    const code = String(feature.properties[cache.codeProp]);
    const fill = getColor(getVal(code));
    const geom = feature.geometry;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    ctx.beginPath();
    for (const rings of polys) for (const ring of rings) {
      const [x0, y0] = latLng2px(ring[0][1], ring[0][0]); ctx.moveTo(x0, y0);
      for (let i = 1; i < ring.length; i++) { const [x, y] = latLng2px(ring[i][1], ring[i][0]); ctx.lineTo(x, y); }
      ctx.closePath();
    }
    ctx.fillStyle = fill; ctx.globalAlpha = 1; ctx.fill();
    ctx.globalAlpha = 0.85; ctx.strokeStyle = '#333'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
/* ── Export de la vue Carte en mode "écoles" ──
   Contours simplifiés des EPCI/circo (sans remplissage, cf.
   simplifiedPolygonStyle), contours pointillés des RPI (cf.
   rpiPolygonStyle), et points-écoles classés/décluttérés — que la carte
   soit en vue d'ensemble ou zoomée sur une circo/EPCI (les deux cas
   utilisent la même emprise que la carte en direct, cf. buildMapExportSVG). */
function buildSimplifiedPolygonsSVG(cache, latLng2px) {
  let parts = '';
  for (const feature of cache.geojson.features) {
    parts += `<path d="${mapPolygonPathD(feature, latLng2px)}" fill="none" stroke="#111" stroke-width="3"/>`;
  }
  return parts;
}
function drawSimplifiedPolygonsCanvas(ctx, cache, latLng2px) {
  for (const feature of cache.geojson.features) {
    const geom = feature.geometry;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    ctx.beginPath();
    for (const rings of polys) for (const ring of rings) {
      const [x0, y0] = latLng2px(ring[0][1], ring[0][0]); ctx.moveTo(x0, y0);
      for (let i = 1; i < ring.length; i++) { const [x, y] = latLng2px(ring[i][1], ring[i][0]); ctx.lineTo(x, y); }
      ctx.closePath();
    }
    ctx.strokeStyle = '#111'; ctx.lineWidth = 3; ctx.stroke();
  }
}
function rpiPolygonPathsD(rpiFC, latLng2px) {
  return rpiFC.features.map(f => mapPolygonPathD(f, latLng2px));
}
function buildRpiPolygonsSVG(rpiFC, latLng2px) {
  return rpiPolygonPathsD(rpiFC, latLng2px)
    .map(d => `<path d="${d}" fill="none" stroke="#777" stroke-width="1.6" stroke-dasharray="9 7"/>`).join('');
}
function drawRpiPolygonsCanvas(ctx, rpiFC, latLng2px) {
  ctx.setLineDash([9, 7]);
  for (const d of rpiPolygonPathsD(rpiFC, latLng2px)) {
    ctx.strokeStyle = '#777'; ctx.lineWidth = 1.6; ctx.stroke(new Path2D(d));
  }
  ctx.setLineDash([]);
}
// Données des points-écoles pour l'export : mêmes classes de rupture que
// showSchoolsForFeature (calculées sur TOUTES les écoles, pas seulement
// celles de la zone affichée, pour que la couleur d'une école ne dépende
// pas du zoom/de la zone visible), mais décluttering et dessin limités aux
// écoles dans l'emprise exportée (avec une petite marge pour ne pas couper
// un point à cheval sur le bord) — sans ce filtre, les écoles hors-champ
// (vue zoomée sur un seul EPCI/circo) se retrouvaient projetées à des
// coordonnées aberrantes, loin en dehors du cadre.
async function buildSchoolExportMarkers(exportMap, bounds) {
  const model = await ensureSchoolData();
  const isPct = state.type === 'pourcentage';
  const valueOf = p => isPct ? p.cumulPct : p.cumul;
  const withValue = model.points.filter(p => valueOf(p) != null);
  const { breaks, colors } = isPct
    ? buildJenksColors(withValue.map(valueOf), 8)
    : buildSchoolBreaksFixed(withValue.map(valueOf), 5);
  const paddedBounds = bounds.pad(0.15);
  const visible = withValue.filter(p => paddedBounds.contains([p.lat, p.lng]));
  const placed = declusterSchoolPoints(visible, exportMap, 36, 32);
  return { placed, breaks, colors, isPct };
}
// Une école proche du bord de l'emprise exportée peut être décalée hors
// cadre par le décluttering (grille étalée autour du centroïde d'un
// groupe, cf. declusterSchoolPoints) : le centre du marqueur est ramené
// dans le cadre (avec une petite marge) pour qu'il reste toujours au moins
// partiellement visible, plutôt que de disparaître hors champ.
// r=13 (comme avant) donnait des points visuellement bien plus gros que sur
// la carte en direct (circleMarker radius=6) une fois rapportés à la même
// échelle de sortie — ramené à une valeur plus proche de l'aperçu écran.
const SCHOOL_MARKER_R = 8;
function clampMarkerCenter(cx, cy, mapW, mapH, margin = SCHOOL_MARKER_R) {
  return [Math.max(margin, Math.min(mapW - margin, cx)), Math.max(margin, Math.min(mapH - margin, cy))];
}
function buildSchoolMarkersSVG(placed, breaks, colors, latLng2px, mapW, mapH) {
  let parts = '';
  for (const { school, lat, lng } of placed) {
    let [cx, cy] = latLng2px(lat, lng);
    [cx, cy] = clampMarkerCenter(cx, cy, mapW, mapH);
    const fill = getColorFromBreaks(getValueForSchoolMarker(school), breaks, colors);
    parts += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${SCHOOL_MARKER_R}" fill="${fill}" stroke="#333" stroke-width="1.5"/>`;
  }
  return parts;
}
function drawSchoolMarkersCanvas(ctx, placed, breaks, colors, latLng2px, mapW, mapH) {
  for (const { school, lat, lng } of placed) {
    let [cx, cy] = latLng2px(lat, lng);
    [cx, cy] = clampMarkerCenter(cx, cy, mapW, mapH);
    const fill = getColorFromBreaks(getValueForSchoolMarker(school), breaks, colors);
    ctx.beginPath(); ctx.arc(cx, cy, SCHOOL_MARKER_R, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}
// Valeur ayant servi au classement (buildSchoolExportMarkers) : cumul brut
// ou en %, selon l'unité affichée — même logique que valueOf() dans
// showSchoolsForFeature.
function getValueForSchoolMarker(school) {
  return state.type === 'pourcentage' ? school.cumulPct : school.cumul;
}
function buildSchoolLegendItems(breaks, colors, isPct) {
  const items = [];
  for (let i = colors.length - 1; i >= 0; i--) items.push({ label: fmtSchoolLegendRange(breaks[i], breaks[i+1], isPct), color: colors[i] });
  return { title: schoolLegendTitle(isPct), items };
}
// Mêmes règles d'affichage que les étiquettes de la carte en direct
// (addLabels) : nom seul si "Afficher les valeurs" est désactivé, valeur
// principale + éventuellement seconde unité sinon.
function mapLabelItems(feature, code, cache) {
  const nom = cache.model.NOM_BY_CODE[code] || feature.properties.circo || feature.properties.nom || code;
  const items = mapExportLabelLines(nom).map(l => ({ text: l, color: '#1a1a1a' }));
  const delta = state.showValues ? getVal(code) : null;
  if (delta != null) {
    const col = delta > 0 ? '#1a6b2a' : delta < 0 ? '#a50026' : '#555';
    items.push({ text: formatVal(delta), color: col });
    if (state.showSecondUnit && state.type !== 'effectifs') {
      const secondary = getSecondaryVal(code);
      if (secondary != null) {
        const col2 = secondary > 0 ? '#1a6b2a' : secondary < 0 ? '#a50026' : '#555';
        items.push({ text: formatSecondaryVal(secondary), color: col2 });
      }
    }
  }
  return items;
}
function buildMapLabelsSVG(cache, latLng2px) {
  let parts = '';
  for (const feature of cache.geojson.features) {
    const code = String(feature.properties[cache.codeProp]);
    const center = featureCenter(feature);
    const [cx, cy] = latLng2px(center[0], center[1]);
    const items = mapLabelItems(feature, code, cache);
    const lineH = 32, startY = cy - (items.length * lineH) / 2 + lineH / 2;
    items.forEach((it, i) => {
      parts += `<text x="${cx.toFixed(1)}" y="${(startY + i * lineH).toFixed(1)}" text-anchor="middle" `
        + `font-family="Arial" font-size="26" font-weight="bold" `
        + `stroke="rgba(255,255,255,0.92)" stroke-width="5" stroke-linejoin="round" paint-order="stroke" `
        + `fill="${it.color}">${escXml(it.text)}</text>`;
    });
  }
  return parts;
}
function drawMapLabelsCanvas(ctx, cache, latLng2px) {
  ctx.textAlign = 'center';
  for (const feature of cache.geojson.features) {
    const code = String(feature.properties[cache.codeProp]);
    const center = featureCenter(feature);
    const [cx, cy] = latLng2px(center[0], center[1]);
    const items = mapLabelItems(feature, code, cache);
    const lineH = 32, startY = cy - (items.length * lineH) / 2 + lineH / 2;
    items.forEach((it, i) => {
      const ty = startY + i * lineH;
      ctx.font = 'bold 26px Arial'; ctx.lineWidth = 5; ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.strokeText(it.text, cx, ty);
      ctx.fillStyle = it.color; ctx.fillText(it.text, cx, ty);
    });
  }
}
// Légende : bloc flottant en bas à droite, par-dessus la carte — comme à
// l'écran (cf. #map-legend en CSS) — plutôt qu'une bande sous la carte qui
// grandirait le canevas et ne correspondrait plus à l'aperçu direct.
// Générique (titre + items {label,color} déjà résolus) : sert à la fois à
// la légende choroplèthe (buildChoroplethLegendItems) et à celle du mode
// écoles (buildSchoolLegendItems).
function buildMapLegendOverlay(mapW, mapH, title, items) {
  if (!items.length) return '';
  const margin = 20, pad = 24, itemH = 42, swatchW = 36, swatchH = 26, swatchGap = 14, titleH = 48;
  const textW = Math.max(...items.map(it => it.label.length * 13), title.length * 15);
  const boxW = pad * 2 + swatchW + swatchGap + textW;
  const boxH = pad * 2 + titleH + items.length * itemH;
  const boxX = mapW - boxW - margin, boxY = mapH - boxH - margin;
  let svg = `<rect x="${boxX.toFixed(1)}" y="${boxY.toFixed(1)}" width="${boxW.toFixed(1)}" height="${boxH.toFixed(1)}" rx="8" fill="rgba(255,255,255,0.96)" stroke="rgba(0,0,0,0.15)" stroke-width="1"/>`;
  const innerX = boxX + pad;
  svg += `<text x="${innerX.toFixed(1)}" y="${(boxY + pad + 27).toFixed(1)}" font-family="Arial" font-size="28" font-weight="700" fill="#222">${escXml(title)}</text>`;
  items.forEach((it, i) => {
    const iy = boxY + pad + titleH + i * itemH;
    svg += `<rect x="${innerX.toFixed(1)}" y="${iy.toFixed(1)}" width="${swatchW}" height="${swatchH}" rx="4" fill="${it.color}" stroke="rgba(0,0,0,0.12)" stroke-width="0.5"/>`;
    svg += `<text x="${(innerX + swatchW + swatchGap).toFixed(1)}" y="${(iy + swatchH - 5).toFixed(1)}" font-family="Arial" font-size="22" fill="#222">${escXml(it.label)}</text>`;
  });
  return svg;
}
function buildChoroplethLegendItems() {
  const cache = scaleCache[state.echelle];
  const key = activeBreakKey();
  const breaks = cache.model.BREAKS[key], colors = cache.model.COLORS[key], n = cache.model.N[key];
  if (!breaks || breaks.length < 2 || !n) return { title: '', items: [] };
  const items = [];
  for (let i = n - 1; i >= 0; i--) items.push({ label: fmtLegendRange(breaks[i], breaks[i+1]), color: colors[i] });
  return { title: legendTitle(), items };
}
async function buildMapExportSVG(fmt) {
  const cache = scaleCache[state.echelle];
  if (!cache.geojson) throw new Error('Carte non chargée.');
  const titleParts = currentTitleParts();
  const schoolsMode = schoolsModeActive;

  // L'emprise à exporter est toujours celle des polygones affichés (vue
  // d'ensemble : tout le territoire ; vue zoomée sur une circo/EPCI cliquée
  // en mode écoles : seulement ce polygone), jamais le viewport actuel de la
  // carte en direct (map.getBounds()) — celui-ci peut être plus lâche que les
  // polygones eux-mêmes (zoom arrondi, marge de fitBounds initiale, pan
  // manuel...), ce qui donnait un cadrage moins serré à l'export en mode
  // écoles que sur la carte choroplèthe, resserrée par construction sur
  // groupedLayer.getBounds().
  let bounds;
  if (schoolsMode && schoolsZoomedBounds) {
    bounds = schoolsZoomedBounds;
  } else {
    const groupedLayer = L.featureGroup(cache.geojson.features.map(f => L.geoJSON(f.geometry)));
    bounds = groupedLayer.getBounds();
  }
  // Le canevas de la carte est dimensionné pour occuper exactement l'espace
  // du cadre d'export fixe (1980×1200) sous le bandeau titre, plutôt que
  // d'après le ratio propre du territoire (mapContentAspect) : un territoire
  // proche du carré ou en portrait donnait sinon un ratio total < 1980:1200,
  // ce qui laissait une marge blanche à droite une fois la mise à l'échelle
  // appliquée. fitBounds (cf. buildMapExportInstance) gère nativement un
  // conteneur dont l'aspect ne correspond pas à celui du territoire, en
  // affichant simplement un peu plus de fond de carte de part et d'autre —
  // sans rogner ni déformer le contenu.
  const mapW = EXPORT_W;
  const banner = exportTitleBanner(titleParts.main, titleParts.unit, mapW);
  const contentY = banner.height + banner.gap;
  const mapH = Math.round(EXPORT_H - contentY);

  const { exportMap, holder } = await buildMapExportInstance(mapW, mapH, bounds);
  try {
    const latLng2px = (lat, lng) => { const pt = exportMap.latLngToContainerPoint([lat, lng]); return [pt.x, pt.y]; };

    let mapInner, legendSVG;
    if (schoolsMode) {
      // Filtré à l'emprise exportée (avec marge) pour la même raison que les
      // écoles (cf. buildSchoolExportMarkers) : un RPI loin de la zone
      // affichée se projetterait à des coordonnées aberrantes.
      const paddedBounds = bounds.pad(0.15);
      const rpiFCAll = await ensureRpiGeometry();
      const rpiFC = { type: 'FeatureCollection', features: rpiFCAll.features.filter(f => paddedBounds.contains(featureCenter(f))) };
      const { placed, breaks, colors, isPct } = await buildSchoolExportMarkers(exportMap, bounds);
      if (fmt === 'png') {
        const canvas = await rasterizeMapTiles(holder, mapW, mapH);
        const ctx = canvas.getContext('2d');
        drawSimplifiedPolygonsCanvas(ctx, cache, latLng2px);
        if (rpiFC.features.length) drawRpiPolygonsCanvas(ctx, rpiFC, latLng2px);
        drawSchoolMarkersCanvas(ctx, placed, breaks, colors, latLng2px, mapW, mapH);
        mapInner = `<image href="${canvas.toDataURL('image/png')}" x="0" y="0" width="${mapW}" height="${mapH}"/>`;
      } else {
        mapInner = `<rect width="${mapW}" height="${mapH}" fill="#f5f5f5"/>`
          + buildSimplifiedPolygonsSVG(cache, latLng2px)
          + (rpiFC.features.length ? buildRpiPolygonsSVG(rpiFC, latLng2px) : '')
          + buildSchoolMarkersSVG(placed, breaks, colors, latLng2px, mapW, mapH);
      }
      const { title, items } = buildSchoolLegendItems(breaks, colors, isPct);
      legendSVG = buildMapLegendOverlay(mapW, mapH, title, items);
    } else {
      if (fmt === 'png') {
        const canvas = await rasterizeMapTiles(holder, mapW, mapH);
        const ctx = canvas.getContext('2d');
        drawMapPolygonsCanvas(ctx, cache, latLng2px);
        drawMapLabelsCanvas(ctx, cache, latLng2px);
        mapInner = `<image href="${canvas.toDataURL('image/png')}" x="0" y="0" width="${mapW}" height="${mapH}"/>`;
      } else {
        mapInner = `<rect width="${mapW}" height="${mapH}" fill="#f5f5f5"/>`
          + buildMapPolygonsSVG(cache, latLng2px) + buildMapLabelsSVG(cache, latLng2px);
      }
      const { title, items } = buildChoroplethLegendItems();
      legendSVG = buildMapLegendOverlay(mapW, mapH, title, items);
    }

    const totalW = mapW;
    const totalH = contentY + mapH;
    const inner = `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#ffffff"/>`
      + banner.svg
      + `<g transform="translate(0,${contentY.toFixed(1)})">${mapInner}${legendSVG}</g>`;
    return wrapExportSVG(inner, totalW, totalH);
  } finally {
    exportMap.remove();
    holder.remove();
  }
}
function svgToPngBlob(svgString, width, height) {
  return new Promise((resolve, reject) => {
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0,0,width,height);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Échec de conversion PNG')), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Échec de chargement du SVG pour conversion PNG')); };
    img.src = url;
  });
}
// Lignes d'une feuille EPCI/Circonscription : même structure que la vue
// Tableau (non-dépivoté, une colonne par année, Cumul RS26-RS30 en dernière
// colonne sauf en unité Effectifs). Suppose state.echelle/state.type déjà
// positionnés sur (echelle, type) par l'appelant (sortedCodesBy/getValAt/
// totalForYear/totalCumul lisent l'état global).
function buildScaleSheetRows(echelle, type) {
  const cache = scaleCache[echelle];
  const years = cache.model.RENTREES_DISPO.filter(r => r !== 'CUMUL');
  const showCumul = type !== 'effectifs';
  const header = [echelle === 'epci' ? 'EPCI' : 'Circonscription', ...years];
  if (showCumul) header.push('Cumul RS26-RS30');
  const rows = [header];
  for (const code of sortedCodesBy()) {
    const row = [cache.model.NOM_BY_CODE[code] || code];
    for (const r of years) { const v = getValAt(code, r); row.push(v == null ? '' : Math.round(v*100)/100); }
    if (showCumul) { const v = type === 'pourcentage' ? (cache.model.CUMUL_PCT[code] ?? null) : (cache.model.CUMUL[code] ?? null); row.push(v == null ? '' : Math.round(v*100)/100); }
    rows.push(row);
  }
  const totalRow = ['TOTAL'];
  for (const r of years) { const v = totalForYear(r); totalRow.push(v == null ? '' : Math.round(v*100)/100); }
  if (showCumul) { const v = totalCumul(); totalRow.push(v == null ? '' : Math.round(v*100)/100); }
  rows.push(totalRow);
  return rows;
}
// Colonnes années pour les écoles : mêmes rentrées que RENTREES_DISPO
// (RS21…RS30), en excluant les deux années de base RS19/RS20 qui ne servent
// qu'au calcul de la toute première variation.
function schoolYearColumns(model) {
  return RENTREES_ALL.filter(r => !RS_EXCLUDE_TIMELINE.has(r) && model.points.some(p => p.years[r] != null));
}
// Nom (pas code) de l'EPCI/circonscription contenant un point donné.
function findAreaName(school, echelle) {
  const code = schoolAreaCode(school, echelle);
  if (!code) return '';
  const cache = scaleCache[echelle];
  return cache.model.NOM_BY_CODE[code] || (echelle === 'circo' ? school.circoNom : '') || code;
}
function buildSchoolAreaNames(model) {
  const circoName = new Map(), epciName = new Map();
  for (const s of model.points) {
    circoName.set(s.uai, findAreaName(s, 'circo'));
    epciName.set(s.uai, findAreaName(s, 'epci'));
  }
  return { circoName, epciName };
}
// Lignes d'une feuille "Par école" : mêmes principes que buildScaleSheetRows,
// plus les colonnes Circonscription/EPCI (noms) pour permettre un TCD.
function buildSchoolSheetRows(type, model, circoName, epciName) {
  const years = schoolYearColumns(model);
  const showCumul = type !== 'effectifs';
  const header = ['UAI', 'École', 'Sigle', 'Commune', 'Type', 'Circonscription', 'EPCI', ...years];
  if (showCumul) header.push('Cumul RS26-RS30');
  const sorted = [...model.points].sort((a, b) => schoolDisplayName(a).localeCompare(schoolDisplayName(b), 'fr'));
  const rows = [header];
  for (const s of sorted) {
    const row = [
      s.uai, s.denomination || '', s.sigle || '', s.commune || '', s.type || '',
      circoName.get(s.uai) || '', epciName.get(s.uai) || '',
    ];
    for (const r of years) {
      const idx = RENTREES_ALL.indexOf(r);
      const prevR = idx > 0 ? RENTREES_ALL[idx - 1] : null;
      const cur = s.years[r], prev = prevR != null ? s.years[prevR] : null;
      let v;
      if (type === 'effectifs') v = cur ?? null;
      else if (cur != null && prev != null) {
        const diff = cur - prev;
        v = type === 'pourcentage' ? (prev !== 0 ? diff / prev * 100 : null) : diff;
      } else v = null;
      row.push(v == null ? '' : Math.round(v * 100) / 100);
    }
    if (showCumul) {
      const v = type === 'pourcentage' ? (s.cumulPct ?? null) : (s.cumul ?? null);
      row.push(v == null ? '' : Math.round(v * 100) / 100);
    }
    rows.push(row);
  }
  return rows;
}
// Style minimal des feuilles exportées : contour bas sous chaque ligne,
// aucun contour vertical/horizontal supérieur. En-tête en gras avec un
// filet plus marqué. Nécessite xlsx-js-style (l'édition SheetJS gratuite
// standard n'écrit pas les styles de cellules).
const XLSX_BORDER_BOTTOM_THIN = { bottom: { style: 'thin', color: { rgb: 'B0B0B0' } } };
const XLSX_BORDER_BOTTOM_HEADER = { bottom: { style: 'medium', color: { rgb: '333333' } } };
function sheetFromRows(rows) {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (!cell) continue;
      cell.s = R === 0
        ? { font: { bold: true }, border: XLSX_BORDER_BOTTOM_HEADER }
        : { border: XLSX_BORDER_BOTTOM_THIN };
    }
  }
  return ws;
}
// Export complet : quel que soit l'endroit d'où il est déclenché, produit le
// même classeur (9 feuilles = 3 échelles × 3 unités), indépendamment de la
// vue/échelle/unité actuellement affichées.
async function exportAllDataXLSX() {
  const prevEchelle = state.echelle, prevType = state.type;
  const prevSortKey = sortKey, prevSortDir = sortDir;
  sortKey = 'NAME'; sortDir = 'asc';
  try {
    const [, , schoolModelData] = await Promise.all([ensureScaleData('circo'), ensureScaleData('epci'), ensureSchoolData()]);
    const wb = XLSX.utils.book_new();
    const echelles = [{ key: 'circo', label: 'Par circo' }, { key: 'epci', label: 'Par EPCI' }];
    const types = [{ key: 'effectifs', label: 'Effectifs' }, { key: 'variation', label: 'Variation' }, { key: 'pourcentage', label: 'Pourcentage' }];
    for (const ech of echelles) {
      state.echelle = ech.key;
      for (const ty of types) {
        state.type = ty.key;
        const rows = buildScaleSheetRows(ech.key, ty.key);
        XLSX.utils.book_append_sheet(wb, sheetFromRows(rows), `${ech.label} (${ty.label})`);
      }
    }
    const { circoName, epciName } = buildSchoolAreaNames(schoolModelData);
    for (const ty of types) {
      const rows = buildSchoolSheetRows(ty.key, schoolModelData, circoName, epciName);
      XLSX.utils.book_append_sheet(wb, sheetFromRows(rows), `Par école (${ty.label})`);
    }
    XLSX.writeFile(wb, `carte_scolaire_1D_${new Date().toISOString().slice(0,10)}.xlsx`);
  } finally {
    state.echelle = prevEchelle; state.type = prevType;
    sortKey = prevSortKey; sortDir = prevSortDir;
  }
}

// Les paramètres d'URL "timeline"/"ecoles" dépendent des données chargées
// (RENTREES_DISPO, carte) : appliqués une seule fois, au tout premier rendu.
let initialUrlParamsApplied = false;
function showLoader() { document.getElementById('page-loader').hidden = false; }
function hideLoader() { document.getElementById('page-loader').hidden = true; }
async function renderCurrentView() {
  if (state.sessionActive !== true) {
    showSessionError(state.sessionMessage || 'Accès non autorisé.');
    hideLoader();
    return;
  }
  showLoader();
  try {
    const cache = await ensureScaleData(state.echelle);
    if (!initialUrlParamsApplied && urlTimeline) {
      const idx = cache.model.RENTREES_DISPO.indexOf(urlTimeline);
      if (idx >= 0) state.rentreeIdx = idx;
    }
    if (state.rentreeIdx == null || state.rentreeIdx >= cache.model.RENTREES_DISPO.length) {
      const idxRS26 = cache.model.RENTREES_DISPO.indexOf('RS26');
      state.rentreeIdx = idxRS26 >= 0 ? idxRS26 : 0;
    }
    updateTitle();
    showPane(state.vue);
    if (state.vue === 'carte') {
      buildTimeline();
      renderMap();
      if (!initialUrlParamsApplied && urlWantsSchools) {
        enterSchoolsMode();
        document.getElementById('btn-toggle-schools').classList.add('active');
      }
    } else if (state.vue === 'courbes') {
      renderCurves();
    } else if (state.vue === 'tableau') {
      renderHeatmap();
    }
    initialUrlParamsApplied = true;
    syncUrlFromState();
  } catch (err) {
    showSessionError(`Erreur lors du chargement des données : ${err.message}`);
  } finally {
    hideLoader();
  }
}

function showSessionError(html) {
  const el = document.getElementById('session-error');
  document.querySelectorAll('.view-pane').forEach(p => p.classList.remove('show'));
  el.style.display = 'flex';
  el.innerHTML = html;
}
// Session invalide/périmée : masque entièrement le bandeau titre et le volet
// de navigation (pas seulement grisés) pour ne laisser que le message
// d'erreur, centré en pleine page.
function disableNav() {
  document.body.classList.add('session-expired');
}

/* ══════════════════════ ÉVÉNEMENTS UI ══════════════════════ */
function setSeg(containerId, dataAttr, value, onChange) {
  const container = document.getElementById(containerId);
  container.querySelectorAll('.seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset[dataAttr] === value);
    btn.onclick = () => {
      if (btn.dataset[dataAttr] === value) return;
      onChange(btn.dataset[dataAttr]);
    };
  });
}
// La neutralisation de la timeline / du bouton "Effectifs" ne vaut que tant
// que la carte (avec ses écoles) est effectivement affichée à l'écran.
function schoolsModeBlocksControls() { return schoolsModeActive && state.vue === 'carte'; }
function refreshSegButtons() {
  setSeg('seg-vue', 'vue', state.vue, v => { state.vue = v; state.rentreeIdx = null; refreshSegButtons(); renderCurrentView(); });
  setSeg('seg-type', 'type', state.type, v => {
    if (v === 'effectifs' && schoolsModeBlocksControls()) return;
    if (v === 'effectifs' && currentRentree() === 'CUMUL') {
      const cache = scaleCache[state.echelle];
      const idxRS26 = cache?.model?.RENTREES_DISPO?.indexOf('RS26');
      state.rentreeIdx = idxRS26 >= 0 ? idxRS26 : state.rentreeIdx;
    }
    state.type = v;
    refreshSegButtons();
    renderCurrentView();
  });
  // "Effectifs" n'a pas de sens en mode "Afficher les écoles" (les points
  // n'affichent que le cumul RS26-RS30) : bouton grisé et non cliquable,
  // mais uniquement tant qu'on est en vue Cartes.
  const effBtn = document.querySelector('#seg-type .seg-btn[data-type="effectifs"]');
  if (effBtn) effBtn.disabled = schoolsModeBlocksControls();
  refreshMapLabelButtons();
}
// Boutons étiquettes carte, visibles uniquement en vue Cartes : "Afficher les
// valeurs" (nom seul si désactivé) toujours présent ; "+ Autre unité" (3e
// ligne avec l'unité complémentaire) en plus si Variation/Pourcentage, mais
// non actionnable tant que "Afficher les valeurs" est désactivé.
function refreshMapLabelButtons() {
  const wrap = document.getElementById('map-label-btns');
  const inCarte = state.vue === 'carte';
  wrap.hidden = !inCarte;
  if (!inCarte) return;
  const btnValues = document.getElementById('btn-toggle-values');
  const btnUnite2 = document.getElementById('btn-toggle-unite2');
  btnValues.classList.toggle('active', state.showValues);
  btnUnite2.hidden = state.type === 'effectifs';
  btnUnite2.classList.toggle('active', state.showSecondUnit);
  btnUnite2.disabled = !state.showValues;
}
function refreshMapLabels() {
  if (state.vue === 'carte' && !schoolsModeActive && geojsonLayer) { clearLabels(); addLabels(); }
}

function updateSidebarToggleTitle() {
  const collapsed = document.getElementById('sidebar').classList.contains('collapsed');
  const label = collapsed ? 'Déployer la navigation' : 'Réduire la navigation';
  document.getElementById('sidebar-toggle').setAttribute('title', label);
  document.getElementById('sidebar-toggle').setAttribute('aria-label', label);
}
document.getElementById('sidebar-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
  updateSidebarToggleTitle();
  setTimeout(() => map.invalidateSize(), 200);
});
function toggleEchelle() {
  state.echelle = state.echelle === 'epci' ? 'circo' : 'epci';
  state.rentreeIdx = null;
  focusCodes.clear();
  document.getElementById('track-echelle').classList.toggle('on', state.echelle === 'circo');
  document.getElementById('opt-epci').classList.toggle('on', state.echelle === 'epci');
  document.getElementById('opt-circo').classList.toggle('on', state.echelle === 'circo');
  document.getElementById('echelle-compact-label').textContent = state.echelle === 'epci' ? 'EPCI' : 'CIRCO';
  renderCurrentView();
}
document.getElementById('switch-echelle').addEventListener('click', toggleEchelle);
document.getElementById('echelle-compact').addEventListener('click', toggleEchelle);
document.getElementById('btn-zoom-in').addEventListener('click', () => map.zoomIn());
document.getElementById('btn-zoom-out').addEventListener('click', () => map.zoomOut());
document.getElementById('btn-zoom-reset').addEventListener('click', () => {
  closeInfoPanel();
  schoolsZoomedBounds = null;
  if (lastFitBounds) map.fitBounds(lastFitBounds, { padding: [10,10] });
});
document.getElementById('info-panel-toggle').addEventListener('click', () => {
  document.getElementById('map-info-panel').classList.toggle('collapsed');
  updateLegendOffset();
});
document.getElementById('btn-toggle-legend').addEventListener('click', () => {
  document.getElementById('map-legend').classList.toggle('legend-hidden');
});
document.getElementById('btn-toggle-schools').addEventListener('click', () => {
  if (schoolsModeActive) exitSchoolsMode(); else enterSchoolsMode();
  document.getElementById('btn-toggle-schools').classList.toggle('active', schoolsModeActive);
});
document.getElementById('btn-toggle-values').addEventListener('click', () => {
  state.showValues = !state.showValues;
  refreshMapLabelButtons();
  refreshMapLabels();
  syncUrlFromState();
});
document.getElementById('btn-toggle-unite2').addEventListener('click', () => {
  if (!state.showValues) return;
  state.showSecondUnit = !state.showSecondUnit;
  refreshMapLabelButtons();
  refreshMapLabels();
  syncUrlFromState();
});
document.getElementById('btn-schoolchart-expand').addEventListener('click', openSchoolChartModal);
document.getElementById('info-school-chart').addEventListener('click', openSchoolChartModal);
document.querySelectorAll('.sc-export-png').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); exportSchoolCompareChart('png'); }));
document.querySelectorAll('.sc-export-svg').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); exportSchoolCompareChart('svg'); }));
document.getElementById('chart-modal-close').addEventListener('click', closeSchoolChartModal);
document.getElementById('chart-modal-backdrop').addEventListener('click', closeSchoolChartModal);
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && !document.getElementById('chart-modal').hidden) closeSchoolChartModal();
});
document.getElementById('sel-export').addEventListener('change', async e => {
  const format = e.target.value;
  e.target.selectedIndex = 0;
  if (!format) return;
  // L'export carte (tuiles + reconstruction de la carte hors-écran) prend
  // sensiblement plus de temps que les autres vues : le select est désactivé
  // le temps de l'opération pour éviter un second déclenchement.
  e.target.disabled = true;
  try {
    if (format === 'xlsx') {
      // L'export Excel est indépendant de la vue/échelle/unité affichées :
      // il contient toujours l'intégralité des données du document.
      await exportAllDataXLSX();
      return;
    }
    const result = state.vue === 'carte' ? await buildMapExportSVG(format)
      : state.vue === 'courbes' ? serializeCurvesSVG() : heatmapToSVG();
    if (format === 'svg') {
      triggerDownload(exportName('svg'), new Blob([result.svg], { type: 'image/svg+xml' }));
    } else if (format === 'png') {
      const blob = await svgToPngBlob(result.svg, result.width, result.height);
      triggerDownload(exportName('png'), blob);
    }
  } catch (err) {
    alert('Export échoué : ' + err.message);
    console.error('[dataviz] Erreur export :', err);
  } finally {
    e.target.disabled = false;
  }
});
window.addEventListener('resize', () => {
  if (state.vue === 'courbes' && document.getElementById('pane-courbes').classList.contains('show')) renderCurves();
  syncTimelineHeight();
});

/* ══════════════════════ INITIALISATION ══════════════════════ */
async function init() {
  showLoader();
  refreshSegButtons();
  try {
    const session = await postJson(CONFIG.webhookSession, state.sessId);
    // Liste blanche stricte : seul un statut explicitement "active" autorise
    // l'accès (un SessID erroné/inconnu ne doit jamais passer par défaut,
    // même si le webhook répond autre chose qu' "inactive").
    if (session.status !== 'active') {
      state.sessionActive = false;
      state.sessionMessage = session.message || 'Accès non autorisé.';
      disableNav();
      showSessionError(state.sessionMessage);
      document.getElementById('page-title').textContent = 'Session non autorisée';
      hideLoader();
      return;
    }
    state.sessionActive = true;
    logSessionEvent('start');
    startSessionHeartbeat();
  } catch (err) {
    state.sessionActive = false;
    state.sessionMessage = `Erreur lors de la vérification de la session : ${err.message}`;
    disableNav();
    showSessionError(state.sessionMessage);
    document.getElementById('page-title').textContent = 'Erreur';
    hideLoader();
    return;
  }
  await renderCurrentView();
}
document.addEventListener('DOMContentLoaded', init);
// pagehide (et non beforeunload/unload, de moins en moins fiables et
// dépréciés sur certains navigateurs) : se déclenche aussi bien en fermant
// l'onglet qu'en naviguant ailleurs, y compris sur mobile.
window.addEventListener('pagehide', () => {
  if (!state.sessionActive) return;
  logSessionEvent('end');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
});
// Heartbeat : re-signale périodiquement la session comme active pendant que
// la page reste ouverte, via une action "heartbeat" dédiée (distincte de
// "end" : n8n a besoin de distinguer "toujours ouverte" de "vraiment
// terminée" pour renseigner une colonne d'état, ex. "En cours"/"Terminée").
// Fermer un onglet ou naviguer ailleurs déclenche pagehide normalement (cf.
// ci-dessus, action "end") ; mais fermer le navigateur entier d'un coup (ou
// un crash) peut tuer le processus avant qu'une requête en cours n'aboutisse,
// y compris avec fetch keepalive — dans ce cas, Fin reste à la valeur du
// dernier heartbeat plutôt que vide, une approximation à la durée de
// l'intervalle près plutôt qu'une session qui paraîtrait ne jamais s'être
// terminée (l'état resterait alors "En cours" indéfiniment, faute d'un
// "end" jamais reçu — limite inhérente, pas contournable côté page).
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;
let heartbeatTimer = null;
function startSessionHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => logSessionEvent('heartbeat'), HEARTBEAT_INTERVAL_MS);
}
