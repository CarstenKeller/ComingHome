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
const LEAVE_METERS = 60;   // Ankunftsmodus endet erst über dieser Entfernung
const RING_DIAMETER = 40;  // px; Ankunft, sobald sich die Ringe berühren

/* ---------- Zustand ---------- */
const state = {
  mode: 'gps',          // 'gps' | 'sim'
  home: null,           // { lat, lon, approx: bool }
  gpsPos: null,         // { lat, lon, acc }
  simPos: null,         // { lat, lon, label }
  heading: null,        // Grad, 0 = Norden (geglättet)
  headingSource: null,
  watchId: null,
  calibrated: true,     // Karte ausgerichtet (Position im unteren, Zuhause im oberen Ring)?
  gpsError: null,
  topOpen: false,       // Einstellungen (Moduswahl + Suchfeld) oben eingeblendet?
};

// Bilder der Galerie am Heimatpunkt (Reihenfolge = Anzeige)
const GALLERY = ['01', '02', '03', '04', '05', '06', '07'].map((n) => `gallery/${n}.jpg`);

/* ---------- DOM ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  shareBtn: $('shareBtn'), toast: $('toast'),
  modeGps: $('modeGps'), modeSim: $('modeSim'), fitBtn: $('fitBtn'), settingsBtn: $('settingsBtn'), modeSwitch: $('modeSwitch'), topbar: $('topbar'),
  ringTop: document.querySelector('.ring-top'), ringBottom: document.querySelector('.ring-bottom'),
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
const map = L.map('map', {
  zoomControl: false, attributionControl: true, worldCopyJump: true,
  zoomSnap: 0,              // stufenloser Zoom, damit der Abstand exakt passt
  inertia: false,           // kein Nachgleiten nach dem Ziehen
  fadeAnimation: false,     // Kacheln ohne Einblenden (kein Flackern)
  rotate: true,             // Drehung über leaflet-rotate
  rotateControl: false, touchRotate: false, shiftKeyRotate: false, compassBearing: false,
})
  .setView([HOME.approx.lat, HOME.approx.lon], 13);

const TILE_URLS = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
];
L.tileLayer(TILE_URLS[0], {
  maxZoom: 19, keepBuffer: 6,
  attribution: 'Bilder &copy; Esri, Maxar, Earthstar Geographics, GIS User Community',
}).addTo(map);

L.tileLayer(TILE_URLS[1], {
  maxZoom: 19, opacity: 0.85, keepBuffer: 6,
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

// Kartenänderungen durch die App selbst (synchron, ohne Animation) dürfen
// den kalibrierten Zustand nicht aufheben.
let programmaticMove = false;
function programmatic(fn) {
  const prev = programmaticMove;
  programmaticMove = true;
  try { fn(); } finally { programmaticMove = prev; }
}

// Manuelles Verschieben/Zoomen beendet den kalibrierten Zustand
map.on('dragstart zoomstart', () => { if (!programmaticMove) setCalibrated(false); });

function setCalibrated(on) {
  state.calibrated = on;
  const pos = currentPos();
  const active = on && !!pos && !!state.home;
  el.ringBottom.classList.toggle('active', active);
  el.fitBtn.classList.toggle('alert', !on);
}

// Unter NEAR_METERS wird nicht weiter gezoomt: Stattdessen wandern die beiden
// Ringe gleichmäßig aufeinander zu (Abstand proportional zur Entfernung).
const NEAR_METERS = 200;
// Zoomänderungen unter ~2 % (0,03 Stufen) ignorieren – verhindert Kachel-Neuaufbau
const ZOOM_HYSTERESIS = 0.03;
let ringShift = 0;
let lastRingSpan = 550; // voller Ringabstand in px (zuletzt gemessen) // aktuelle Verschiebung jedes Rings Richtung Mitte (px)
function setRingShift(px) {
  ringShift = px;
  el.ringTop.style.transform = px ? `translateY(${px}px)` : '';
  el.ringBottom.style.transform = px ? `translateY(${-px}px)` : '';
}

const ringCenter = (elm) => {
  const r = elm.getBoundingClientRect();
  return L.point(r.left + r.width / 2, r.top + r.height / 2);
};

// Kalibrieren: Karte so drehen, zoomen und verschieben, dass die aktuelle
// Position mittig im unteren Ring und Zuhause mittig im oberen Ring liegt.
// Dreht sich die Karte gerade mit dem Kompass? (nur GPS-Modus mit Kompassdaten)
// Karte dreht sich mit dem Kompass – in GPS und Simulation gleichermaßen
const followsCompass = () => state.heading !== null;

// Kalibrieren: Karte so zoomen und verschieben, dass die aktuelle (bzw.
// simulierte) Position mittig im unteren Ring liegt und der Abstand zu Zuhause
// dem Abstand der Ringmittelpunkte entspricht. Die Drehung kommt allein vom
// Kompass (ohne Kompass: Norden oben).
function calibrate() {
  const pos = currentPos();
  const home = state.home;
  if (!pos || !home) {
    const p = pos || home;
    programmatic(() => {
      // Auch ohne GPS-Position mit dem Kompass drehen
      map.setBearing(followsCompass() ? -state.heading : 0);
      if (p) map.setView([p.lat, p.lon], 15, { animate: false });
    });
    setCalibrated(true);
    updateHomeLock();
    return;
  }
  // Grundpositionen der Ringe (ohne Verschiebung)
  const baseBottom = ringCenter(el.ringBottom).add(L.point(0, ringShift));
  const baseTop = ringCenter(el.ringTop).subtract(L.point(0, ringShift));
  const full = baseBottom.distanceTo(baseTop);
  lastRingSpan = full;
  const meters = distanceMeters(pos, home);
  // Nah dran: Ringe rücken zusammen, Zoom bleibt auf dem 200-m-Maßstab
  const near = meters < NEAR_METERS;
  const shift = near ? (full - full * meters / NEAR_METERS) / 2 : 0;
  setRingShift(shift);
  const bottom = baseBottom.subtract(L.point(0, shift));
  const top = baseTop.add(L.point(0, shift));
  const wanted = full - 2 * shift; // Abstand der Ringmittelpunkte in px

  // Richtung und Abstand in Kartenpixeln (Zoom 0, ungedreht)
  const p1 = map.project([pos.lat, pos.lon], 0);
  const p2 = map.project([home.lat, home.lon], 0);
  const d = p2.subtract(p1);
  const d0 = Math.hypot(d.x, d.y);
  // Winkel des Vektors Position -> Zuhause, im Uhrzeigersinn ab "oben"
  const angle = Math.atan2(d.x, -d.y) * 180 / Math.PI;
  // Winkel der Ringachse (unten -> oben) auf dem Bildschirm
  const axis = Math.atan2(baseTop.x - baseBottom.x, -(baseTop.y - baseBottom.y)) * 180 / Math.PI;

  // Oben ist immer die Blickrichtung laut Kompass (ohne Kompass: Norden).
  // Den Heimatpunkt bringt man durch Drehen des Handys in den oberen Ring.
  const up = followsCompass() ? state.heading : 0;

  let zoom;
  if (near) {
    // Maßstab: 200 m entsprechen dem vollen Ringabstand
    const mPerPx0 = 40075016 * Math.cos(pos.lat * Math.PI / 180) / 256;
    zoom = Math.log2(full / (NEAR_METERS / mPerPx0));
  } else {
    zoom = d0 > 0 ? Math.log2(wanted / d0) : map.getMaxZoom();
  }
  zoom = Math.max(map.getMinZoom(), Math.min(19, zoom));

  // Zoom nur ändern, wenn er sich spürbar unterscheidet: Jede Zoomänderung
  // ohne Animation lässt Leaflet alle Kacheln neu aufbauen (Flackern).
  const cur = map.getZoom();
  if (Math.abs(zoom - cur) < ZOOM_HYSTERESIS) zoom = cur;

  programmatic(() => {
    map.setBearing(axis - up);
    // Kartenmitte direkt so berechnen, dass die Position im unteren Ring liegt
    // (ein einziges setView -> bei gleichem Zoom nur Verschieben, kein Neuaufbau)
    const c = map.getSize().divideBy(2);
    const v = bottom.subtract(c);
    const th = map.getBearing() * Math.PI / 180;
    const mx = v.x * Math.cos(th) + v.y * Math.sin(th);
    const my = -v.x * Math.sin(th) + v.y * Math.cos(th);
    const centerPx = map.project([pos.lat, pos.lon], zoom).subtract(L.point(mx, my));
    map.setView(map.unproject(centerPx, zoom), zoom, { animate: false });
  });
  setCalibrated(true);
  updateHomeLock();
  schedulePrefetch();
}

// Liegt der Heimatpunkt komplett im oberen Ring? -> grün, Ring pulsiert,
// beim Einrasten 2 s Vibration.
// Mit Hysterese, damit es bei leichtem Zittern nicht ständig wechselt:
// Einrasten, wenn der Mittelpunkt höchstens LOCK_IN px vom Ringmittelpunkt
// entfernt ist; Lösen erst ab LOCK_OUT px.
const LOCK_IN = 12;
const LOCK_OUT = 20;     // = Ringradius
let homeLocked = false;
function resetHomeLock() {
  homeLocked = false;
  el.ringTop.classList.remove('locked');
  homeMarker?.getElement()?.querySelector('.marker-home')?.classList.remove('locked');
}

function updateHomeLock() {
  if (state.arrivedMode) return; // im Ankunftsmodus abgeschaltet
  const pos = currentPos();
  let inside = false;
  if (state.home && pos && homeMarker) {
    const hp = map.latLngToContainerPoint([state.home.lat, state.home.lon]);
    const dist = hp.distanceTo(ringCenter(el.ringTop));
    inside = homeLocked ? dist <= LOCK_OUT : dist <= LOCK_IN;
  }
  if (inside === homeLocked) return;
  homeLocked = inside;
  if (inside) summonGalleryButton();
  el.ringTop.classList.toggle('locked', inside);
  homeMarker?.getElement()?.querySelector('.marker-home')?.classList.toggle('locked', inside);
  // Vibration nur, wenn das Einrasten durch Drehen des Handys entsteht
  if (inside && followsCompass() && navigator.vibrate) {
    try { navigator.vibrate(2000); } catch (_) { /* nicht unterstützt */ }
  }
}
map.on('move zoom rotate', () => { if (!programmaticMove) updateHomeLock(); });

function currentPos() {
  return state.mode === 'sim' ? state.simPos : state.gpsPos;
}

function updateMap() {
  const pos = currentPos();

  if (state.home && !homeMarker) {
    homeMarker = L.marker([state.home.lat, state.home.lon], { icon: homeIcon, zIndexOffset: 500 })
      .on('click', openGallery)
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
    checkArrival(dist);
    const arrived = state.arrivedMode;
    el.panel.classList.toggle('arrived', arrived);
    el.distance.textContent = arrived ? 'Zuhause!' : formatDistance(dist);
    el.bearing.textContent = arrived ? `${formatDistance(dist)} entfernt`
      : `${cardinal(brg)} · ${Math.round(brg)}°`;
    const heading = state.heading ?? 0;
    el.arrow.style.transform = `rotate(${smoothAngle('arrow', brg - heading)}deg)`;
  }

  el.dial.style.transform = `rotate(${smoothAngle('dial', -(state.heading ?? 0))}deg)`;

  if (state.mode === 'sim') {
    status.push(state.simPos
      ? `<span class="warn">Simulation:</span> ${escapeHtml(shorten(state.simPos.label, 40))}${state.simPos.time ? ` (${formatAge(state.simPos.time)})` : ''}`
      : '<span class="warn">Simulationsmodus</span>');
  } else if (state.gpsError) {
    status.push(`<span class="warn">${escapeHtml(state.gpsError)}</span>`);
  } else if (state.gpsPos) {
    status.push(`GPS ±${Math.round(state.gpsPos.acc)} m`);
  }

  if (state.heading === null) {
    status.push({
      'needs-permission': '<span class="warn">Kompass aus – bitte aktivieren</span>',
      denied: '<span class="warn">Kompass verweigert (Einstellungen)</span>',
      unavailable: '<span class="warn">Kein Kompass: Norden oben</span>',
      pending: '<span class="warn">Warte auf Kompass …</span>',
    }[compassState] || '<span class="warn">Kein Kompass</span>');
  } else {
    status.push(`Kompass ${Math.round(state.heading)}°`);
  }
  if (state.home?.approx) {
    status.push('<span class="warn">Zuhause nur ungefähr</span>');
  }
  el.status.innerHTML = status.join('<br>');
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
function formatAge(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} Std. ${min % 60} Min.`;
  return `Stand ${new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
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

function refresh(recalibrate = false) {
  updateMap();
  render();
  if (recalibrate || state.calibrated) calibrate();
  else setCalibrated(false);
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
      const fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy };
      const old = state.gpsPos;
      // GPS-Rauschen ausfiltern: Kleine Sprünge innerhalb der Messgenauigkeit
      // ignorieren, sonst „wackelt“ die Karte im Stand.
      // Ankunftsmodus: Position einfrieren, bis man sich wieder entfernt
      if (state.arrivedMode && state.home && distanceMeters(fix, state.home) <= LEAVE_METERS) return;
      if (old && !first) {
        const moved = distanceMeters(old, fix);
        const better = fix.acc < old.acc * 0.7;
        if (moved < Math.max(4, fix.acc * 0.75) && !better) return;
      }
      state.gpsPos = fix;
      if (state.mode === 'gps') refresh(first);
      first = false;
    },
    (err) => {
      state.gpsError = {
        1: 'Standortzugriff verweigert – bitte in den Browser-Einstellungen erlauben.',
        2: 'Standort nicht verfügbar.',
        3: 'Zeitüberschreitung bei der Ortung.',
      }[err.code] || err.message;
      if (state.mode === 'gps') {
        render();
        if (!state.gpsErrorShown) { state.gpsErrorShown = true; showToast(state.gpsError); }
      }
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
let lastAppliedHeading = null;
// GPS-Modus: Karte dreht sich mit dem Kompass (Blickrichtung oben)
function rotateWithCompass() {
  if (!followsCompass()) return;
  if (lastAppliedHeading !== null) {
    let d = Math.abs(norm360(state.heading - lastAppliedHeading));
    if (d > 180) d = 360 - d;
    if (d < 0.2) return; // winzige Änderungen ignorieren
  }
  lastAppliedHeading = state.heading;
  if (state.calibrated) {
    calibrate();
  } else {
    // Manuell verschobene Karte: um die Bildmitte drehen
    programmatic(() => map.setBearing(-state.heading));
    updateHomeLock();
  }
}
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
  compassState = 'ok';
  if (!rawHeadingFrame) {
    rawHeadingFrame = requestAnimationFrame(() => {
      rawHeadingFrame = null;
      render();
      rotateWithCompass();
    });
  }
}

let orientationListening = false;
function listenOrientation() {
  if (orientationListening) return;
  orientationListening = true;
  // Beide Ereignisse abonnieren: Je nach Browser liefert nur eines davon
  // einen echten Kompasskurs (relative Werte werden in onOrientation verworfen).
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrientation);
  window.addEventListener('deviceorientation', onOrientation);
}

let compassState = 'pending'; // pending | needs-permission | denied | unavailable | ok
let permissionPending = false;
async function requestCompassPermission() {
  if (permissionPending) return;
  permissionPending = true;
  try {
    const res = await DeviceOrientationEvent.requestPermission();
    if (res === 'granted') {
      if (state.heading === null) compassState = 'pending'; // warte auf Daten
    } else {
      compassState = 'denied';
      el.compassBtn.textContent = 'Kompass verweigert';
    }
  } catch (err) {
    compassState = 'unavailable';
    el.compassBtn.textContent = 'Kompass nicht verfügbar';
  } finally {
    permissionPending = false;
  }
  render();
}

function initCompass() {
  if (typeof DeviceOrientationEvent === 'undefined') { compassState = 'unavailable'; return; }
  // Sofort lauschen: wo keine Erlaubnis nötig ist, kommen die Daten direkt.
  listenOrientation();
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    // z. B. iOS: Erlaubnis nur per Nutzeraktion. Der Knopf verschwindet,
    // sobald Kompassdaten eintreffen. Zusätzlich wird beim ersten Tippen
    // irgendwo auf der Seite automatisch nachgefragt.
    compassState = 'needs-permission';
    el.compassBtn.classList.remove('hidden');
    el.compassBtn.addEventListener('click', requestCompassPermission);
    const firstGesture = () => {
      document.removeEventListener('click', firstGesture, true);
      if (state.heading === null && compassState === 'needs-permission') requestCompassPermission();
    };
    document.addEventListener('click', firstGesture, true);
  }
  // Kommen nach einigen Sekunden keine Daten, Hinweis anzeigen
  setTimeout(() => { if (state.heading === null && compassState === 'pending') { compassState = 'unavailable'; render(); } }, 4000);
}

/* ---------- Simulation ---------- */
function setMode(mode) {
  state.mode = mode;
  const sim = mode === 'sim';
  el.modeGps.classList.toggle('active', !sim);
  el.modeSim.classList.toggle('active', sim);
  el.modeGps.setAttribute('aria-selected', String(!sim));
  el.modeSim.setAttribute('aria-selected', String(sim));
  el.panel.classList.remove('arrived');
  if (!sim) startGps();
  // Ohne simulierte Position das Suchfeld immer zeigen
  if (sim && !state.simPos) state.topOpen = true;
  applyTop();
  refresh(true);
  if (sim && !state.simPos) el.simInput.focus();
}

// Obere Leiste (GPS/Simulation-Umschalter und Suchfeld) ein-/ausblenden
function applyTop() {
  const open = state.topOpen;
  el.topbar.classList.toggle('collapsed', !open);
  el.simForm.classList.toggle('hidden', !(open && state.mode === 'sim'));
  el.settingsBtn.setAttribute('aria-pressed', String(open));
  if (!open) el.simInput.blur();
}

el.settingsBtn.addEventListener('click', () => {
  state.topOpen = !state.topOpen;
  applyTop();
});

/* ---------- Galerie am Heimatpunkt ---------- */
const gal = {
  root: $('gallery'), track: $('galleryTrack'), count: $('galleryCount'),
  prev: $('galleryPrev'), next: $('galleryNext'), close: $('galleryClose'),
};
let galBuilt = false;
function galIndex() {
  return Math.round(gal.track.scrollLeft / Math.max(1, gal.track.clientWidth));
}
function galUpdate() {
  const i = galIndex();
  gal.count.textContent = `${i + 1} / ${GALLERY.length}`;
  gal.prev.disabled = i <= 0;
  gal.next.disabled = i >= GALLERY.length - 1;
}
function galGo(delta) {
  const i = Math.min(GALLERY.length - 1, Math.max(0, galIndex() + delta));
  gal.track.scrollTo({ left: i * gal.track.clientWidth, behavior: 'smooth' });
}
function openGallery() {
  if (!galBuilt) {
    GALLERY.forEach((src, i) => {
      const slide = document.createElement('div');
      slide.className = 'gallery-slide';
      const img = document.createElement('img');
      img.src = src;
      img.alt = `Bild ${i + 1} von ${GALLERY.length}`;
      img.loading = i < 2 ? 'eager' : 'lazy';
      img.decoding = 'async';
      slide.appendChild(img);
      gal.track.appendChild(slide);
    });
    galBuilt = true;
  }
  gal.root.classList.remove('hidden');
  document.body.classList.add('gallery-open');
  gal.track.scrollLeft = 0;
  galUpdate();
  gal.close.focus();
}
function closeGallery() {
  gal.root.classList.add('hidden');
  document.body.classList.remove('gallery-open');
  dismissGalleryButton();
}

/* ---------- Galerie-Knopf ----------
 * Wird der obere Ring grün, materialisiert sich im Ring ein Galerie-Knopf,
 * fliegt kurz darauf in einem leichten Bogen über die Knopfspalte und bleibt
 * dort, bis die Galerie geschlossen wird. Ist er schon da, passiert nichts. */
const galleryBtn = $('galleryBtn');
let galleryBtnState = 'hidden'; // hidden | arriving | docked | leaving
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function summonGalleryButton() {
  if (galleryBtnState !== 'hidden') return;
  galleryBtnState = 'arriving';
  const ring = el.ringTop.getBoundingClientRect();
  const size = 44;
  // 1) Im oberen Ring materialisieren
  galleryBtn.classList.remove('hidden', 'dematerializing');
  galleryBtn.classList.add('flying', 'materializing');
  galleryBtn.style.left = `${ring.left + ring.width / 2 - size / 2}px`;
  galleryBtn.style.top = `${ring.top + ring.height / 2 - size / 2}px`;
  document.body.appendChild(galleryBtn);

  // 2) Nach kurzer Pause im Bogen zur Knopfspalte fliegen
  setTimeout(() => {
    if (galleryBtnState !== 'arriving') return;
    galleryBtn.classList.remove('materializing');
    const nav = document.querySelector('.side-btns');
    const first = nav.firstElementChild.getBoundingClientRect();
    const start = galleryBtn.getBoundingClientRect();
    const end = { left: first.left, top: first.top - 10 - size };
    const dx = end.left - start.left;
    const dy = end.top - start.top;
    const dock = () => {
      galleryBtn.classList.remove('flying');
      galleryBtn.style.left = galleryBtn.style.top = galleryBtn.style.transform = '';
      nav.insertBefore(galleryBtn, nav.firstChild);
      galleryBtnState = 'docked';
    };
    if (reducedMotion() || !galleryBtn.animate) { dock(); return; }
    // Leichter Bogen: quadratische Bézierkurve mit seitlich versetztem Kontrollpunkt
    const cx = dx * 0.5 + dy * 0.18;
    const cy = dy * 0.5 - dx * 0.18;
    const frames = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const x = 2 * (1 - t) * t * cx + t * t * dx;
      const y = 2 * (1 - t) * t * cy + t * t * dy;
      frames.push({ transform: `translate(${x}px, ${y}px)` });
    }
    const anim = galleryBtn.animate(frames, { duration: 900, easing: 'ease-in-out', fill: 'forwards' });
    anim.onfinish = () => { anim.cancel(); dock(); };
  }, 700);
}

function dismissGalleryButton() {
  if (galleryBtnState === 'hidden' || galleryBtnState === 'leaving') return;
  galleryBtnState = 'leaving';
  galleryBtn.classList.remove('materializing');
  galleryBtn.classList.add('dematerializing');
  setTimeout(() => {
    galleryBtn.classList.add('hidden');
    galleryBtn.classList.remove('dematerializing', 'flying');
    galleryBtnState = 'hidden';
  }, reducedMotion() ? 20 : 500);
}

galleryBtn.addEventListener('click', () => {
  if (galleryBtnState === 'leaving') return;
  openGallery();
});
gal.close.addEventListener('click', closeGallery);
gal.prev.addEventListener('click', () => galGo(-1));
gal.next.addEventListener('click', () => galGo(1));
gal.track.addEventListener('scroll', () => requestAnimationFrame(galUpdate), { passive: true });
document.addEventListener('keydown', (e) => {
  if (gal.root.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeGallery();
  else if (e.key === 'ArrowLeft') galGo(-1);
  else if (e.key === 'ArrowRight') galGo(1);
});

/* ---------- Virtuelle Tastatur ---------- */
// Während der Eingabe das Kompass-Panel ausblenden und die oberen Elemente
// am sichtbaren Bereich ausrichten (iOS verschiebt diesen bei Tastatur).
const rootStyle = document.documentElement.style;
function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  rootStyle.setProperty('--vv-top', `${Math.max(0, vv.offsetTop)}px`);
  rootStyle.setProperty('--vv-h', `${vv.height}px`);
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', syncViewport);
  visualViewport.addEventListener('scroll', syncViewport);
  syncViewport();
}
el.simInput.addEventListener('focus', () => document.body.classList.add('typing'));
el.simInput.addEventListener('blur', () => {
  document.body.classList.remove('typing');
  // iOS: eventuell verschobene Seite zurücksetzen
  setTimeout(() => { window.scrollTo(0, 0); syncViewport(); }, 50);
});

function setSimPos(lat, lon, label) {
  state.simPos = { lat, lon, label };
  refresh(true);
}

/* ---------- Position teilen / geteilte Position übernehmen ---------- */
// Erkennt Koordinaten in eingefügtem Text: App-Link (?pos=…&t=…),
// Kartenlinks (…@51.7,9.0 / q=51.7,9.0) oder einfach "51.71890, 8.75750".
function parseSharedPosition(text) {
  if (!text) return null;
  let m = text.match(/[?&#]pos=(-?\d+(?:\.\d+)?)(?:,|%2C)(-?\d+(?:\.\d+)?)/i);
  if (!m) m = text.match(/(-?\d{1,2}\.\d{3,})\s*[,;]?\s*(-?\d{1,3}\.\d{3,})/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  const t = text.match(/[?&#]t=(\d{10,13})/);
  let time = null;
  if (t) {
    time = parseInt(t[1], 10);
    if (time < 1e12) time *= 1000; // Sekunden -> Millisekunden
    if (time > Date.now() + 5 * 60000) time = null; // unplausibel (Zukunft)
  }
  return { lat, lon, time };
}

function applySharedPosition(p) {
  const label = p.time ? `geteilt, Stand ${formatTime(p.time)} Uhr` : `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
  [...el.simResults.children].forEach((c) => c.remove());
  state.simPos = { lat: p.lat, lon: p.lon, label, time: p.time };
  if (state.mode !== 'sim') setMode('sim');
  else refresh(true);
}

let toastTimer = null;
function showToast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add('hidden'), 3000);
}

// Einmalige GPS-Abfrage, falls beim Teilen noch keine Position vorliegt
function getGpsOnce(timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Keine Ortung verfügbar'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 },
    );
  });
}

const sheet = {
  root: $('shareSheet'), text: $('shareText'), wa: $('shareWhatsApp'),
  native: $('shareNative'), copy: $('shareCopy'), cancel: $('shareCancel'),
};
let pendingShare = null;

function buildShare(pos) {
  const lat = pos.lat.toFixed(5);
  const lon = pos.lon.toFixed(5);
  // Bei weitergeteilter Position den ursprünglichen Zeitstempel behalten
  const stamp = (state.mode === 'sim' && state.simPos?.time) ? state.simPos.time : Date.now();
  const url = `${location.origin}${location.pathname}?pos=${lat},${lon}&t=${Math.round(stamp / 1000)}`;
  let text = state.mode === 'gps'
    ? `Ich bin auf dem Weg nach Hause (Stand ${formatTime(stamp)} Uhr)`
    : `Position auf dem Weg nach Hause (Stand ${formatTime(stamp)} Uhr)`;
  if (state.home) text += ` – noch ${formatDistance(distanceMeters(pos, state.home))} Luftlinie`;
  text += `.\nPosition: ${lat}, ${lon}`;
  return { title: 'Coming Home – Position', text, url, full: `${text}\n${url}` };
}

function openShareSheet(share) {
  pendingShare = share;
  sheet.text.textContent = share.full;
  sheet.wa.href = `https://wa.me/?text=${encodeURIComponent(share.full)}`;
  sheet.native.classList.toggle('hidden', !navigator.share);
  sheet.root.classList.remove('hidden');
}
function closeShareSheet() { sheet.root.classList.add('hidden'); }

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback für Browser ohne Clipboard-API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
}

async function nativeShare(share) {
  await navigator.share({ title: share.title, text: share.text, url: share.url });
}

sheet.cancel.addEventListener('click', closeShareSheet);
sheet.root.addEventListener('click', (e) => { if (e.target === sheet.root) closeShareSheet(); });
sheet.wa.addEventListener('click', () => setTimeout(closeShareSheet, 300));
sheet.copy.addEventListener('click', async () => {
  if (!pendingShare) return;
  const ok = await copyText(pendingShare.full);
  showToast(ok ? 'Text kopiert – jetzt z. B. in WhatsApp einfügen.' : 'Kopieren nicht möglich – Text bitte markieren und kopieren.');
  if (ok) closeShareSheet();
});
sheet.native.addEventListener('click', async () => {
  if (!pendingShare) return;
  try {
    await nativeShare(pendingShare);
    closeShareSheet();
  } catch (err) {
    if (err?.name !== 'AbortError') showToast(`Teilen nicht möglich (${err?.name || err}).`);
  }
});

el.shareBtn.addEventListener('click', async () => {
  try {
    let pos = currentPos();
    if (!pos && state.mode === 'gps') {
      showToast('Ermittle GPS-Position …');
      try {
        pos = await getGpsOnce();
        state.gpsPos = pos;
        refresh();
      } catch (_) {
        showToast('Keine GPS-Position verfügbar – Standortfreigabe prüfen.');
        return;
      }
    }
    if (!pos) {
      showToast('Noch keine simulierte Position – bitte Adresse eingeben oder auf die Karte tippen.');
      return;
    }
    const share = buildShare(pos);
    openShareSheet(share);
  } catch (err) {
    console.error(err);
    showToast(`Fehler beim Teilen: ${err?.message || err}`);
  }
});

let lastSearch = 0;
el.simForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = el.simInput.value.trim();
  if (!q) return;
  const shared = parseSharedPosition(q);
  if (shared) {
    applySharedPosition(shared);
    el.simInput.blur();
    return;
  }
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
  // Position liegt nicht mehr im unteren Ring -> nicht mehr kalibriert
  setCalibrated(false);
});

/* ---------- Kartenkacheln vorab laden (offline) ---------- */
// Lädt die Kacheln rund um die aktuelle Position großzügig vor
// (aktuelle Zoomstufe sowie eine darüber und darunter). Der Service Worker
// speichert sie; danach kommen sie ohne Netz aus dem Cache.
let lastPrefetch = null;
let prefetchTimer = null;
let prefetchNotified = false;

function schedulePrefetch() {
  clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(prefetchTiles, 1500);
}

function tileUrlsAround(latlng, z, radiusPx) {
  const urls = [];
  const n = 2 ** z;
  const c = map.project(latlng, z);
  const x0 = Math.floor((c.x - radiusPx) / 256), x1 = Math.floor((c.x + radiusPx) / 256);
  const y0 = Math.max(0, Math.floor((c.y - radiusPx) / 256)), y1 = Math.min(n - 1, Math.floor((c.y + radiusPx) / 256));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x + 0.5) * 256 - c.x, dy = (y + 0.5) * 256 - c.y;
      if (Math.hypot(dx, dy) > radiusPx + 182) continue; // nur Kreisfläche
      const wx = ((x % n) + n) % n;
      for (const t of TILE_URLS) urls.push(t.replace('{z}', z).replace('{y}', y).replace('{x}', wx));
    }
  }
  return urls;
}

function prefetchTiles() {
  const sw = navigator.serviceWorker?.controller;
  const pos = currentPos() || state.home;
  if (!sw || !pos) return;
  const Z = Math.max(3, Math.min(19, Math.round(map.getZoom())));
  const size = map.getSize();
  const radius = 1.5 * Math.hypot(size.x, size.y); // großzügig: 1,5 × Bildschirmdiagonale
  const mPerPx = 40075016 * Math.cos(pos.lat * Math.PI / 180) / (256 * 2 ** Z);
  // Nur neu laden, wenn Zoomstufe gewechselt oder ein gutes Stück bewegt
  if (lastPrefetch && lastPrefetch.z === Z && distanceMeters(lastPrefetch, pos) < radius * mPerPx / 3) return;
  lastPrefetch = { lat: pos.lat, lon: pos.lon, z: Z };
  const ll = L.latLng(pos.lat, pos.lon);
  const urls = [
    ...tileUrlsAround(ll, Z, radius),
    ...(Z > 3 ? tileUrlsAround(ll, Z - 1, radius / 2) : []),
    ...(Z < 19 ? tileUrlsAround(ll, Z + 1, radius) : []), // halber Radius (geographisch)
  ];
  sw.postMessage({ type: 'prefetch', urls });
}

navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type !== 'prefetch-done' || prefetchNotified) return;
  const { total, failed, loaded } = e.data;
  if (total && failed === total) {
    prefetchNotified = true;
    showToast('Karte konnte nicht offline vorgeladen werden.');
  } else if (loaded > 0) {
    prefetchNotified = true;
    showToast(`Karte für die Umgebung offline gespeichert (${loaded} Kacheln).`);
  }
});
map.on('moveend', () => schedulePrefetch());

// Ändert sich die Höhe des Kompassbereichs (z. B. andere Statuszeilen),
// verschiebt sich der untere Ring -> neu ausrichten.
if ('ResizeObserver' in window) {
  new ResizeObserver(() => { if (state.calibrated) calibrate(); }).observe(el.panel);
}

/* ---------- Ankunft: Feuerwerk ---------- */
// Einmal pro Ankunft; erneut erst, nachdem man sich wieder > 60 m entfernt hat.
// Ankunft = die beiden Ringe berühren sich (Abstand der Mittelpunkte <= Ring-
// durchmesser). Dann: Feuerwerk + Vibration und „Ankunftsmodus“ – bis man sich
// wieder über LEAVE_METERS entfernt, laufen nur noch Kompass und Kartendrehung
// (keine Positionssprünge, kein Einrasten/Grünfärben, kein Galerie-Knopf).
function arrivalMeters() {
  return NEAR_METERS * RING_DIAMETER / Math.max(1, lastRingSpan);
}
function checkArrival(dist) {
  if (!state.arrivedMode && dist <= arrivalMeters()) {
    state.arrivedMode = true;
    resetHomeLock();
    fireworks(10000);
    if (navigator.vibrate) {
      // Rhythmisch vibrieren, passend zu den Raketen (ca. 10 s)
      const pattern = [];
      for (let t = 0; t < 10000; t += 700) pattern.push(350, 350);
      try { navigator.vibrate(pattern); } catch (_) { /* nicht unterstützt */ }
    }
  } else if (state.arrivedMode && dist > LEAVE_METERS) {
    state.arrivedMode = false;
  }
}

function fireworks(duration) {
  // Transparenter Hintergrund: Es wird jedes Bild komplett gelöscht und nur
  // die Funken (mit kurzen Schweifen) gezeichnet – die Karte bleibt sichtbar.
  const canvas = document.createElement('canvas');
  canvas.className = 'fireworks';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = innerWidth, H = innerHeight;
  const resize = () => {
    W = innerWidth; H = innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);
  const colors = ['#ff5a3c', '#ffc857', '#3ddc84', '#2f80ff', '#b45cff', '#ffffff', '#ff7ab6', '#4de1ff'];
  const rockets = [];
  const sparks = [];
  const start = performance.now();
  let lastLaunch = 0;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const scale = Math.min(W, H) / 390; // größer auf größeren Bildschirmen

  function launch() {
    // Zielpunkt irgendwo auf dem ganzen Bildschirm
    const tx = W * (0.05 + Math.random() * 0.9);
    const ty = H * (0.08 + Math.random() * 0.7);
    const x = tx + (Math.random() - 0.5) * W * 0.2;
    const frames = 45 + Math.random() * 20;
    rockets.push({ x, y: H + 10, tx, ty, vx: (tx - x) / frames, vy: (ty - H - 10) / frames, n: frames,
      color: colors[Math.floor(Math.random() * colors.length)], color2: colors[Math.floor(Math.random() * colors.length)] });
  }
  function explode(r) {
    const n = 110 + Math.floor(Math.random() * 70);
    const power = (4 + Math.random() * 3.5) * scale;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = power * (0.35 + Math.random() * 0.65);
      sparks.push({ x: r.x, y: r.y, px: r.x, py: r.y, vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 1, decay: 0.008 + Math.random() * 0.008, color: Math.random() < 0.5 ? r.color : r.color2, w: 1.5 + Math.random() * 1.8 });
    }
  }
  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    const gap = reduced ? 900 : 260;
    if (t < duration - 1800 && now - lastLaunch > gap) {
      launch();
      if (!reduced && Math.random() < 0.45) launch(); // oft zwei auf einmal
      lastLaunch = now;
    }
    ctx.lineCap = 'round';
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(r.x, r.y); r.x += r.vx; r.y += r.vy; ctx.lineTo(r.x, r.y); ctx.stroke();
      if (--r.n <= 0) { explode(r); rockets.splice(i, 1); }
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i];
      p.px = p.x; p.py = p.y;
      p.x += p.vx; p.y += p.vy; p.vy += 0.06 * scale; p.vx *= 0.975; p.vy *= 0.975;
      p.life -= p.decay;
      if (p.life <= 0) { sparks.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, p.life * 1.4);
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.w;
      // Schweif: Linie vom vorherigen Punkt, etwas verlängert
      ctx.beginPath(); ctx.moveTo(p.px - p.vx * 2, p.py - p.vy * 2); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (t < duration) requestAnimationFrame(frame);
    else {
      canvas.classList.add('done');
      setTimeout(() => { window.removeEventListener('resize', resize); canvas.remove(); }, 600);
    }
  }
  requestAnimationFrame(frame);
}

/* ---------- Start-Hinweis ---------- */
// Wird bei jedem Start gezeigt. Das Tippen auf „Verstanden“ dient zugleich
// als Nutzeraktion für die Kompass-Freigabe (iPhone) und versucht, die
// Bildschirmdrehung auf Hochformat zu sperren (klappt nur in manchen Browsern).
function showStartHint() {
  const hint = $('startHint');
  hint.classList.remove('hidden');
  $('startHintOk').addEventListener('click', async () => {
    hint.classList.add('hidden');
    if (state.heading === null && compassState === 'needs-permission') requestCompassPermission();
    try { await screen.orientation?.lock?.('portrait'); } catch (_) { /* nicht unterstützt */ }
  }, { once: true });
}

/* ---------- Start ---------- */
el.modeGps.addEventListener('click', () => setMode('gps'));
el.modeSim.addEventListener('click', () => setMode('sim'));
el.fitBtn.addEventListener('click', () => calibrate());
window.addEventListener('resize', () => {
  if (state.calibrated && !document.body.classList.contains('typing')) calibrate();
});

(async function main() {
  showStartHint();
  // Mit geteiltem Link geöffnet? Dann direkt die geteilte Position zeigen.
  const shared = /[?&]pos=/.test(location.search) ? parseSharedPosition(location.search) : null;
  applyTop();
  render();
  initCompass();
  if (!shared) startGps();
  await loadHome();
  if (shared) applySharedPosition(shared);
  refresh(true);
})();

// Altersangabe der geteilten Position aktuell halten
setInterval(() => { if (state.mode === 'sim' && state.simPos?.time) render(); }, 30000);

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
