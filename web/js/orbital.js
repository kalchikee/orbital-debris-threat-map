/* orbital.js — Data fetching, TLE parsing, SGP4 propagation
   Depends on: satellite.js global (loaded via CDN)
*/

window.OrbitalData = (function () {

  /* ── Config ────────────────────────────────────────────────────────── */
  const GROUPS = [
    { key: 'active',          label: 'Active Satellites',  url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle' },
    { key: 'starlink',        label: 'Starlink',           url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=starlink&FORMAT=tle' },
    { key: 'cosmos2251',      label: 'Cosmos 2251 Debris', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=cosmos-2251-debris&FORMAT=tle' },
    { key: 'fengyun',         label: 'Fengyun-1C Debris',  url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=fengyun-1c-debris&FORMAT=tle' },
    { key: 'cosmos1408',      label: 'Cosmos 1408 Debris', url: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=cosmos-1408-debris&FORMAT=tle' },
  ];

  const STALE_DAYS = 30;  // Flag TLEs older than this

  /* ── State ─────────────────────────────────────────────────────────── */
  let _rawByGroup = {};
  let _objects    = [];
  let _lastFetch  = null;
  let _lastPropagate = null;

  /* ── Public API ────────────────────────────────────────────────────── */
  const API = {
    get objects()      { return _objects; },
    get lastFetch()    { return _lastFetch; },
    get lastPropagate(){ return _lastPropagate; },

    /* Fetch all groups. onProgress(pct, label) called as groups complete */
    async fetchAll(onProgress) {
      _rawByGroup = {};
      _objects    = [];
      const total = GROUPS.length;
      let done = 0;

      const results = await Promise.allSettled(
        GROUPS.map(g =>
          fetchWithRetry(g.url)
            .then(text => {
              done++;
              if (onProgress) onProgress(done / total, g.label);
              return { key: g.key, label: g.label, text };
            })
        )
      );

      for (const r of results) {
        if (r.status === 'fulfilled') {
          const { key, label, text } = r.value;
          _rawByGroup[key] = parseTLEs(text, key);
          console.log(`[orbital] ${label}: ${_rawByGroup[key].length} TLE sets parsed`);
        } else {
          console.warn('[orbital] Group fetch failed:', r.reason);
        }
      }

      _lastFetch = new Date();
      return _rawByGroup;
    },

    /* Propagate all parsed TLEs to a given Date (defaults to now) */
    propagateAll(date) {
      const now  = date || new Date();
      const gmst = satellite.gstime(now);
      _objects   = [];

      for (const [groupKey, tleList] of Object.entries(_rawByGroup)) {
        for (const tle of tleList) {
          try {
            const posVel = satellite.propagate(tle.satrec, now);
            if (!posVel.position || isNaN(posVel.position.x)) continue;

            const geo = satellite.eciToGeodetic(posVel.position, gmst);
            const lat = satellite.radiansToDegrees(geo.latitude);
            let   lon = satellite.radiansToDegrees(geo.longitude);
            const alt = geo.height; // km above WGS84

            // Normalize longitude to [-180, 180]
            if (lon > 180)  lon -= 360;
            if (lon < -180) lon += 360;

            if (!isFinite(lat) || !isFinite(lon) || !isFinite(alt)) continue;
            if (alt < 0 || alt > 150000) continue; // sanity bounds

            const layer = classifyLayer(tle, groupKey, alt);
            const isRisk   = (alt >= 700 && alt <= 900);
            const isStale  = epochAge(tle.satrec) > STALE_DAYS;

            _objects.push({
              name:    tle.name,
              norad:   tle.norad,
              lat, lon, alt,
              incl:    toDeg(tle.satrec.inclo),
              ecc:     tle.satrec.ecco,
              period:  2 * Math.PI / tle.satrec.no * (1 / 60), // minutes
              group:   groupKey,
              layer,
              isRisk,
              isStale,
            });
          } catch (_) { /* skip bad TLEs */ }
        }
      }

      _lastPropagate = new Date();
      console.log(`[orbital] Propagated ${_objects.length} objects at ${_lastPropagate.toISOString()}`);
      return _objects;
    },

    /* Filter objects by altitude range [minKm, maxKm] and active layers */
    filter(minAlt, maxAlt, layers) {
      return _objects.filter(o => {
        if (o.alt < minAlt || o.alt > maxAlt) return false;
        if (o.layer === 'graveyard' && !layers.graveyard) return false;
        // 'risk' layer is rendered as an override on top of other layers
        return layers[o.layer] !== false;
      });
    },

    /* Compute stats from current objects */
    stats() {
      const s = { total: 0, debris: 0, active: 0, starlink: 0, risk: 0, graveyard: 0 };
      for (const o of _objects) {
        s.total++;
        if (o.layer === 'debris')    s.debris++;
        if (o.layer === 'active')    s.active++;
        if (o.layer === 'starlink')  s.starlink++;
        if (o.layer === 'graveyard') s.graveyard++;
        if (o.isRisk)                s.risk++;
      }
      return s;
    },

    /* Altitude histogram: returns array of {label, min, max, debris, active, starlink} */
    altitudeHistogram() {
      const bins = [
        { label: '200–400',   min: 200,  max: 400  },
        { label: '400–600',   min: 400,  max: 600  },
        { label: '600–800',   min: 600,  max: 800  },
        { label: '800–1000',  min: 800,  max: 1000 },
        { label: '1000–1200', min: 1000, max: 1200 },
        { label: '1200–1500', min: 1200, max: 1500 },
        { label: '1500–2000', min: 1500, max: 2000 },
        { label: '2000–5000', min: 2000, max: 5000 },
        { label: '5000–20k',  min: 5000, max: 20000},
        { label: 'GEO+',      min:20000, max:150000},
      ];
      for (const b of bins) { b.debris = 0; b.active = 0; b.starlink = 0; }
      for (const o of _objects) {
        const b = bins.find(b => o.alt >= b.min && o.alt < b.max);
        if (!b) continue;
        if (o.layer === 'debris')   b.debris++;
        else if (o.layer === 'starlink') b.starlink++;
        else if (o.layer === 'active')   b.active++;
      }
      return bins;
    },
  };

  /* ── Helpers ────────────────────────────────────────────────────────── */
  async function fetchWithRetry(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await fetch(url, { cache: 'default' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.text();
      } catch (e) {
        if (i === retries) throw e;
        await sleep(1000 * (i + 1));
      }
    }
  }

  function parseTLEs(text, groupKey) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const out   = [];
    let i = 0;
    while (i < lines.length) {
      const l1 = lines[i + 1] || '';
      const l2 = lines[i + 2] || '';
      if (l1.startsWith('1 ') && l2.startsWith('2 ') && l1.length >= 69 && l2.length >= 69) {
        try {
          const satrec = satellite.twoline2satrec(l1, l2);
          if (!satrec.error) {
            out.push({
              name:   sanitizeName(lines[i]),
              norad:  parseInt(l1.substring(2, 7).trim(), 10),
              satrec,
              group:  groupKey,
            });
          }
        } catch (_) {}
        i += 3;
      } else {
        i++;
      }
    }
    return out;
  }

  function classifyLayer(tle, groupKey, alt) {
    const name = tle.name.toUpperCase();
    if (groupKey === 'starlink' || name.startsWith('STARLINK')) return 'starlink';
    if (alt > 35786 + 500)  return 'graveyard';   // >500km above GEO
    if (groupKey === 'cosmos2251' || groupKey === 'fengyun' || groupKey === 'cosmos1408') return 'debris';
    if (name.includes('DEB') || name.includes('DEBRIS') || name.includes('FRAG')) return 'debris';
    return 'active';
  }

  function epochAge(satrec) {
    // satrec.epochyr is 2-digit year, epochdays is day of year
    const yr = satrec.epochyr < 57 ? 2000 + satrec.epochyr : 1900 + satrec.epochyr;
    const epochDate = new Date(yr, 0, 1);
    epochDate.setDate(epochDate.getDate() + satrec.epochdays - 1);
    return (Date.now() - epochDate.getTime()) / 86400000;
  }

  function toDeg(rad) { return rad * 180 / Math.PI; }
  function sanitizeName(s) { return s.replace(/[^\x20-\x7E]/g, '').trim() || 'UNKNOWN'; }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  return API;
})();
