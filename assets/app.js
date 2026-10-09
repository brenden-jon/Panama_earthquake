/* Panama earthquake monitor — client app. Plain JS, no build step. */
(() => {
"use strict";

const EVENT_ID = "us6000u18k";
const EPI = [7.5868, -80.769];
const T0 = Date.parse("2026-10-09T17:56:06Z");
const DATA_REFRESH_MS = 5 * 60 * 1000;
const QUAKE_REFRESH_MS = 2 * 60 * 1000;
const USGS_AFTERSHOCKS = "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2026-10-09T17:50:00" +
  "&minlatitude=5.5&maxlatitude=10&minlongitude=-83.5&maxlongitude=-78&minmagnitude=2.5&orderby=time";

// USGS standard MMI colours (domain convention)
const MMI_COLORS = { 1: "#ffffff", 2: "#bfccff", 3: "#a0e6ff", 4: "#80ffff", 5: "#7aff93", 6: "#ffff00", 7: "#ffc800", 8: "#ff9100", 9: "#ff0000", 10: "#c80000" };
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const mmiColor = v => MMI_COLORS[Math.max(1, Math.min(10, Math.round(v)))];

const CAT_GROUP = {
  fatalities: "damage", injuries: "damage", building_damage: "damage", landslide: "damage", displacement: "damage",
  infrastructure: "infra", utilities: "infra", tsunami: "infra",
  response: "other", aftershock: "other", other: "other",
};
const CAT_LABEL = {
  fatalities: "Fatalities", injuries: "Injuries", building_damage: "Building damage", landslide: "Landslide",
  displacement: "Displacement", infrastructure: "Infrastructure", utilities: "Utilities", tsunami: "Tsunami",
  response: "Response", aftershock: "Aftershocks", other: "Other",
};
const CONF_LABEL = { official: "Official", multiple_sources: "Multiple sources", single_source: "Single source", unverified: "Unverified" };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const groupColor = g => cssVar(g === "damage" ? "--series-2" : g === "infra" ? "--series-1" : "--series-3");

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => n == null ? "–" : Math.round(n).toLocaleString("en-US");
const fmtK = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : fmt(n);
const roundTo = (n, s) => Math.round(n / s) * s;
const tzFmt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Panama", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const localTime = iso => iso ? tzFmt.format(new Date(iso)) + " local" : "time n/a";
function ago(iso) {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + " min ago";
  const h = Math.floor(m / 60);
  return h < 48 ? h + " h " + (m % 60) + " min ago" : Math.round(h / 24) + " days ago";
}
const sinceEq = t => { const h = (t - T0) / 3.6e6; return h < 1 ? Math.round(h * 60) + " min" : h.toFixed(1) + " h"; };

const state = { reports: [], summary: null, highlights: null, districts: [], news: null, status: null, quakes: null, mmiGrid: null, adm2: null, contours: null };
const maps = {};

// ---------- theme ----------
(function theme() {
  let t = null;
  try { t = localStorage.getItem("theme"); } catch (e) {}
  if (t) document.documentElement.dataset.theme = t;
  $("#theme-btn").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) {}
    Object.values(maps).forEach(m => m._setBase && m._setBase());
    renderAll();
  });
})();
const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;

// ---------- tabs ----------
function showTab() {
  const id = (location.hash || "#overview").slice(1);
  const valid = ["overview", "map", "impacts", "news", "risk", "sources"];
  const tab = valid.includes(id) ? id : "overview";
  document.querySelectorAll(".tab").forEach(s => s.classList.toggle("active", s.id === "tab-" + tab));
  document.querySelectorAll(".tabs a").forEach(a => a.classList.toggle("active", a.dataset.tab === tab));
  if (tab === "map") initBigMap();
  if (tab === "risk") initRiskMap();
  if (tab === "overview") initMiniMap();
  setTimeout(() => Object.values(maps).forEach(m => m.invalidateSize()), 50);
  window.scrollTo({ top: 0 });
}
window.addEventListener("hashchange", showTab);

// ---------- data ----------
async function getJSON(url, bust = true) {
  const r = await fetch(url + (bust ? (url.includes("?") ? "&" : "?") + "t=" + Date.now() : ""), { cache: "no-store" });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}
async function loadData() {
  const [rep, sum, hl, dist, news, status] = await Promise.allSettled([
    getJSON("data/reports.json"), getJSON("data/summary.json"), getJSON("data/highlights.json"),
    getJSON("data/districts.json"), getJSON("data/news_feed.json"), getJSON("data/usgs_status.json"),
  ]);
  if (rep.status === "fulfilled") state.reports = rep.value.reports;
  if (sum.status === "fulfilled") state.summary = sum.value;
  if (hl.status === "fulfilled") state.highlights = hl.value;
  if (dist.status === "fulfilled") state.districts = dist.value;
  if (news.status === "fulfilled") state.news = news.value;
  if (status.status === "fulfilled") state.status = status.value;
  if (!state.mmiGrid) {
    const [g, a, c] = await Promise.allSettled([getJSON("data/risk/mmi_grid.geojson", false), getJSON("data/risk/adm2.geojson", false), getJSON("data/usgs/cont_mmi.json")]);
    if (g.status === "fulfilled") state.mmiGrid = g.value;
    if (a.status === "fulfilled") state.adm2 = a.value;
    if (c.status === "fulfilled") state.contours = c.value;
  }
}
async function loadQuakes() {
  try {
    state.quakes = await getJSON(USGS_AFTERSHOCKS, false);
    state.quakesLive = true;
  } catch (e) {
    try { state.quakes = await getJSON("data/usgs/aftershocks.geojson"); } catch (e2) {}
    state.quakesLive = false;
  }
}

// ---------- overview ----------
function renderOverview() {
  const h = state.highlights, s = state.summary;
  if (h) {
    $("#headline").textContent = h.headline;
    $("#upcoming").textContent = h.upcoming || "";
    $("#key-points").innerHTML = h.key_points.map(p => `<li>${esc(p)}</li>`).join("");
    $("#areas").innerHTML = h.areas.map(a => `<div class="area"><h4>${esc(a.area)} <span class="badge b-${a.status}">${statusIcon(a.status)} ${esc(a.status)}</span></h4>${esc(a.text)}</div>`).join("");
    $("#services").innerHTML = h.services.map(v => `<div class="svc"><div class="h">${esc(v.sector)} <span class="badge b-${v.status}">${statusIcon(v.status)} ${esc(v.status)}</span></div>${esc(v.text)}<div class="src">${esc(v.source)}</div></div>`).join("");
  }
  if (s) {
    const o = s.official_latest || {};
    const tiles = [
      ["Deaths", o.deaths], ["Injured", o.injured], ["Missing", o.missing],
      ["Displaced / in shelters", o.displaced], ["Homes damaged", o.homes_damaged], ["Homes destroyed", o.homes_destroyed],
    ];
    $("#official-tiles").innerHTML = tiles.map(([l, v]) => `<div class="tile"><div class="label">${l}</div>${v == null ? `<div class="value na">Not yet reported</div>` : `<div class="value">${fmt(v)}</div>`}<div class="foot">${o.as_of_utc ? "as of " + localTime(o.as_of_utc) : ""}</div></div>`).join("");
    $("#official-note").innerHTML = o.note ? `${esc(o.note)} <span class="muted">Source: <a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.source_name)}</a></span>` : "";

    const p = s.pager, e = s.exposure;
    const pop7lo = Math.min(e.pop_mmi7plus, sumArr(p.pop_exposure_pa_by_mmi.slice(6)));
    const pop7hi = Math.max(e.pop_mmi7plus, sumArr(p.pop_exposure_pa_by_mmi.slice(6)));
    const fatTop = topBin(p.fatality_bins), econTop = topBin(p.economic_bins);
    $("#model-tiles").innerHTML = [
      { cls: "alert-" + p.fatality_alert, l: "Fatalities — most likely range", v: binLabel(fatTop, false), f: `USGS PAGER ${p.fatality_alert} alert · ${Math.round(fatTop.probability * 100)}% probability` },
      { cls: "alert-" + p.economic_alert, l: "Economic losses — most likely", v: "US$" + binLabel(econTop, true), f: `USGS PAGER ${p.economic_alert} alert · median ~US$${(p.losses_usd_empirical / 1e9).toFixed(1)} bn` },
      { cls: "", l: "People in very strong shaking (MMI VII+)", v: `${fmtK(roundTo(pop7lo, 1000))}–${fmtK(roundTo(pop7hi, 1000))}`, f: "Census 2023-scaled & PAGER estimates" },
      { cls: "", l: "Buildings with moderate+ damage", v: `${fmtK(roundTo(e.dmg_mod_lo, 1000))}–${fmtK(roundTo(e.dmg_mod_hi, 1000))}`, f: `incl. ${fmtK(roundTo(e.dmg_heavy_lo, 100))}–${fmtK(roundTo(e.dmg_heavy_hi, 100))} heavy damage / collapse · indicative` },
    ].map(t => `<div class="tile ${t.cls}"><div class="label">${t.l}</div><div class="value">${t.v}</div><div class="foot">${t.f}</div></div>`).join("");
    pagerBars("#pager-fat", p.fatality_bins, false);
    pagerBars("#pager-econ", p.economic_bins, true);

    const c = s.conflicts || [];
    $("#conflict-box").innerHTML = c.length ? `<strong>Conflicting information</strong><ul>${c.slice(0, 5).map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  }
  const st = state.status || {};
  const q = state.quakes ? state.quakes.features.filter(f => f.properties.time > T0 + 1000) : [];
  const big = q.slice().sort((a, b) => b.properties.mag - a.properties.mag)[0];
  $("#event-facts").innerHTML = `
    <dt>Magnitude</dt><dd>M${st.mag || 7.7} (USGS) · M7.2 (Instituto de Geociencias, UP)</dd>
    <dt>Time</dt><dd>9 Oct 2026, 12:56 local · 17:56 UTC <span class="muted">(${sinceEq(Date.now())} ago)</span></dd>
    <dt>Epicentre</dt><dd>7.59°N 80.77°W · southern Azuero Peninsula, ~12 km WSW of Pitaloza Arriba (Los Santos/Herrera)</dd>
    <dt>Depth</dt><dd>12.6 km (shallow)</dd>
    <dt>Max. intensity</dt><dd><span class="mmi-chip" style="background:${mmiColor(8.7)}">VIII–IX</span> modelled (ShakeMap); ${fmt(st.felt || 533)} "Did You Feel It?" reports</dd>
    <dt>Aftershocks</dt><dd>${q.length} of M2.5+ in USGS catalogue${big ? `, largest M${big.properties.mag.toFixed(1)} (${esc(big.properties.place)})` : ""}. IGC-UP reports 30+ incl. M6.4.</dd>
    <dt>Alerts</dt><dd>USGS PAGER <b style="color:var(--critical)">red</b> (economic) · GDACS ${esc((st.gdacs && st.gdacs[0] && st.gdacs[0].alert) || "Orange")} · tsunami threat lifted</dd>`;

  const withImg = state.reports.filter(r => r.image_url && r.image_verdict !== "event").sort((a, b) => (a.image_verdict === "damage" ? 0 : 1) - (b.image_verdict === "damage" ? 0 : 1));
  $("#thumbs").innerHTML = withImg.slice(0, 9).map(r => `<figure data-img="${esc(r.image_url)}" data-cap="${esc(r.title)}" data-url="${esc(r.url)}"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(r.image_url)}" alt="${esc(r.title)}" onerror="this.closest('figure').remove()"><figcaption>${esc(r.place)}</figcaption></figure>`).join("");
  const items = state.news ? state.news.items.slice(0, 9) : [];
  $("#headlines").innerHTML = items.map(n => `<li><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a><div class="meta">${esc(n.source)} · ${ago(n.published_utc)}</div></li>`).join("") || `<li class="muted">No headlines yet.</li>`;
}
const sumArr = a => a.reduce((x, y) => x + y, 0);
const topBin = bins => bins.reduce((a, b) => (b.probability > a.probability ? b : a));
function binLabel(b, money) {
  const n = v => { v = +v; return money ? (v >= 1000 ? (v / 1000) + " bn" : v + " M") : v.toLocaleString("en-US"); };
  if (+b.max >= 10000000) return n(b.min) + "+";
  if (+b.min === 0) return money ? "< 1 M" : "0";
  if (money && +b.min < 1000 && +b.max >= 1000) return `${n(b.min)}–${n(b.max)}`;
  return money ? `${+b.min >= 1000 ? +b.min / 1000 : b.min}–${n(b.max)}` : `${n(b.min)}–${n(b.max)}`;
}
const PAGER_COL = { green: "--good", yellow: "--warning", orange: "--serious", red: "--critical" };
function pagerBars(sel, bins, money) {
  const max = Math.max(...bins.map(b => b.probability));
  const top = topBin(bins);
  $(sel).innerHTML = bins.map(b => `<div class="pbar${b === top ? " top" : ""}" data-tt="${esc(binLabel(b, money))}${money ? " US$" : " deaths"}: ${(b.probability * 100).toFixed(1)}% probability (PAGER ${b.color})">
    <span class="rng">${binLabel(b, money)}</span>
    <span class="track"><span class="fill" style="display:block;width:${(b.probability / max) * 100}%;background:var(${PAGER_COL[b.color]})"></span></span>
    <span class="pct">${Math.round(b.probability * 100)}%</span></div>`).join("");
}
function statusIcon(s) {
  return { severe: "▲", closed: "■", significant: "▲", disrupted: "◆", moderate: "●", reported: "●", operating: "✓" }[s] || "";
}

// ---------- maps ----------
function baseLayer(map) {
  let layer;
  map._setBase = () => {
    if (layer) map.removeLayer(layer);
    const style = isDark() ? "World_Dark_Gray" : "World_Light_Gray";
    const attr = "Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors · Shaking: USGS";
    layer = L.layerGroup([
      L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${style}_Base/MapServer/tile/{z}/{y}/{x}`, { attribution: attr, maxZoom: 16 }),
      L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${style}_Reference/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 16, pane: "shadowPane" }),
    ]).addTo(map);
    layer.eachLayer(l => l.options.pane !== "shadowPane" && l.bringToBack());
  };
  map._setBase();
}
function mmiLayer() {
  if (!state.mmiGrid) return L.layerGroup();
  return L.geoJSON(state.mmiGrid, {
    interactive: false,
    style: f => ({ stroke: false, fillColor: mmiColor(f.properties.mmi_min + 0.25), fillOpacity: f.properties.mmi_min < 5 ? 0.18 : 0.38 }),
  });
}
function contourLayer() {
  if (!state.contours) return L.layerGroup();
  return L.geoJSON(state.contours, {
    filter: f => f.properties.value >= 5,
    style: f => ({ color: "#555", weight: 0.8, opacity: 0.6, dashArray: f.properties.value % 1 ? "3 3" : null }),
    onEachFeature: (f, l) => { if (f.properties.value % 1 === 0) l.bindTooltip("MMI " + ROMAN[f.properties.value], { sticky: true }); },
  });
}
function epicentre() {
  return L.marker(EPI, { icon: L.divIcon({ className: "epi-icon", html: "★", iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 1000 })
    .bindPopup(`<div class="pop"><h4>M7.7 mainshock (USGS)</h4><div class="meta">9 Oct 2026 12:56 local · depth 12.6 km</div>12 km WSW of Pitaloza Arriba. <a href="https://earthquake.usgs.gov/earthquakes/eventpage/${EVENT_ID}" target="_blank" rel="noopener">USGS event page →</a></div>`);
}
function quakeLayer() {
  const g = L.layerGroup();
  if (!state.quakes) return g;
  state.quakes.features.forEach(f => {
    const p = f.properties, [lon, lat, dep] = f.geometry.coordinates;
    if (p.time < T0 + 1000) return; // mainshock shown as star
    const hrs = (Date.now() - p.time) / 3.6e6;
    L.circleMarker([lat, lon], {
      radius: Math.max(4, (p.mag - 2) * 3.2), color: "#fff", weight: 2, fillColor: hrs < 1 ? cssVar("--critical") : "#555", fillOpacity: 0.75,
    }).bindPopup(`<div class="pop"><h4>M${p.mag.toFixed(1)} aftershock</h4><div class="meta">${localTime(new Date(p.time).toISOString())} · ${sinceEq(p.time)} after mainshock · depth ${dep.toFixed(0)} km</div>${esc(p.place)}<br><a href="${esc(p.url)}" target="_blank" rel="noopener">USGS →</a></div>`)
      .bindTooltip(`M${p.mag.toFixed(1)} · ${ago(new Date(p.time).toISOString())}`).addTo(g);
  });
  return g;
}
function reportPopup(list) {
  const items = list.map(r => `<div class="item">
    ${r.image_url ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(r.image_url)}" alt="" data-img="${esc(r.image_url)}" data-cap="${esc(r.title)}" data-url="${esc(r.url)}" onerror="this.remove()">` : ""}
    ${r.image_caption ? `<div class="meta" style="font-style:italic">Photo: ${esc(r.image_caption)}</div>` : ""}
    <h4>${esc(r.title)}</h4>
    <div class="meta"><span class="cat cat-${CAT_GROUP[r.category] || "other"}">${esc(CAT_LABEL[r.category] || r.category)}</span> ${esc(r.place)} · ${r.reported_utc ? localTime(r.reported_utc) : "time n/a"} · <span class="conf conf-${r.confidence}">${esc(CONF_LABEL[r.confidence] || r.confidence)}</span></div>
    ${esc(r.summary)}<div style="margin-top:4px"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source_name)} →</a></div></div>`).join("");
  return `<div class="pop"><div class="multi">${items}</div></div>`;
}
function groupByPlace(reports) {
  const m = new Map();
  reports.filter(r => isFinite(r.lat) && isFinite(r.lon)).forEach(r => {
    const k = r.lat.toFixed(2) + "," + r.lon.toFixed(2);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  });
  return [...m.values()];
}
function reportLayers() {
  const dots = L.markerClusterGroup({ maxClusterRadius: 30, showCoverageOnHover: false, spiderfyOnMaxZoom: true });
  const photos = L.markerClusterGroup({ maxClusterRadius: 40, showCoverageOnHover: false, clusterPane: "photoPane",
    iconCreateFunction: c => {
      const ms = c.getAllChildMarkers(); const img = ms.find(m => m.options._img)?.options._img;
      return L.divIcon({ className: "", html: `<div class="photo-pin dmg" style="background-image:url('${esc(img)}');position:relative"><span class="n">${ms.length}</span></div>`, iconSize: [46, 46], iconAnchor: [23, 23] });
    } });
  const isPhotoPin = r => r.image_url && (!r.image_verdict || r.image_verdict === "damage");
  state.reports.forEach(r => {
    if (!isFinite(r.lat) || isPhotoPin(r)) return;
    const g = CAT_GROUP[r.category] || "other";
    const jitter = () => (Math.random() - 0.5) * 0.004;
    L.circleMarker([r.lat + jitter(), r.lon + jitter()], { radius: 7, color: "#fff", weight: 2, fillColor: groupColor(g), fillOpacity: 0.95 })
      .bindPopup(reportPopup([r]), { maxWidth: 340 }).bindTooltip(esc(r.place) + ": " + esc(r.title)).addTo(dots);
  });
  const photoRank = r => r.image_verdict === "damage" ? 0 : r.image_verdict === "event" ? 2 : 1;
  groupByPlace(state.reports.filter(isPhotoPin).sort((a, b) => photoRank(a) - photoRank(b))).forEach(list => {
    const r = list[0];
    L.marker([r.lat, r.lon], { _img: r.image_url, pane: "photoPane", icon: L.divIcon({ className: "", html: `<div class="photo-pin dmg" style="background-image:url('${esc(r.image_url)}');position:relative">${list.length > 1 ? `<span class="n">${list.length}</span>` : ""}</div>`, iconSize: [46, 46], iconAnchor: [23, 23] }) })
      .bindPopup(reportPopup(list), { maxWidth: 340 }).bindTooltip(`${esc(r.place)} · ${list.length} photo${list.length > 1 ? "s" : ""}`).addTo(photos);
  });
  return { dots, photos };
}
function damageLayer(metric = "dmg") {
  if (!state.adm2) return L.layerGroup();
  const by = Object.fromEntries(state.districts.map(d => [d.pcode, d]));
  const val = d => !d ? 0 : metric === "pop7" ? d.pop_mmi7plus : metric === "maxmmi" ? d.max_mmi : (d.dmg_mod_lo + d.dmg_mod_hi) / 2;
  const vals = state.districts.map(val).filter(v => v > 0);
  const max = Math.max(...vals);
  const ramp = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
  const color = v => {
    if (metric === "maxmmi") return v ? mmiColor(v) : "transparent";
    if (!v) return "transparent";
    const t = Math.sqrt(v / max);
    return ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))];
  };
  return L.geoJSON(state.adm2, {
    style: f => { const d = by[f.properties.adm2_pcode]; const v = val(d); return { color: isDark() ? "#555" : "#fff", weight: 0.8, fillColor: color(v), fillOpacity: v ? 0.78 : 0 }; },
    onEachFeature: (f, l) => {
      const d = by[f.properties.adm2_pcode];
      if (!d) return;
      l.bindTooltip(`<b>${esc(d.district)}</b>, ${esc(d.province)}<br>Pop. at MMI VII+: ${fmt(d.pop_mmi7plus)}<br>Buildings, moderate+ damage: ${fmt(d.dmg_mod_lo)}–${fmt(d.dmg_mod_hi)}<br>Heavy damage/collapse: ${fmt(d.dmg_heavy_lo)}–${fmt(d.dmg_heavy_hi)}<br>Max MMI ${d.max_mmi.toFixed(1)}${d.nonblock_share != null ? `<br>Non-block walls: ${(d.nonblock_share * 100).toFixed(0)}%` : ""}`, { sticky: true });
    },
  });
}
function initMiniMap() {
  if (maps.mini || !window.L) return;
  const m = maps.mini = L.map("mini-map", { zoomSnap: 0.25, scrollWheelZoom: false, zoomControl: true, dragging: !L.Browser.mobile, tap: false }).fitBounds([[7.15, -81.4], [9.1, -79.4]]);
  baseLayer(m);
  m._layers_ = {};
  refreshMapLayers(m, { mmi: true, quakes: true, reports: true, photos: false });
}
function initBigMap() {
  if (maps.big || !window.L) return;
  const m = maps.big = L.map("big-map", { zoomControl: true, zoomSnap: 0.25 }).fitBounds([[7.15, -81.6], [9.15, -79.3]]);
  baseLayer(m);
  m._layers_ = {};
  refreshMapLayers(m, layerToggles());
  document.querySelectorAll("#map-panel input[data-layer]").forEach(i => i.addEventListener("change", () => refreshMapLayers(m, layerToggles())));
  $("#mmi-legend").innerHTML = [4, 5, 6, 7, 8, 9].map(v => `<div style="background:${MMI_COLORS[v]}">${ROMAN[v]}</div>`).join("") +
    ["Light", "Moderate", "Strong", "V. strong", "Severe", "Violent"].map(t => `<span class="muted" style="font-size:9.5px">${t}</span>`).join("");
}
const layerToggles = () => Object.fromEntries([...document.querySelectorAll("#map-panel input[data-layer]")].map(i => [i.dataset.layer, i.checked]));
function refreshMapLayers(m, on) {
  if (!m.getPane("photoPane")) m.createPane("photoPane").style.zIndex = 640;
  Object.values(m._layers_).forEach(l => m.removeLayer(l));
  m._layers_ = {};
  if (on.mmi) { m._layers_.mmi = mmiLayer().addTo(m); m._layers_.cont = contourLayer().addTo(m); }
  if (on.damage) m._layers_.damage = damageLayer().addTo(m);
  if (on.quakes) m._layers_.quakes = quakeLayer().addTo(m);
  const { dots, photos } = reportLayers();
  if (on.reports) m._layers_.reports = dots.addTo(m);
  if (on.photos) m._layers_.photos = photos.addTo(m);
  m._layers_.epi = epicentre().addTo(m);
  if (m === maps.big) {
    const q = state.quakes ? state.quakes.features.filter(f => f.properties.time > T0 + 1000).length : 0;
    $("#quake-count").innerHTML = `${q} aftershocks M2.5+ (USGS). Red = last hour. ${state.quakesLive ? "Live from USGS, refreshed every 2 min." : "Cached copy."}`;
  }
}
function initRiskMap() {
  if (maps.risk || !window.L) return;
  const m = maps.risk = L.map("risk-map", { zoomSnap: 0.25, scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false }).fitBounds([[7.15, -81.6], [9.0, -79.6]]);
  baseLayer(m);
  const draw = () => {
    if (m._dmg) m.removeLayer(m._dmg);
    m._dmg = damageLayer($("#risk-metric").value).addTo(m);
    const cap = { dmg: "Indicative buildings with moderate or worse damage (mid-point), by district.", pop7: "Population exposed to MMI VII+ (very strong shaking), by district.", maxmmi: "Maximum modelled shaking intensity (MMI) in each district." };
    $("#risk-map-caption").textContent = cap[$("#risk-metric").value];
  };
  m._redraw = draw;
  $("#risk-metric").addEventListener("change", draw);
  epicentre().addTo(m);
  draw();
}

// ---------- impacts feed ----------
function populateFilters() {
  const cats = [...new Set(state.reports.map(r => r.category))].sort();
  const provs = [...new Set(state.reports.map(r => r.province).filter(Boolean))].sort();
  const confs = Object.keys(CONF_LABEL).filter(c => state.reports.some(r => r.confidence === c));
  const fill = (sel, opts, lbl) => { const cur = $(sel).value; $(sel).innerHTML = `<option value="">${lbl}</option>` + opts.map(o => `<option value="${esc(o[0])}">${esc(o[1])}</option>`).join(""); $(sel).value = cur; };
  fill("#f-cat", cats.map(c => [c, CAT_LABEL[c] || c]), "All categories");
  fill("#f-prov", provs.map(p => [p, p]), "All provinces");
  fill("#f-conf", confs.map(c => [c, CONF_LABEL[c]]), "Any confidence");
}
function renderFeed() {
  const q = $("#f-q").value.toLowerCase(), cat = $("#f-cat").value, prov = $("#f-prov").value, conf = $("#f-conf").value, img = $("#f-img").checked;
  const list = state.reports.filter(r =>
    (!cat || r.category === cat) && (!prov || r.province === prov) && (!conf || r.confidence === conf) && (!img || r.image_url) &&
    (!q || (r.title + " " + r.summary + " " + r.place + " " + r.district + " " + r.source_name).toLowerCase().includes(q)));
  $("#feed").innerHTML = list.map(r => {
    const g = CAT_GROUP[r.category] || "other";
    const figs = Object.entries(r.figures || {}).filter(([, v]) => v != null).map(([k, v]) => `${fmt(v)} ${k.replace(/_/g, " ")}`).join(" · ");
    return `<article class="rep">
      ${r.image_url ? `<div class="img" role="img" aria-label="${esc(r.title)}" data-img="${esc(r.image_url)}" data-cap="${esc(r.title)}" data-url="${esc(r.url)}"><img src="${esc(r.image_url)}" referrerpolicy="no-referrer" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.parentNode.remove()"></div>` : ""}
      <div class="body">
        <div class="meta"><span class="cat cat-${g}">${esc(CAT_LABEL[r.category] || r.category)}</span><span>${esc(r.place)}${r.province ? ", " + esc(r.province) : ""}</span></div>
        <h4>${esc(r.title)}</h4>
        <p>${esc(r.summary)}</p>
        ${figs ? `<div class="figs">${esc(figs)}</div>` : ""}
        <div class="src"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source_name)} →</a><span class="conf conf-${r.confidence}">${esc(CONF_LABEL[r.confidence] || r.confidence)}</span></div>
        <div class="meta">${r.reported_utc ? localTime(r.reported_utc) + " · " + ago(r.reported_utc) : "time not stated"} · ${esc(r.source_type)}</div>
      </div></article>`;
  }).join("") || `<p class="muted">No reports match.</p>`;
}
["#f-q", "#f-cat", "#f-prov", "#f-conf", "#f-img"].forEach(s => $(s).addEventListener("input", renderFeed));

// ---------- news stream ----------
function renderNews() {
  if (!state.news) return;
  const q = $("#n-q").value.toLowerCase(), lang = $("#n-lang").value;
  const lastVisit = state.lastVisit;
  const list = state.news.items.filter(n => (!lang || n.lang === lang) && (!q || (n.title + n.source).toLowerCase().includes(q)));
  $("#news-list").innerHTML = list.slice(0, 300).map(n => `<li><span class="lang">${esc(n.lang.toUpperCase())}</span><a class="t" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>${lastVisit && n.first_seen_utc > lastVisit ? '<span class="new">NEW</span>' : ""}
    <div class="meta">${esc(n.source)}${n.kind === "humanitarian" ? " · ReliefWeb" : ""} · ${localTime(n.published_utc)} · ${ago(n.published_utc)}</div></li>`).join("");
}
["#n-q", "#n-lang"].forEach(s => $(s).addEventListener("input", renderNews));

// ---------- risk ----------
function renderRisk() {
  const s = state.summary;
  if (!s) return;
  const e = s.exposure;
  $("#risk-tiles").innerHTML = [
    ["People at MMI VI+ (strong)", fmt(roundTo(e.pop_mmi6 + e.pop_mmi7plus, 1000)), "Census 2023-scaled WorldPop"],
    ["People at MMI VII+ (very strong)", fmt(roundTo(e.pop_mmi7plus, 1000)), `of which ${fmt(roundTo(e.pop_mmi8 + e.pop_mmi9, 100))} at VIII+`],
    ["Buildings at MMI VII+", fmt(roundTo(e.bldg_mmi7plus, 1000)), "Microsoft ML building footprints"],
    ["Buildings, moderate+ damage", `${fmtK(roundTo(e.dmg_mod_lo, 1000))}–${fmtK(roundTo(e.dmg_mod_hi, 1000))}`, "indicative range"],
    ["Buildings, heavy damage / collapse", `${fmtK(roundTo(e.dmg_heavy_lo, 100))}–${fmtK(roundTo(e.dmg_heavy_hi, 100))}`, "indicative range"],
  ].map(([l, v, f]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="foot">${f}</div></div>`).join("");

  // grouped bars: population and buildings per MMI class (two series, one axis each -> two bars normalised separately? no: separate scales are labelled)
  const rows = [[6, "VI"], [7, "VII"], [8, "VIII"], [9, "IX+"]];
  const pmax = Math.max(...rows.map(([m]) => e["pop_mmi" + m])), bmax = Math.max(...rows.map(([m]) => e["bldg_mmi" + m]));
  $("#mmi-chart").innerHTML = rows.map(([m, r]) => `<div class="bc-row"><span class="lbl"><span class="mmi-chip" style="background:${mmiColor(m)}">${r}</span></span>
    <div class="bc-bars">
      <div class="bc-bar" data-tt="MMI ${r}: ${fmt(e["pop_mmi" + m])} people"><span class="b" style="width:${(e["pop_mmi" + m] / pmax) * 80}%;background:var(--series-1)"></span><span class="v">${fmt(e["pop_mmi" + m])} people</span></div>
      <div class="bc-bar" data-tt="MMI ${r}: ${fmt(e["bldg_mmi" + m])} buildings"><span class="b" style="width:${(e["bldg_mmi" + m] / bmax) * 80}%;background:var(--series-2)"></span><span class="v">${fmt(e["bldg_mmi" + m])} buildings</span></div>
    </div></div>`).join("") +
    `<div class="bc-legend"><span style="--c:var(--series-1)">People</span><span style="--c:var(--series-2)">Buildings</span><span class="muted">Each series scaled to its own maximum; read values from labels.</span></div>`;

  const cols = [
    ["district", "District", d => esc(d.district)], ["province", "Province", d => esc(d.province)],
    ["max_mmi", "Max MMI", d => `<span class="mmi-chip" style="background:${mmiColor(d.max_mmi)}">${d.max_mmi.toFixed(1)}</span>`],
    ["pop_total", "Population", d => fmt(d.pop_total)], ["pop_mmi7plus", "Pop. MMI VII+", d => fmt(d.pop_mmi7plus)],
    ["bldg_mmi7plus", "Bldgs MMI VII+", d => fmt(d.bldg_mmi7plus)],
    ["nonblock_share", "Non-block walls", d => d.nonblock_share == null ? "–" : (d.nonblock_share * 100).toFixed(0) + "%"],
    ["dmg_mod", "Moderate+ damage", d => `${fmt(d.dmg_mod_lo)}–${fmt(d.dmg_mod_hi)}`],
    ["dmg_heavy", "Heavy / collapse", d => `${fmt(d.dmg_heavy_lo)}–${fmt(d.dmg_heavy_hi)}`],
    ["reports", "Reports", d => fmt(d.reports)],
  ];
  const sortKey = state.sortKey || "dmg_mod";
  const keyVal = (d, k) => k === "dmg_mod" ? d.dmg_mod_lo + d.dmg_mod_hi : k === "dmg_heavy" ? d.dmg_heavy_lo + d.dmg_heavy_hi : d[k];
  state.districts.forEach(d => { d.reports = state.reports.filter(r => r.district && r.district.toLowerCase() === d.district.toLowerCase()).length; });
  const rowsD = state.districts.slice().sort((a, b) => {
    const x = keyVal(a, sortKey), y = keyVal(b, sortKey);
    return typeof x === "string" ? x.localeCompare(y) : (y ?? -1) - (x ?? -1);
  });
  $("#dist-table").innerHTML = `<thead><tr>${cols.map(c => `<th data-k="${c[0]}">${c[1]}${c[0] === sortKey ? " ▾" : ""}</th>`).join("")}</tr></thead><tbody>${rowsD.map(d => `<tr>${cols.map(c => `<td>${c[2](d)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  $("#dist-table").querySelectorAll("th").forEach(th => th.addEventListener("click", () => { state.sortKey = th.dataset.k; renderRisk(); }));

  const R = e.rates;
  $("#rates-table").innerHTML = `<thead><tr><th>MMI</th><th>Moderate or worse</th><th>Heavy / collapse</th></tr></thead><tbody>${Object.entries(R).map(([m, r]) => `<tr><td><span class="mmi-chip" style="background:${mmiColor(+m)}">${ROMAN[m]}</span></td><td>${r[0] * 100}–${r[1] * 100}%</td><td>${(r[2] * 100).toFixed(1)}–${(r[3] * 100).toFixed(1)}%</td></tr>`).join("")}</tbody>`;

  $("#secondary").innerHTML = `
    <li><strong>Landslides:</strong> USGS ground-failure model: <b>orange</b> hazard alert (~97 km² aggregate area, ~470 people exposed). Hilly southern Azuero and Veraguas most susceptible. Roads to Torio/Arenas already reported cut.</li>
    <li><strong>Liquefaction:</strong> USGS alert orange; coastal plains and river deltas (Chitré–Monagrillo, Parita, Aguadulce) are susceptible.</li>
    <li><strong>Tsunami:</strong> PTWC threat message for Panama's coasts (1–3 m) later downgraded; no tsunami damage reported. Note the 1913 Azuero event triggered a submarine slide that cut a telegraph cable.</li>
    <li><strong>Aftershocks:</strong> M6+ aftershocks remain possible in the coming days; damaged buildings may be further weakened.</li>`;
}

// ---------- sources ----------
function renderSources() {
  const items = [
    ["USGS event page, ShakeMap, PAGER, DYFI, ground failure", "https://earthquake.usgs.gov/earthquakes/eventpage/us6000u18k"],
    ["USGS earthquake catalogue API (aftershocks, live)", "https://earthquake.usgs.gov/fdsnws/event/1/"],
    ["GDACS", "https://www.gdacs.org/"],
    ["Instituto de Geociencias, Universidad de Panamá", "https://www.facebook.com/IGCUP/"],
    ["SINAPROC (civil protection)", "https://www.sinaproc.gob.pa/"],
    ["Population: WorldPop 2025 constrained 100 m (R2025A)", "https://www.worldpop.org/"],
    ["Population: INEC Censo 2023 via Esri Panama Living Atlas", "https://www.inec.gob.pa/"],
    ["Buildings: Microsoft Global ML Building Footprints (2026 release)", "https://github.com/microsoft/GlobalMLBuildingFootprints"],
    ["Housing wall materials: INEC Censo 2023 (viviendas)", "https://ags.esri.co/arcgis/rest/services/PanamaLivingAtlas/"],
    ["Boundaries: HDX COD-AB Panama (OCHA)", "https://data.humdata.org/dataset/cod-ab-pan"],
    ["GEM Global Exposure & Vulnerability Models (Panama)", "https://github.com/gem/global_exposure_model"],
    ["Seismic code REP-2014", "https://doyc.mupa.gob.pa/wp-content/uploads/2016/10/REP2014-GacetaNo_27927a_20151214.pdf"],
    ["News headlines: Google News RSS (Spanish/English)", "https://news.google.com/"],
    ["Basemap: © OpenStreetMap contributors, © CARTO", "https://www.openstreetmap.org/copyright"],
  ];
  const srcs = [...new Set(state.reports.map(r => r.source_name.replace(/\s*\(.*\)$/, "")))];
  $("#data-sources").innerHTML = items.map(([t, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${esc(t)}</a></li>`).join("") +
    `<li>Impact reports cite ${srcs.length} outlets and accounts, including ${esc(srcs.slice(0, 18).join(", "))}${srcs.length > 18 ? "…" : ""}. Each report links to its original source.</li>`;
}

// ---------- vulnerability notes ----------
async function renderVuln() {
  try {
    const r = await fetch("data/risk/vulnerability.html?t=" + Date.now());
    if (r.ok) $("#vuln-notes").innerHTML = await r.text();
  } catch (e) {}
}

// ---------- header ----------
function renderHeader() {
  const t = [state.summary?.generated_utc, state.news?.updated_utc, state.highlights?.updated_utc].filter(Boolean).sort().pop();
  $("#updated").textContent = t ? "Data updated " + ago(t) : "";
  $("#foot-updated").textContent = t ? "Last data update " + localTime(t) : "";
  $("#n-reports").textContent = state.reports.length || "";
  $("#n-news").textContent = state.news ? state.news.items.length : "";
  $("#live-status").classList.toggle("stale", !state.quakesLive);
}

function renderAll() {
  renderHeader();
  renderOverview();
  populateFilters();
  renderFeed();
  renderNews();
  renderRisk();
  renderSources();
  Object.values(maps).forEach(m => {
    if (m === maps.big) refreshMapLayers(m, layerToggles());
    else if (m === maps.mini) refreshMapLayers(m, { mmi: true, quakes: true, reports: true, photos: false });
    else if (m._redraw) m._redraw();
  });
}

// ---------- lightbox & tooltips ----------
document.addEventListener("click", ev => {
  const t = ev.target.closest("[data-img]");
  if (!t) return;
  const lb = $("#lightbox");
  lb.querySelector("img").src = t.dataset.img;
  lb.querySelector("img").referrerPolicy = "no-referrer";
  lb.querySelector(".lb-cap").innerHTML = `${esc(t.dataset.cap)} · <a href="${esc(t.dataset.url)}" target="_blank" rel="noopener">source →</a>`;
  lb.hidden = false;
});
$("#lightbox").addEventListener("click", ev => { if (ev.target.tagName !== "A") $("#lightbox").hidden = true; });
document.addEventListener("keydown", ev => { if (ev.key === "Escape") $("#lightbox").hidden = true; });
const tt = document.createElement("div"); tt.className = "tt"; tt.hidden = true; document.body.appendChild(tt);
document.addEventListener("mousemove", ev => {
  const t = ev.target.closest("[data-tt]");
  if (!t) { tt.hidden = true; return; }
  tt.textContent = t.dataset.tt; tt.hidden = false;
  tt.style.left = Math.min(ev.clientX + 14, innerWidth - 270) + "px"; tt.style.top = ev.clientY + 14 + "px";
});

// ---------- landing gate (convenience only, not security) ----------
const GATE_HASH = "c4cf640f62b7372447f0fb49c172135a78fc3a1265d8fd06a7dcdd6e8008f660";
async function sha256(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function initGate() {
  if (document.documentElement.classList.contains("gate-ok")) return;
  setTimeout(() => $("#gate-pw").focus(), 50);
  $("#gate-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    if (await sha256($("#gate-pw").value.trim()) === GATE_HASH) {
      try { localStorage.setItem("gate", "ok"); } catch (e) {}
      document.documentElement.classList.add("gate-ok");
      showTab();
      Object.values(maps).forEach(m => m.invalidateSize());
    } else {
      $("#gate-err").textContent = "Incorrect access code.";
      $("#gate-pw").select();
    }
  });
}
initGate();

// ---------- boot ----------
async function boot() {
  try { state.lastVisit = localStorage.getItem("lastVisit"); localStorage.setItem("lastVisit", new Date().toISOString()); } catch (e) {}
  await Promise.all([loadData(), loadQuakes()]);
  renderAll();
  renderVuln();
  showTab();
  setInterval(async () => { await loadQuakes(); renderHeader(); renderOverview(); Object.values(maps).forEach(m => m._layers_ && refreshMapLayers(m, m === maps.big ? layerToggles() : { mmi: true, quakes: true, reports: true, photos: false })); }, QUAKE_REFRESH_MS);
  setInterval(async () => { await loadData(); renderAll(); }, DATA_REFRESH_MS);
  setInterval(renderHeader, 60000);
}
boot();
})();
