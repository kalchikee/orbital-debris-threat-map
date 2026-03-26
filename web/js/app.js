/* app.js — 3D Globe with THREE.Points at real orbital altitudes
   Depends on: orbital.js, satellite.js, Three.js, Globe.gl, Chart.js
*/

/* ── Constants ─────────────────────────────────────────────────────────── */
const COLORS = {
  debris:    '#f57c00',
  active:    '#58a6ff',
  starlink:  '#8957e5',
  risk:      '#ff3d3d',
  graveyard: '#8b949e',
};

const LAYER_LABELS = {
  debris:    'Debris Field',
  active:    'Active Satellite',
  starlink:  'Starlink',
  graveyard: 'Graveyard Orbit',
};

const CONJUNCTION_FEED = [
  { obj1: 'COSMOS 2251 DEB',  obj2: 'STARLINK-2472',   tca: '+00:42:18', dist: '142 m',   pc: '1.2×10⁻³', risk: 'high' },
  { obj1: 'FENGYUN 1C DEB',   obj2: 'TERRA',           tca: '+02:17:44', dist: '891 m',   pc: '3.4×10⁻⁴', risk: 'elevated' },
  { obj1: 'COSMOS 1408 DEB',  obj2: 'ISS (ZARYA)',      tca: '+04:55:02', dist: '2.1 km',  pc: '8.1×10⁻⁵', risk: 'elevated' },
  { obj1: 'SL-8 DEB',         obj2: 'SENTINEL-2A',     tca: '+07:12:33', dist: '4.7 km',  pc: '2.9×10⁻⁵', risk: 'moderate' },
  { obj1: 'FENGYUN 1C DEB',   obj2: 'COSMOS 2251 DEB', tca: '+09:38:49', dist: '312 m',   pc: '4.7×10⁻⁴', risk: 'elevated' },
  { obj1: 'CZ-4B DEB',        obj2: 'LANDSAT 8',       tca: '+11:04:17', dist: '6.2 km',  pc: '1.1×10⁻⁵', risk: 'moderate' },
  { obj1: 'COSMOS 1408 DEB',  obj2: 'STARLINK-3891',   tca: '+13:22:05', dist: '789 m',   pc: '1.8×10⁻⁴', risk: 'elevated' },
  { obj1: 'IRIDIUM 33 DEB',   obj2: 'AQUA',            tca: '+15:47:31', dist: '3.4 km',  pc: '3.3×10⁻⁵', risk: 'moderate' },
];

/* ── State ──────────────────────────────────────────────────────────────── */
const STATE = {
  layers:         { debris: true, active: true, starlink: true, risk: true, graveyard: false },
  altMin:         0,
  altMax:         42164,
  autoRotate:     true,
  mouseX:         0,
  mouseY:         0,
  hoveredObj:     null,
  visibleObjects: [],
  charts:         {},
};

/* ── Three.js point cloud ───────────────────────────────────────────────── */
let globe      = null;
let pointsMesh = null;   // THREE.Points instance
let pointsData = [];     // parallel array to pointsMesh vertices, for raycasting lookup
let T          = null;   // THREE namespace — resolved after globe init (globe.gl bundles its own Three)
let raycaster  = null;

/* ── Circle sprite texture (cached) ────────────────────────────────────── */
let _circleTex = null;
function getCircleTexture() {
  if (_circleTex) return _circleTex;
  const sz  = 64;
  const c   = document.createElement('canvas');
  c.width   = sz; c.height = sz;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(sz / 2, sz / 2, sz / 2 - 1, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  _circleTex = new T.CanvasTexture(c);
  return _circleTex;
}

/* ── Init ───────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  setupNav();
  initGlobe();
  setupUIControls();
  setupConjunctionFeed();
  initCharts();
  await loadData();
});

/* ── Navigation ─────────────────────────────────────────────────────────── */
function setupNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${btn.dataset.panel}`).classList.add('active');
    });
  });
}

/* ── Globe Setup ────────────────────────────────────────────────────────── */
function initGlobe() {
  const container = document.getElementById('globe-container');

  globe = Globe()(container)
    .globeImageUrl('web/img/earth-dark.jpg')
    .bumpImageUrl('web/img/earth-topology.png')
    .backgroundImageUrl('web/img/night-sky.png')
    .atmosphereColor('#3a7cff')
    .atmosphereAltitude(0.12)
    // No pointsData — we render our own THREE.Points
    .pointsData([]);

  globe.pointOfView({ lat: 20, lng: 0, altitude: 2.5 });

  // three.min.js (r134 UMD) sets window.THREE globally.
  // Globe.gl may bundle its own Three.js, but since we need to add objects
  // directly to globe.scene(), we must use the SAME Three.js instance globe uses.
  // Globe.gl r134-compatible builds use the global THREE when available.
  T = window.THREE;
  if (!T) { console.error('THREE not found — check three.min.js loaded correctly'); return; }
  raycaster = new T.Raycaster();
  raycaster.params.Points = { threshold: 2 };

  const controls = globe.controls();
  controls.autoRotate      = true;
  controls.autoRotateSpeed = 0.4;
  controls.enableDamping   = true;
  controls.dampingFactor   = 0.08;
  controls.minDistance     = 101;
  controls.maxDistance     = 900;

  // Resume auto-rotate after 6 s of inactivity
  let resumeTimer;
  controls.addEventListener('start', () => {
    if (STATE.autoRotate) controls.autoRotate = false;
    clearTimeout(resumeTimer);
  });
  controls.addEventListener('end', () => {
    if (STATE.autoRotate)
      resumeTimer = setTimeout(() => { controls.autoRotate = true; }, 6000);
  });

  setupGlobeButtons();
  setupRaycasting(container);
}

/* ── Altitude → fraction of globe radius ───────────────────────────────── */
function getVisualAlt(alt) {
  // Piecewise-linear: places objects at real altitude shells
  if (alt < 2000) {
    return 0.02 + (alt / 2000) * 0.16;          // LEO  0.02 – 0.18
  } else if (alt < 20200) {
    return 0.18 + ((alt - 2000)  / 18200) * 0.37; // MEO  0.18 – 0.55
  } else {
    return Math.min(0.55 + ((alt - 20200) / 22000) * 0.35, 0.90); // GEO+ 0.55 – 0.90
  }
}

function getPointColor(o) {
  if (STATE.layers.risk && o.isRisk) return COLORS.risk;
  return COLORS[o.layer] || COLORS.active;
}

/* ── Build / refresh THREE.Points cloud ────────────────────────────────── */
function refreshGlobe() {
  if (!globe) return;

  const scene   = globe.scene();
  const objects = STATE.visibleObjects;

  // Tear down old mesh
  if (pointsMesh) {
    scene.remove(pointsMesh);
    pointsMesh.geometry.dispose();
    pointsMesh.material.dispose();
    pointsMesh = null;
  }
  pointsData = [];

  if (!objects.length) {
    document.getElementById('sb-count').textContent = 'Objects rendered: 0';
    return;
  }

  const positions = new Float32Array(objects.length * 3);
  const colors    = new Float32Array(objects.length * 3);
  const col       = new T.Color();

  objects.forEach((obj, i) => {
    // globe.getCoords(lat, lng, altFraction) → {x, y, z} in Three.js world space
    const { x, y, z } = globe.getCoords(obj.lat, obj.lon, getVisualAlt(obj.alt));
    positions[i * 3]     = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    col.set(getPointColor(obj));
    colors[i * 3]     = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  });

  const geometry = new T.BufferGeometry();
  geometry.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color',    new T.Float32BufferAttribute(colors, 3));

  const material = new T.PointsMaterial({
    size:         4,           // pixels — constant regardless of zoom
    vertexColors: true,
    map:          getCircleTexture(),
    transparent:  true,
    alphaTest:    0.4,
    sizeAttenuation: false,   // always same screen size → no tiny dots when zoomed out
    depthWrite:   false,
  });

  pointsMesh = new T.Points(geometry, material);
  pointsData = objects;
  scene.add(pointsMesh);

  document.getElementById('sb-count').textContent =
    `Objects rendered: ${objects.length.toLocaleString()}`;
}

/* ── Raycasting for hover / click ───────────────────────────────────────── */
function setupRaycasting(container) {
  container.addEventListener('mousemove', e => {
    STATE.mouseX = e.clientX;
    STATE.mouseY = e.clientY;

    if (!pointsMesh || !pointsData.length) return;

    const rect  = container.getBoundingClientRect();
    const mouse = new T.Vector2(
      ((e.clientX - rect.left) / rect.width)  *  2 - 1,
      ((e.clientY - rect.top)  / rect.height) * -2 + 1,
    );

    raycaster.setFromCamera(mouse, globe.camera());
    const hits = raycaster.intersectObject(pointsMesh);

    if (hits.length > 0) {
      const obj = pointsData[hits[0].index];
      if (obj !== STATE.hoveredObj) {
        STATE.hoveredObj = obj;
        showTooltip(obj);
      } else {
        // Update tooltip position even if same object
        positionTooltip(rect);
      }
      container.style.cursor = 'pointer';
    } else {
      if (STATE.hoveredObj) {
        STATE.hoveredObj = null;
        document.getElementById('tooltip').classList.add('hidden');
      }
      container.style.cursor = 'grab';
    }
  });

  container.addEventListener('click', () => {
    if (STATE.hoveredObj) showObjectInspector(STATE.hoveredObj);
  });

  container.addEventListener('mouseleave', () => {
    STATE.hoveredObj = null;
    document.getElementById('tooltip').classList.add('hidden');
  });
}

/* ── Tooltip ────────────────────────────────────────────────────────────── */
function showTooltip(o) {
  const tooltip    = document.getElementById('tooltip');
  const layerColor = (STATE.layers.risk && o.isRisk) ? COLORS.risk : COLORS[o.layer];
  const layerLabel = o.isRisk
    ? `${LAYER_LABELS[o.layer] || o.layer} · HIGH RISK`
    : (LAYER_LABELS[o.layer] || o.layer);
  const regime = o.alt < 2000 ? 'LEO' : o.alt < 35786 ? 'MEO' : 'GEO+';

  tooltip.innerHTML = `
    <div class="tt-name">${o.name}</div>
    <span class="tt-layer" style="background:${layerColor}22;color:${layerColor}">${layerLabel}</span>
    <div style="margin-top:6px">
      <div class="tt-row"><span>Lat / Lon</span><span>${o.lat.toFixed(2)}° / ${o.lon.toFixed(2)}°</span></div>
      <div class="tt-row"><span>Altitude</span><span>${Math.round(o.alt).toLocaleString()} km</span></div>
      <div class="tt-row"><span>Regime</span><span>${regime}</span></div>
      <div class="tt-row"><span>Inclination</span><span>${o.incl.toFixed(1)}°</span></div>
      <div class="tt-row"><span>NORAD ID</span><span>${o.norad}</span></div>
    </div>
    <div style="font-size:9px;color:#8b949e;margin-top:5px">Click to inspect in sidebar</div>`;

  tooltip.classList.remove('hidden');
  positionTooltip(document.getElementById('map-area').getBoundingClientRect());
}

function positionTooltip(rect) {
  const tooltip = document.getElementById('tooltip');
  let tx = STATE.mouseX - rect.left + 14;
  let ty = STATE.mouseY - rect.top  - 10;
  if (tx + 230 > rect.width)  tx = STATE.mouseX - rect.left - 240;
  if (ty + 160 > rect.height) ty = STATE.mouseY - rect.top  - 165;
  tooltip.style.left = `${tx}px`;
  tooltip.style.top  = `${ty}px`;
}

/* ── Object inspector ───────────────────────────────────────────────────── */
function showObjectInspector(o) {
  const layerColor = (STATE.layers.risk && o.isRisk) ? COLORS.risk : COLORS[o.layer];
  const layerLabel = o.isRisk
    ? `${LAYER_LABELS[o.layer] || o.layer} · HIGH-RISK ZONE`
    : (LAYER_LABELS[o.layer] || o.layer);
  const regime = o.alt < 2000 ? 'LEO' : o.alt < 35786 ? 'MEO' : 'GEO+';

  const panel = document.getElementById('object-info');
  panel.className = 'object-info-data';
  panel.innerHTML = `
    <div class="oi-name">${o.name}</div>
    <span class="oi-layer" style="background:${layerColor}22;color:${layerColor}">${layerLabel}</span>
    <div class="oi-row"><span class="oi-key">NORAD ID</span><span class="oi-val">${o.norad}</span></div>
    <div class="oi-row"><span class="oi-key">Lat / Lon</span><span class="oi-val">${o.lat.toFixed(3)}° / ${o.lon.toFixed(3)}°</span></div>
    <div class="oi-row"><span class="oi-key">Altitude</span><span class="oi-val">${Math.round(o.alt).toLocaleString()} km</span></div>
    <div class="oi-row"><span class="oi-key">Regime</span><span class="oi-val">${regime}</span></div>
    <div class="oi-row"><span class="oi-key">Inclination</span><span class="oi-val">${o.incl.toFixed(2)}°</span></div>
    <div class="oi-row"><span class="oi-key">Eccentricity</span><span class="oi-val">${o.ecc.toFixed(6)}</span></div>
    <div class="oi-row"><span class="oi-key">Orb. Period</span><span class="oi-val">${o.period.toFixed(1)} min</span></div>
    <div class="oi-row"><span class="oi-key">TLE Age</span><span class="oi-val" style="color:${o.isStale?'#f57c00':'#3fb950'}">${o.isStale?'Stale (>30d)':'Current'}</span></div>`;
}

/* ── Globe overlay buttons ──────────────────────────────────────────────── */
function setupGlobeButtons() {
  const rotBtn = document.getElementById('gc-rotate');
  rotBtn.classList.toggle('toggled', STATE.autoRotate);
  rotBtn.addEventListener('click', () => {
    STATE.autoRotate = !STATE.autoRotate;
    globe.controls().autoRotate = STATE.autoRotate;
    rotBtn.classList.toggle('toggled', STATE.autoRotate);
  });

  document.getElementById('gc-reset').addEventListener('click', () => {
    globe.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 800);
  });

  document.getElementById('gc-leo').addEventListener('click', () => {
    globe.pointOfView({ lat: 30, lng: 0, altitude: 1.25 }, 1000);
  });

  document.getElementById('gc-geo').addEventListener('click', () => {
    globe.pointOfView({ lat: 5, lng: 0, altitude: 5.5 }, 1200);
  });
}

/* ── UI Controls ────────────────────────────────────────────────────────── */
function setupUIControls() {
  ['debris', 'active', 'starlink', 'risk', 'graveyard'].forEach(key => {
    document.getElementById(`chk-${key}`).addEventListener('change', e => {
      STATE.layers[key] = e.target.checked;
      applyFilter();
      refreshGlobe();
    });
  });

  const altMin    = document.getElementById('alt-min');
  const altMax    = document.getElementById('alt-max');
  const altMinVal = document.getElementById('alt-min-val');
  const altMaxVal = document.getElementById('alt-max-val');

  function updateAlt() {
    let mn = parseInt(altMin.value, 10);
    let mx = parseInt(altMax.value, 10);
    if (mn > mx - 100) mn = mx - 100;
    STATE.altMin = mn; STATE.altMax = mx;
    altMinVal.textContent = mn.toLocaleString() + ' km';
    altMaxVal.textContent = mx.toLocaleString() + ' km';
    applyFilter();
    refreshGlobe();
  }
  altMin.addEventListener('input', updateAlt);
  altMax.addEventListener('input', updateAlt);

  const REGIMES = {
    all: [0,     42164, { lat: 20, lng: 0, altitude: 2.5  }],
    leo: [160,   2000,  { lat: 30, lng: 0, altitude: 1.25 }],
    meo: [2000,  35786, { lat: 10, lng: 0, altitude: 3.5  }],
    geo: [35000, 42164, { lat: 5,  lng: 0, altitude: 5.5  }],
  };
  const REGIME_LABELS = {
    all: 'Showing all orbital regimes',
    leo: 'LEO: Low Earth Orbit (160–2,000 km)',
    meo: 'MEO: Medium Earth Orbit (2,000–35,786 km)',
    geo: 'GEO / Graveyard (35,000–42,164 km)',
  };

  document.querySelectorAll('.regime-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.regime-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const [mn, mx, pov] = REGIMES[btn.dataset.regime];
      altMin.value = mn; altMax.value = mx;
      STATE.altMin = mn; STATE.altMax = mx;
      altMinVal.textContent = mn.toLocaleString() + ' km';
      altMaxVal.textContent = mx.toLocaleString() + ' km';
      document.getElementById('regime-info').textContent = REGIME_LABELS[btn.dataset.regime];
      applyFilter();
      refreshGlobe();
      globe.pointOfView(pov, 900);
    });
  });

  document.getElementById('refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true; btn.textContent = '⏳ Refreshing…';
    await loadData();
    btn.disabled = false; btn.textContent = '↺ Refresh Positions';
  });
}

function applyFilter() {
  STATE.visibleObjects = OrbitalData.filter(STATE.altMin, STATE.altMax, STATE.layers);
  updateLayerCounts();
}

function updateLayerCounts() {
  const all = OrbitalData.objects;
  let debris = 0, active = 0, starlink = 0, risk = 0, graveyard = 0;
  for (const o of all) {
    if (o.layer === 'debris')    debris++;
    if (o.layer === 'active')    active++;
    if (o.layer === 'starlink')  starlink++;
    if (o.layer === 'graveyard') graveyard++;
    if (o.isRisk)                risk++;
  }
  document.getElementById('cnt-debris').textContent    = debris.toLocaleString();
  document.getElementById('cnt-active').textContent    = active.toLocaleString();
  document.getElementById('cnt-starlink').textContent  = starlink.toLocaleString();
  document.getElementById('cnt-risk').textContent      = risk.toLocaleString();
  document.getElementById('cnt-graveyard').textContent = graveyard.toLocaleString();
}

/* ── Data Loading ───────────────────────────────────────────────────────── */
async function loadData() {
  const loadStatus = document.getElementById('load-status');
  const loadDetail = document.getElementById('load-detail');
  const mapLoading = document.getElementById('map-loading');
  const mapLoadMsg = document.getElementById('map-load-msg');

  loadStatus.innerHTML = '<div class="spinner"></div> Fetching from CelesTrak…';
  mapLoading.classList.remove('hidden');
  mapLoadMsg.textContent = 'Connecting to CelesTrak API…';

  let loaded = 0;
  try {
    await OrbitalData.fetchAll((pct, label) => {
      loaded++;
      loadDetail.textContent = `✓ ${label}`;
      mapLoadMsg.textContent = `Loading group ${loaded}/5: ${label}…`;
    });

    mapLoadMsg.textContent = 'Computing positions via SGP4…';
    await tick();
    OrbitalData.propagateAll();

    applyFilter();
    refreshGlobe();

    const stats = OrbitalData.stats();
    updateStatBanner(stats);
    updateKesslerPanel(stats);

    const epoch = OrbitalData.lastFetch;
    document.getElementById('data-epoch').textContent   = epoch.toUTCString().replace('GMT', 'UTC');
    document.getElementById('last-refresh').textContent = 'Updated: ' + epoch.toLocaleTimeString();

    loadStatus.innerHTML = `<span style="color:#3fb950">✓ ${stats.total.toLocaleString()} objects loaded</span>`;
    loadDetail.textContent = `Propagated ${new Date().toUTCString().replace('GMT', 'UTC')}`;
    mapLoading.classList.add('hidden');

    updateDensityChart();

  } catch (err) {
    console.error('[app] Load error:', err);
    loadStatus.innerHTML = `<span style="color:#f57c00">⚠ Fetch failed — check network.</span>`;
    loadDetail.textContent = String(err);
    mapLoading.classList.add('hidden');
  }
}

function updateStatBanner(s) {
  document.getElementById('stat-total').textContent    = s.total.toLocaleString();
  document.getElementById('stat-debris').textContent   = s.debris.toLocaleString();
  document.getElementById('stat-active').textContent   = s.active.toLocaleString();
  document.getElementById('stat-starlink').textContent = s.starlink.toLocaleString();
  document.getElementById('stat-risk').textContent     = s.risk.toLocaleString();
  document.getElementById('stat-graveyard').textContent= s.graveyard.toLocaleString();
}

function updateKesslerPanel(s) {
  document.getElementById('k-total').textContent =
    s.total.toLocaleString();
  document.getElementById('k-debris-pct').textContent =
    s.total > 0 ? ((s.debris / s.total) * 100).toFixed(1) + '%' : '—';
  document.getElementById('k-graveyard-count').textContent =
    s.graveyard.toLocaleString();
  document.getElementById('src-total').textContent =
    s.debris.toLocaleString();
}

/* ── Charts ─────────────────────────────────────────────────────────────── */
function initCharts() {
  initDensityChart();
  initSourceChart();
  setupConjunctionFeed();
}

function initDensityChart() {
  const ctx = document.getElementById('density-chart').getContext('2d');
  STATE.charts.density = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'Debris',   backgroundColor: COLORS.debris   + 'cc', data: [] },
        { label: 'Starlink', backgroundColor: COLORS.starlink + 'cc', data: [] },
        { label: 'Active',   backgroundColor: COLORS.active   + 'cc', data: [] },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12, padding: 12 } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y.toLocaleString()}` } }
      },
      scales: {
        x: { stacked: true, ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: '#21262d' } },
        y: { stacked: true, ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: '#21262d' } }
      }
    }
  });
}

function updateDensityChart() {
  const hist  = OrbitalData.altitudeHistogram();
  const chart = STATE.charts.density;
  if (!chart) return;
  chart.data.labels           = hist.map(b => b.label);
  chart.data.datasets[0].data = hist.map(b => b.debris);
  chart.data.datasets[1].data = hist.map(b => b.starlink);
  chart.data.datasets[2].data = hist.map(b => b.active);
  chart.update();
}

function initSourceChart() {
  const ctx = document.getElementById('source-chart').getContext('2d');
  STATE.charts.source = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Fengyun-1C (2007)', 'Cosmos 2251 (2009)', 'Cosmos 1408 (2021)', 'Iridium 33 (2009)', 'Other Events', 'Active/Misc'],
      datasets: [{
        data: [3500, 2000, 1500, 600, 14400, 9800],
        backgroundColor: ['#f57c00cc','#d32f2fcc','#8957e5cc','#fbc02dcc','#30363dcc','#58a6ffcc'],
        borderColor: '#161b22', borderWidth: 2,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: '#8b949e', font: { size: 10 }, boxWidth: 10, padding: 8 } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${c.parsed.toLocaleString()} objects` } }
      }
    }
  });
}

function setupConjunctionFeed() {
  const feed = document.getElementById('cdm-feed');
  if (!feed) return;
  feed.innerHTML = CONJUNCTION_FEED.map(c => `
    <div class="cdm-item risk-${c.risk}">
      <div class="cdm-objects">${c.obj1} <span style="color:#8b949e">vs</span> ${c.obj2}</div>
      <span class="cdm-risk ${c.risk}">${c.risk}</span>
      <div class="cdm-meta">
        <span>TCA: <strong>${c.tca}</strong></span>
        <span>Miss: <strong>${c.dist}</strong></span>
        <span>Pc: <strong>${c.pc}</strong></span>
      </div>
    </div>`).join('');
}

/* ── Auto-refresh every 5 min ───────────────────────────────────────────── */
setInterval(() => {
  if (OrbitalData.objects.length > 0) {
    OrbitalData.propagateAll();
    applyFilter();
    refreshGlobe();
    document.getElementById('last-refresh').textContent =
      'Positions updated: ' + new Date().toLocaleTimeString();
  }
}, 5 * 60 * 1000);

function tick() { return new Promise(r => setTimeout(r, 20)); }
