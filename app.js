'use strict';

/* =========================================================================
 * Coming Home – Kompass nach Hause
 * ========================================================================= */

const HOME = {
  label: 'Zum Aabach 11, 33014 Bad Driburg',
  query: { street: '11 Zum Aabach', postalcode: '33014', city: 'Bad Driburg', country: 'Deutschland' },
  // Optional: feste, geprüfte Koordinaten eintragen, dann entfällt die Online-Geocodierung.
  // Beispiel: fixed: { lat: 51.7..., lon: 9.0... }
  fixed: null,
  // Notlösung, falls die Geocodierung scheitert: ungefähres Zentrum von Bad Driburg.
  approx: { lat: 51.7333, lon: 9.0167 },
};

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const HOME_CACHE_KEY = 'cominghome.home.v1';
const ARRIVED_METERS = 25;

/* ---------- Zustand ---------- */
const state = {
  mode: 'gps',          // 'gps' | 'sim'
  home: null,           // { lat, lon, approx: bool }
  gpsPos: null,         // { lat, lon, acc }
  simPos: null,         // { lat, lon, label }
  heading: null,        // Grad, 0 = Norden (geglättet)
  headingSource: null,
  watchId: null,
  userMovedMap: false,
  gpsError: null,
};

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  modeGps: $('modeGps'), modeSim: $('modeSim'), fitBtn: $('fitBtn'),
  simForm: $('simForm'), simInput: $('simInput'), simResults: $('simResults'),
  dial: $('dial'), arrow: $('arrow'),
  distance: $('distance'), bearing: $('bearing'), status: $('status'),
  compassBtn: $('compassBtn'), panel: document.querySelector('.panel'),
};

/* ---------- Geo-Mathematik ---------- */
const toRad = (d) => d * Math.PI / 180;
const toDeg = (r) => r * 180 / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;

function distanceMeters(a, b) {
  const R = 6371008.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Anfangskurs (Großkreis) von a nach b, 0° = geographisch Nord
function initialBearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return norm360(toDeg(Math.atan2(y, x)));
}

// Punkte entlang des Großkreises (für lange Strecken korrekt "gerade")
function greatCirclePoints(a, b, n = 64) {
  const φ1 = toRad(a.lat), λ1 = toRad(a.lon), φ2 = toRad(b.lat), λ2 = toRad(b.lon);
  const d = distanceMeters(a, b) / 6371008.8;
  if (d < 1e-6) return [[a.lat, a.lon], [b.lat, b.lon]];
  const pts = [];
  let prevLon = null;
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    const lat = toDeg(Math.atan2(z, Math.hypot(x, y)));
    let lon = toDeg(Math.atan2(y, x));
    // Datumsgrenze: Längengrad stetig halten
    if (prevLon !== null) {
      while (lon - prevLon > 180) lon -= 360;
      while (lon - prevLon < -180) lon += 360;
    }
    prevLon = lon;
    pts.push([lat, lon]);
  }
  return pts;
}

const DIRS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const cardinal = (deg) => DIRS[Math.round(norm360(deg) / 22.5) % 16];

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 10000) return `${(m / 1000).toFixed(2).replace('.', ',')} km`;
  if (m < 100000) return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  return `${Math.round(m / 1000).toLocaleString('de-DE')} km`;
}

/* ---------- Karte ---------- */
const map = L.map('map', { zoomControl: false, attributionControl: true, worldCopyJump: true })
  .setView([HOME.approx.lat, HOME.approx.lon], 13);

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: 'Bilder &copy; Esri, Maxar, Earthstar Geographics, GIS User Community',
}).addTo(map);

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, opacity: 0.85,
}).addTo(map);

const homeIcon = L.divIcon({
  className: '',
  html: '<div class="marker-home"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M12 3 2 12h3v8h5v-5h4v5h5v-8h3z"/></svg></div>',
  iconSize: [34, 34], iconAnchor: [17, 17],
});
const meIcon = (sim) => L.divIcon({
  className: '', html: `<div class="marker-me${sim ? ' sim' : ''}"></div>`,
  iconSize: [20, 20], iconAnchor: [10, 10],
});

let homeMarker = null;
let meMarker = null;
let accCircle = null;
const lineHalo = L.polyline([], { color: '#000', weight: 7, opacity: 0.35, interactive: false }).addTo(map);
const line = L.polyline([], { color: '#ff5a3c', weight: 4, opacity: 0.95, dashArray: '10 8', interactive: false }).addTo(map);

let programmaticMove = false;
map.on('dragstart zoomstart', () => { if (!programmaticMove) state.userMovedMap = true; });

function fitBoth() {
  const pos = currentPos();
  const pts = [];
  if (state.home) pts.push([state.home.lat, state.home.lon]);
  if (pos) pts.push([pos.lat, pos.lon]);
  if (!pts.length) return;
  const topEl = state.mode === 'sim' ? el.simForm : el.modeGps.parentElement;
  const topPad = topEl.getBoundingClientRect().bottom + 30;
  const bottomPad = window.innerHeight - el.panel.getBoundingClientRect().top + 30;
  programmaticMove = true;
  if (pts.length === 1) {
    map.setView(pts[0], 16);
  } else {
    map.fitBounds(L.latLngBounds(line.getLatLngs().length ? line.getLatLngs() : pts), {
      paddingTopLeft: [40, topPad], paddingBottomRight: [40, bottomPad], maxZoom: 18,
    });
  }
  map.once('moveend', () => { programmaticMove = false; });
  setTimeout(() => { programmaticMove = false; }, 600);
  state.userMovedMap = false;
}

function currentPos() {
  return state.mode === 'sim' ? state.simPos : state.gpsPos;
}

function updateMap() {
  const pos = currentPos();

  if (state.home && !homeMarker) {
    homeMarker = L.marker([state.home.lat, state.home.lon], { icon: homeIcon, zIndexOffset: 500 })
      .bindPopup(`Zuhause<br>${HOME.label}${state.home.approx ? '<br><b>(ungefähre Position)</b>' : ''}`)
      .addTo(map);
  }

  if (pos) {
    const ll = [pos.lat, pos.lon];
    if (!meMarker) meMarker = L.marker(ll, { icon: meIcon(state.mode === 'sim'), zIndexOffset: 1000 }).addTo(map);
    meMarker.setLatLng(ll).setIcon(meIcon(state.mode === 'sim'));

    if (state.mode === 'gps' && pos.acc) {
      if (!accCircle) accCircle = L.circle(ll, { radius: pos.acc, color: '#2f80ff', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      accCircle.setLatLng(ll).setRadius(pos.acc);
    } else if (accCircle) {
      map.removeLayer(accCircle); accCircle = null;
    }
  } else {
    if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
    if (accCircle) { map.removeLayer(accCircle); accCircle = null; }
  }

  if (pos && state.home) {
    const pts = greatCirclePoints(pos, state.home);
    line.setLatLngs(pts);
    lineHalo.setLatLngs(pts);
  } else {
    line.setLatLngs([]);
    lineHalo.setLatLngs([]);
  }
}

/* ---------- Anzeige ---------- */
function render() {
  const pos = currentPos();
  const status = [];

  if (!state.home) {
    el.distance.textContent = '–';
    el.bearing.textContent = 'Lade Heimatadresse …';
  } else if (!pos) {
    el.distance.textContent = '–';
    if (state.mode === 'sim') el.bearing.textContent = 'Adresse eingeben oder auf Karte tippen';
    else el.bearing.textContent = state.gpsError ? 'Kein GPS-Standort' : 'Warte auf GPS …';
  } else {
    const dist = distanceMeters(pos, state.home);
    const brg = initialBearing(pos, state.home);
    const arrived = dist <= Math.max(ARRIVED_METERS, state.mode === 'gps' ? (pos.acc || 0) : 0);
    el.panel.classList.toggle('arrived', arrived);
    el.distance.textContent = arrived ? 'Zuhause!' : formatDistance(dist);
    el.bearing.textContent = arrived ? `${formatDistance(dist)} entfernt`
      : `Richtung ${cardinal(brg)} · ${Math.round(brg)}°`;
    const heading = state.heading ?? 0;
    el.arrow.style.transform = `rotate(${smoothAngle('arrow', brg - heading)}deg)`;
  }

  el.dial.style.transform = `rotate(${smoothAngle('dial', -(state.heading ?? 0))}deg)`;

  if (state.mode === 'sim') {
    status.push(state.simPos
      ? `<span class="warn">Simulation:</span> ${escapeHtml(shorten(state.simPos.label, 60))}`
      : '<span class="warn">Simulationsmodus</span>');
  } else if (state.gpsError) {
    status.push(`<span class="warn">${escapeHtml(state.gpsError)}</span>`);
  } else if (state.gpsPos) {
    status.push(`GPS ±${Math.round(state.gpsPos.acc)} m`);
  }

  if (state.heading === null) {
    status.push('<span class="warn">Kein Kompass – Pfeil gilt für Norden oben (wie Karte)</span>');
  }
  if (state.home?.approx) {
    status.push('<span class="warn">Heimatposition nur ungefähr (Geocodierung fehlgeschlagen)</span>');
  }
  el.status.innerHTML = status.join('<br>');
}

// Rotation ohne 359°→0°-Sprung der CSS-Transition
const lastAngles = {};
function smoothAngle(key, target) {
  const prev = lastAngles[key];
  if (prev === undefined) return (lastAngles[key] = norm360(target));
  let delta = norm360(target - prev);
  if (delta > 180) delta -= 360;
  return (lastAngles[key] = prev + delta);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function refresh(refit = false) {
  updateMap();
  render();
  if (refit || !state.userMovedMap) fitBoth();
}

/* ---------- Geocodierung (Nominatim / OpenStreetMap) ---------- */
async function nominatim(params) {
  const url = new URL(NOMINATIM);
  Object.entries({ format: 'jsonv2', addressdetails: '1', 'accept-language': 'de', ...params })
    .forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Geocodierung fehlgeschlagen (HTTP ${res.status})`);
  return res.json();
}

async function loadHome() {
  if (HOME.fixed) {
    state.home = { ...HOME.fixed, approx: false };
    return;
  }
  try {
    const cached = JSON.parse(localStorage.getItem(HOME_CACHE_KEY) || 'null');
    if (cached && cached.label === HOME.label && Number.isFinite(cached.lat)) {
      state.home = { lat: cached.lat, lon: cached.lon, approx: false };
      return;
    }
  } catch (_) { /* Speicher nicht verfügbar */ }

  try {
    let results = await nominatim({ ...HOME.query, countrycodes: 'de', limit: '1' });
    if (!results.length) {
      results = await nominatim({ q: HOME.label, countrycodes: 'de', limit: '1' });
    }
    if (!results.length) throw new Error('Adresse nicht gefunden');
    const r = results[0];
    state.home = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), approx: false };
    try {
      localStorage.setItem(HOME_CACHE_KEY, JSON.stringify({ label: HOME.label, lat: state.home.lat, lon: state.home.lon, found: r.display_name }));
    } catch (_) { /* egal */ }
  } catch (err) {
    console.warn('Heimat-Geocodierung:', err);
    state.home = { ...HOME.approx, approx: true };
  }
}

/* ---------- GPS ---------- */
function startGps() {
  if (!('geolocation' in navigator)) {
    state.gpsError = 'Dieses Gerät unterstützt keine Ortung.';
    render();
    return;
  }
  if (state.watchId !== null) return;
  let first = !state.gpsPos;
  state.watchId = navigator.geolocation.watchPosition(
    (p) => {
      state.gpsError = null;
      state.gpsPos = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      if (state.mode === 'gps') refresh(first);
      first = false;
    },
    (err) => {
      state.gpsError = {
        1: 'Standortzugriff verweigert – bitte in den Browser-Einstellungen erlauben.',
        2: 'Standort nicht verfügbar.',
        3: 'Zeitüberschreitung bei der Ortung.',
      }[err.code] || err.message;
      if (state.mode === 'gps') render();
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

/* ---------- Kompass (Geräteausrichtung) ---------- */
function screenAngle() {
  if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle;
  if (typeof window.orientation === 'number') return window.orientation;
  return 0;
}

let rawHeadingFrame = null;
function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
    h = e.webkitCompassHeading; // iOS: bereits Kompasskurs (magnetisch)
    state.headingSource = 'ios';
  } else if (e.absolute && e.alpha !== null) {
    h = 360 - e.alpha; // Android/Chrome: alpha relativ zu Nord, gegen den Uhrzeigersinn
    state.headingSource = 'absolute';
  } else {
    return; // relative Ausrichtung ist für einen Kompass unbrauchbar
  }
  h = norm360(h + screenAngle());

  // Glättung (zirkulär)
  if (state.heading === null) state.heading = h;
  else {
    let d = norm360(h - state.heading);
    if (d > 180) d -= 360;
    state.heading = norm360(state.heading + d * 0.25);
  }
  el.compassBtn.classList.add('hidden');
  if (!rawHeadingFrame) {
    rawHeadingFrame = requestAnimationFrame(() => { rawHeadingFrame = null; render(); });
  }
}

let orientationListening = false;
function listenOrientation() {
  if (orientationListening) return;
  orientationListening = true;
  const type = ('ondeviceorientationabsolute' in window) ? 'deviceorientationabsolute' : 'deviceorientation';
  window.addEventListener(type, onOrientation);
}

function initCompass() {
  if (typeof DeviceOrientationEvent === 'undefined') return;
  // Sofort lauschen: wo keine Erlaubnis nötig ist, kommen die Daten direkt.
  listenOrientation();
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // z. B. iOS 13+: Erlaubnis nur per Nutzeraktion. Der Knopf verschwindet,
    // sobald Kompassdaten eintreffen.
    el.compassBtn.classList.remove('hidden');
    el.compassBtn.addEventListener('click', async () => {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') el.compassBtn.textContent = 'Kompass verweigert';
      } catch (err) {
        el.compassBtn.textContent = 'Kompass nicht verfügbar';
      }
    });
  }
}

/* ---------- Simulation ---------- */
function setMode(mode) {
  state.mode = mode;
  const sim = mode === 'sim';
  el.modeGps.classList.toggle('active', !sim);
  el.modeSim.classList.toggle('active', sim);
  el.modeGps.setAttribute('aria-selected', String(!sim));
  el.modeSim.setAttribute('aria-selected', String(sim));
  el.simForm.classList.toggle('hidden', !sim);
  el.panel.classList.remove('arrived');
  if (!sim) startGps();
  refresh(true);
  if (sim && !state.simPos) el.simInput.focus();
}

function setSimPos(lat, lon, label) {
  state.simPos = { lat, lon, label };
  refresh(true);
}

let lastSearch = 0;
el.simForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el.simInput.value.trim();
  if (!q) return;
  // Nominatim-Nutzungsrichtlinie: max. 1 Anfrage pro Sekunde
  const wait = 1100 - (Date.now() - lastSearch);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSearch = Date.now();

  el.simResults.innerHTML = '<li class="info">Suche …</li>';
  try {
    const results = await nominatim({ q, limit: '5' });
    el.simResults.innerHTML = '';
    if (!results.length) {
      el.simResults.innerHTML = '<li class="info">Keine Treffer gefunden.</li>';
      return;
    }
    results.forEach((r, i) => {
      const li = document.createElement('li');
      li.textContent = r.display_name;
      li.addEventListener('click', () => {
        [...el.simResults.children].forEach((c) => c.classList.remove('selected'));
        li.classList.add('selected');
        setSimPos(parseFloat(r.lat), parseFloat(r.lon), r.display_name);
        el.simInput.blur();
      });
      el.simResults.appendChild(li);
      if (i === 0) li.click();
    });
  } catch (err) {
    el.simResults.innerHTML = `<li class="info">${escapeHtml(err.message || 'Fehler bei der Suche')}</li>`;
  }
});

map.on('click', (e) => {
  if (state.mode !== 'sim') return;
  const { lat, lng } = e.latlng.wrap();
  [...el.simResults.children].forEach((c) => c.classList.remove('selected'));
  state.simPos = { lat, lon: lng, label: `Kartenpunkt ${lat.toFixed(5)}, ${lng.toFixed(5)}` };
  updateMap();
  render();
});

/* ---------- Start ---------- */
el.modeGps.addEventListener('click', () => setMode('gps'));
el.modeSim.addEventListener('click', () => setMode('sim'));
el.fitBtn.addEventListener('click', () => fitBoth());
window.addEventListener('resize', () => { if (!state.userMovedMap) fitBoth(); });

(async function main() {
  render();
  initCompass();
  startGps();
  await loadHome();
  refresh(true);
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
