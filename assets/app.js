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
const t = s => I18N.t(s), tl = (en, es) => I18N.L(en, es);
const isEs = () => I18N.lang === "es";
const tx = (r, k) => (isEs() && r[k + "_es"]) || r[k];          // translated content field, English fallback
const H = () => {                                                  // Spanish highlights only when in sync with English
  const en = state.highlights, es = state.highlightsEs;
  return isEs() && es && en && es.updated_utc === en.updated_utc ? es : en;
};
const FIG_ES = { affected_people: "personas damnificadas", deaths: "fallecidos", injured: "heridos", missing: "desaparecidos", displaced: "desplazados", homes_damaged: "viviendas afectadas", homes_destroyed: "viviendas destruidas", buildings_collapsed: "edificaciones colapsadas", aftershocks: "réplicas", plant_capacity_pct: "% de capacidad de la planta" };
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const groupColor = g => cssVar(g === "damage" ? "--series-2" : g === "infra" ? "--series-1" : "--series-3");

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => n == null ? "–" : Math.round(n).toLocaleString("en-US");
const fmtK = n => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : fmt(n);
const roundTo = (n, s) => Math.round(n / s) * s;
const tzFmt = () => new Intl.DateTimeFormat(tl("en-GB", "es-PA"), { timeZone: "America/Panama", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const localTime = iso => iso ? tzFmt().format(new Date(iso)) + tl(" local", " hora local") : tl("time n/a", "hora no disponible");
function ago(iso) {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return tl("just now", "justo ahora");
  if (m < 60) return tl(m + " min ago", "hace " + m + " min");
  const h = Math.floor(m / 60);
  return h < 48 ? tl(h + " h " + (m % 60) + " min ago", "hace " + h + " h " + (m % 60) + " min") : tl(Math.round(h / 24) + " days ago", "hace " + Math.round(h / 24) + " días");
}
const sinceEq = t => { const h = (t - T0) / 3.6e6; return h < 1 ? Math.round(h * 60) + " min" : h.toFixed(1) + " h"; };

const state = { reports: [], summary: null, highlights: null, districts: [], news: null, status: null, quakes: null, mmiGrid: null, adm2: null, contours: null };
const maps = {};

// ---------- theme (light by default; dark only when chosen) ----------
const isDark = () => document.documentElement.dataset.theme === "dark";
function themeLabel() {
  const b = $("#theme-btn");
  b.innerHTML = isDark() ? `<span class="ico">☀</span><span class="lbl-long">${tl("Light mode", "Modo claro")}</span>`
                         : `<span class="ico">☾</span><span class="lbl-long">${tl("Dark mode", "Modo oscuro")}</span>`;
  b.title = isDark() ? tl("Switch to light mode", "Cambiar a modo claro") : tl("Switch to dark mode", "Cambiar a modo oscuro");
}
(function theme() {
  let t = null;
  try { t = localStorage.getItem("theme"); } catch (e) {}
  document.documentElement.dataset.theme = t === "dark" ? "dark" : "light";
  themeLabel();
  $("#theme-btn").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch (e) {}
    themeLabel();
    Object.values(maps).forEach(m => m._setBase && m._setBase());
    renderAll();
  });
})();
window.onLangApplied = () => { if ($("#theme-btn")) themeLabel(); };

// ---------- tabs ----------
function showTab() {
  const id = (location.hash || "#overview").slice(1);
  const valid = ["overview", "map", "impacts", "news", "risk", "sources"];
  const tab = valid.includes(id) ? id : "overview";
  document.querySelectorAll(".tab").forEach(s => s.classList.toggle("active", s.id === "tab-" + tab));
  document.querySelectorAll(".tabs a").forEach(a => a.classList.toggle("active", a.dataset.tab === tab));
  if (document.documentElement.classList.contains("gate-ok")) STATS.page("/" + tab, tab);
  if (tab === "map") initFullMap("big", "big-map");
  if (tab === "risk") initRiskMap();
  if (tab === "overview") initFullMap("ov", "ov-map");
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
  try { state.highlightsEs = await getJSON("data/highlights_es.json"); } catch (e) { state.highlightsEs = null; }
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
  const h = H(), s = state.summary;
  const q = state.quakes ? state.quakes.features.filter(f => f.properties.time > T0 + 1000) : [];
  const big = q.slice().sort((a, b) => b.properties.mag - a.properties.mag)[0];
  if (h) {
    $("#headline").textContent = h.headline;
    $("#asof").textContent = tl(`Situation as of ${localTime(h.updated_utc)} · updated continuously`, `Situación al ${localTime(h.updated_utc)} · actualización continua`) + (isEs() && h === state.highlights ? " · (traducción al español en preparación)" : "");
    $("#upcoming").innerHTML = h.upcoming ? `<strong>${tl("Next:", "Próximo:")}</strong> ${esc(h.upcoming)}` : "";
    $("#key-points").innerHTML = h.key_points.map(p => `<li>${esc(p)}</li>`).join("");
    $("#g-unknown").innerHTML = (h.unknowns || []).map(p => `<li>${esc(p)}</li>`).join("");
    $("#areas").innerHTML = h.areas.map(a => `<div class="area"><h4>${esc(a.area)} <span class="badge b-${a.status}">${statusIcon(a.status)} ${esc(t(a.status))}</span></h4>${esc(a.text)}</div>`).join("");
    $("#services").innerHTML = h.services.map(v => `<div class="svc"><div class="h">${esc(v.sector)} <span class="badge b-${v.status}">${statusIcon(v.status)} ${esc(t(v.status))}</span></div>${esc(v.text)}<div class="src">${esc(v.source)}</div></div>`).join("");
  }
  const popLo = s ? Math.min(s.exposure.pop_mmi7plus, sumArr(s.pager.pop_exposure_pa_by_mmi.slice(6))) : 0;
  const popHi = s ? Math.max(s.exposure.pop_mmi7plus, sumArr(s.pager.pop_exposure_pa_by_mmi.slice(6))) : 0;
  const popRange = s ? `${fmtK(roundTo(popLo, 10000))}–${fmtK(roundTo(popHi, 10000))}` : "";
  const bigM = big ? big.properties.mag.toFixed(1) : "";
  $("#g-what").innerHTML = (isEs() ? [
    `<b>Sismo de magnitud 7.7</b>, superficial (13 km de profundidad), a las <b>12:56 hora local</b> del viernes 9 de octubre (17:56 UTC). <span class="muted">El Instituto de Geociencias de Panamá lo midió en M7.2.</span>`,
    `<b>Epicentro:</b> sur de la península de Azuero, entre Los Santos y Herrera.`,
    `<b>Mayor intensidad:</b> severa a violenta alrededor de Tonosí y Macaracas; muy fuerte en Herrera, Los Santos y el sur de Veraguas${s ? `, donde viven unas <b>${popRange} personas</b>` : ""}.`,
    `<b>Réplicas:</b> decenas registradas por el Instituto de Geociencias; el catálogo del USGS incluye ${q.length} de las mayores${big ? `, la mayor de <b>M${bigM}</b>` : ""}. Son posibles más réplicas fuertes.`,
    `<b>Tsunami:</b> alerta inicial levantada; no se reportan daños por tsunami.`,
  ] : [
    `<b>M7.7 earthquake</b>, shallow (13 km deep), at <b>12:56 local time</b> on Friday 9 October (17:56 UTC). <span class="muted">Panama's Instituto de Geociencias measured M7.2.</span>`,
    `<b>Epicentre:</b> southern Azuero Peninsula, between Los Santos and Herrera.`,
    `<b>Strongest shaking:</b> severe to violent around Tonosí and Macaracas; very strong across Herrera, Los Santos and southern Veraguas${s ? `, where about <b>${popRange} people</b> live` : ""}.`,
    `<b>Aftershocks:</b> dozens recorded by Panama's Instituto de Geociencias; the USGS catalogue lists ${q.length} of the larger ones${big ? `, largest <b>M${bigM}</b>` : ""}. More strong aftershocks are possible.`,
    `<b>Tsunami:</b> initial warning lifted; no tsunami damage reported.`,
  ]).map(x => `<li>${x}</li>`).join("");

  if (s) {
    const o = s.official_latest || {};
    const offFields = [["deaths", "deaths"], ["injured", "injured"], ["missing", "missing"], ["affected_people", "people affected"], ["displaced", "displaced"], ["homes_damaged", "homes affected"], ["homes_destroyed", "homes destroyed"]].map(([k, l]) => [k, tl(l, FIG_ES[k])]);
    const known = offFields.filter(([k]) => o[k] != null);
    const p = s.pager, e = s.exposure;
    const fatTop = topBin(p.fatality_bins), econTop = topBin(p.economic_bins);
    const photos = state.reports.filter(r => r.image_url && r.image_verdict === "damage").length;
    const places = new Set(state.reports.map(r => r.place)).size;
    const dmgPlaces = new Set(state.reports.filter(r => ["building_damage", "fatalities", "injuries", "landslide"].includes(r.category) && r.province !== "Multiple / national").map(r => r.place.replace(/\s*\(.*\)$/, "")));
    const official = known.length
      ? `<div class="num num-official num-wide"><span class="kind kind-official">${t("Official")}</span>
           <div class="off-grid">${known.map(([k, l]) => `<div><div class="nv">${fmt(o[k])}</div><div class="nl">${l}</div></div>`).join("")}</div>
           <div class="nf">${tl("as of", "al")} ${localTime(o.as_of_utc)} · <a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.source_name)}</a></div></div>`
      : `<div class="num num-official num-wide num-pending"><span class="kind kind-official">${t("Official")}</span>
           <div class="nv nv-pending">${tl("No official casualty figures yet", "Aún no hay cifras oficiales de víctimas")}</div>
           <div class="nl">${tl("Authorities have not published deaths, injured, missing or displaced counts.", "Las autoridades no han publicado cifras de fallecidos, heridos, desaparecidos ni desplazados.")}</div>
           <div class="nf">${tl("Last checked", "Última revisión")} ${localTime(h ? h.updated_utc : o.as_of_utc)}</div></div>`;
    const INFRA = [["schools", "schools", "escuelas"], ["health_facilities", "health facilities", "instalaciones de salud"], ["government_buildings", "government buildings", "edificios públicos"], ["bridges", "bridges", "puentes"], ["churches", "churches", "iglesias"], ["hotels", "hotels", "hoteles"]];
    const inf = o.infrastructure || {};
    const infra = Object.keys(inf).length
      ? `<div class="num num-official num-wide"><span class="kind kind-official">${t("Official")}</span>
           <div class="off-grid">${INFRA.filter(([k]) => inf[k] != null).map(([k, en, es]) => `<div><div class="nv">${fmt(inf[k])}</div><div class="nl">${tl(en, es)}</div></div>`).join("")}</div>
           <div class="nf">${tl("public and other buildings affected", "edificaciones públicas y otras afectadas")} · ${tl("as of", "al")} ${localTime(o.as_of_utc)}</div></div>`
      : "";
    const popLoK = fmtK(roundTo(popLo, 10000)), popHiK = fmtK(roundTo(popHi, 10000));
    $("#numbers").innerHTML = official + infra + [
      { k: "reported", v: fmt(dmgPlaces.size), l: tl("towns with reported building damage", "poblados con daños reportados a edificaciones"), f: tl(`from ${state.reports.length} reports · ${photos} damage photos`, `de ${state.reports.length} reportes · ${photos} fotos de daños`) },
      { k: "model", v: `${popLoK}–${popHiK}`, l: tl("people in very strong shaking (MMI VII+)", "personas con sacudida muy fuerte (MMI VII+)"), f: tl("USGS ShakeMap × population (WorldPop / Census 2023)", "ShakeMap del USGS × población (WorldPop / Censo 2023)") },
    ].map(x => `<div class="num num-${x.k}"><span class="kind kind-${x.k}">${x.k === "model" ? t("Estimate") : t("Reported")}</span><div class="nv">${x.v}</div><div class="nl">${x.l}</div><div class="nf">${x.f}</div></div>`).join("");

    $("#official-note").innerHTML = o.note ? `<p>${esc(tx(o, "note"))}</p><p class="muted small">${tl("Source:", "Fuente:")} <a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.source_name)}</a> · ${localTime(o.as_of_utc)}</p>` : `<p class="muted">${t("No official statement recorded yet.")}</p>`;
    pagerBars("#pager-fat", p.fatality_bins, false);
    const c = (isEs() && s.conflicts_es && s.conflicts_es.length === (s.conflicts || []).length ? s.conflicts_es : s.conflicts) || [];
    $("#conflict-box").innerHTML = c.length ? `<ul>${c.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted">${t("No conflicting reports noted.")}</p>`;
  }

  const withImg = state.reports.filter(r => r.image_url && r.image_verdict !== "event").sort((a, b) => (a.image_verdict === "damage" ? 0 : 1) - (b.image_verdict === "damage" ? 0 : 1));
  $("#thumbs").innerHTML = withImg.slice(0, 9).map(r => `<figure data-img="${esc(r.image_url)}" data-cap="${esc(tx(r, "title"))}" data-url="${esc(r.url)}"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(r.image_url)}" alt="${esc(tx(r, "title"))}" onerror="this.closest('figure').remove()"><figcaption>${esc(tx(r, "place"))}</figcaption></figure>`).join("");
  const items = state.news ? state.news.items.slice(0, 9) : [];
  $("#headlines").innerHTML = items.map(n => `<li><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a><div class="meta">${esc(n.source)} · ${ago(n.published_utc)}</div></li>`).join("") || `<li class="muted">${t("No headlines yet.")}</li>`;
}
const sumArr = a => a.reduce((x, y) => x + y, 0);
const topBin = bins => bins.reduce((a, b) => (b.probability > a.probability ? b : a));
function binLabel(b, money) {
  const n = v => { v = +v; return money ? (v >= 1000 ? (v / 1000) + tl(" bn", " mil M") : v + " M") : v.toLocaleString("en-US"); };
  if (+b.max >= 10000000) return n(b.min) + "+";
  if (+b.min === 0) return money ? "< 1 M" : "0";
  if (money && +b.min < 1000 && +b.max >= 1000) return `${n(b.min)}–${n(b.max)}`;
  return money ? `${+b.min >= 1000 ? +b.min / 1000 : b.min}–${n(b.max)}` : `${n(b.min)}–${n(b.max)}`;
}
const PAGER_COL = { green: "--good", yellow: "--warning", orange: "--serious", red: "--critical" };
function pagerBars(sel, bins, money) {
  const max = Math.max(...bins.map(b => b.probability));
  const top = topBin(bins);
  $(sel).innerHTML = bins.map(b => `<div class="pbar${b === top ? " top" : ""}" data-tt="${esc(binLabel(b, money))}${money ? " US$" : tl(" deaths", " fallecidos")}: ${(b.probability * 100).toFixed(1)}% ${tl("probability", "de probabilidad")} (PAGER ${b.color})">
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
    .bindPopup(() => `<div class="pop"><h4>${tl("M7.7 mainshock (USGS)", "Sismo principal M7.7 (USGS)")}</h4><div class="meta">${tl("9 Oct 2026 12:56 local · depth 12.6 km", "9 oct 2026 12:56 hora local · profundidad 12,6 km")}</div>${tl("12 km WSW of Pitaloza Arriba.", "12 km al OSO de Pitaloza Arriba.")} <a href="https://earthquake.usgs.gov/earthquakes/eventpage/${EVENT_ID}" target="_blank" rel="noopener">${tl("USGS event page →", "Página del evento USGS →")}</a></div>`);
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
    }).bindPopup(`<div class="pop"><h4>${tl(`M${p.mag.toFixed(1)} aftershock`, `Réplica M${p.mag.toFixed(1)}`)}</h4><div class="meta">${localTime(new Date(p.time).toISOString())} · ${tl(`${sinceEq(p.time)} after mainshock`, `${sinceEq(p.time)} después del sismo principal`)} · ${tl("depth", "profundidad")} ${dep.toFixed(0)} km</div>${esc(p.place)}<br><a href="${esc(p.url)}" target="_blank" rel="noopener">USGS →</a></div>`)
      .bindTooltip(`M${p.mag.toFixed(1)} · ${ago(new Date(p.time).toISOString())}`).addTo(g);
  });
  return g;
}
function reportPopup(list) {
  const items = list.map(r => `<div class="item">
    ${r.image_url ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(r.image_url)}" alt="" data-img="${esc(r.image_url)}" data-cap="${esc(tx(r, "title"))}" data-url="${esc(r.url)}" onerror="this.remove()">` : ""}
    ${r.image_caption ? `<div class="meta" style="font-style:italic">${tl("Photo:", "Foto:")} ${esc(tx(r, "image_caption"))}</div>` : ""}
    <h4>${esc(tx(r, "title"))}</h4>
    <div class="meta"><span class="cat cat-${CAT_GROUP[r.category] || "other"}">${esc(t(CAT_LABEL[r.category] || r.category))}</span> ${esc(tx(r, "place"))} · ${r.reported_utc ? localTime(r.reported_utc) : t("time n/a")} · <span class="conf conf-${r.confidence}">${esc(t(CONF_LABEL[r.confidence] || r.confidence))}</span></div>
    ${esc(tx(r, "summary"))}<div style="margin-top:4px"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source_name)} →</a></div></div>`).join("");
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
      .bindPopup(reportPopup([r]), { maxWidth: 340 }).bindTooltip(esc(tx(r, "place")) + ": " + esc(tx(r, "title"))).addTo(dots);
  });
  const photoRank = r => r.image_verdict === "damage" ? 0 : r.image_verdict === "event" ? 2 : 1;
  groupByPlace(state.reports.filter(isPhotoPin).sort((a, b) => photoRank(a) - photoRank(b))).forEach(list => {
    const r = list[0];
    L.marker([r.lat, r.lon], { _img: r.image_url, pane: "photoPane", icon: L.divIcon({ className: "", html: `<div class="photo-pin dmg" style="background-image:url('${esc(r.image_url)}');position:relative">${list.length > 1 ? `<span class="n">${list.length}</span>` : ""}</div>`, iconSize: [46, 46], iconAnchor: [23, 23] }) })
      .bindPopup(reportPopup(list), { maxWidth: 340 }).bindTooltip(`${esc(tx(r, "place"))} · ${list.length} ${list.length > 1 ? tl("photos", "fotos") : tl("photo", "foto")}`).addTo(photos);
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
      l.bindTooltip(() => `<b>${esc(d.district)}</b>, ${esc(d.province)}<br>${tl("Pop. at MMI VII+", "Pobl. en MMI VII+")}: ${fmt(d.pop_mmi7plus)}<br>${t("Potential moderate+ damage")}: ${fmt(d.dmg_mod_lo)}–${fmt(d.dmg_mod_hi)}<br>${tl("Potential heavy damage/collapse", "Daño potencial grave/colapso")}: ${fmt(d.dmg_heavy_lo)}–${fmt(d.dmg_heavy_hi)}<br>${t("Max MMI")} ${d.max_mmi.toFixed(1)}${d.nonblock_share != null ? `<br>${t("Non-block walls")}: ${(d.nonblock_share * 100).toFixed(0)}%` : ""}`, { sticky: true });
    },
  });
}
const panelHTML = () => `
  <h3>${t("Layers")}</h3>
  <label><input type="checkbox" data-layer="mmi" checked> ${tl("Shaking intensity (MMI)", "Intensidad del sismo (MMI)")}</label>
  <label><input type="checkbox" data-layer="quakes" checked> ${tl("Earthquakes &amp; aftershocks", "Sismos y réplicas")} <span class="muted">${tl("(live)", "(en vivo)")}</span></label>
  <label><input type="checkbox" data-layer="photos" checked> ${tl("Damage photos", "Fotos de daños")} <span class="muted">${tl("(click to open)", "(clic para abrir)")}</span></label>
  <label><input type="checkbox" data-layer="reports" checked> ${tl("Other reported impacts", "Otros impactos reportados")}</label>
  <label><input type="checkbox" data-layer="damage"> ${t("Potential building damage by district")} <span class="muted">${tl("(exposure model)", "(modelo de exposición)")}</span></label>
  <h3>${t("Shaking (MMI)")}</h3>
  <div class="mmi-legend"></div>
  <h3>${t("Reports")}</h3>
  <div class="legend-items">
    <div><span class="photo-swatch"></span> ${tl("Verified damage photo", "Foto de daño verificada")}</div>
    <div><span class="dot dot-damage"></span> ${tl("Damage, casualties", "Daños, víctimas")}</div>
    <div><span class="dot dot-infra"></span> ${tl("Infrastructure, services", "Infraestructura, servicios")}</div>
    <div><span class="dot dot-other"></span> ${tl("Response, other", "Respuesta, otros")}</div>
    <div><span class="epi-swatch">★</span> ${tl("Epicentre (M7.7)", "Epicentro (M7.7)")}</div>
  </div>
  <h3>${t("Aftershocks")}</h3>
  <div class="muted small quake-count">${t("Loading…")}</div>`;
function buildPanel(m) {
  const prev = m._panel.querySelector("input[data-layer]") ? layerToggles(m) : null;
  m._panel.innerHTML = panelHTML();
  if (prev) m._panel.querySelectorAll("input[data-layer]").forEach(i => { i.checked = !!prev[i.dataset.layer]; });
  m._panel.querySelectorAll("input[data-layer]").forEach(i => i.addEventListener("change", () => refreshMapLayers(m, layerToggles(m))));
  m._panel.querySelector(".mmi-legend").innerHTML = [4, 5, 6, 7, 8, 9].map(v => `<div style="background:${MMI_COLORS[v]}">${ROMAN[v]}</div>`).join("") +
    ["Light", "Moderate", "Strong", "V. strong", "Severe", "Violent"].map(x => `<span class="muted" style="font-size:9.5px">${t(x)}</span>`).join("");
}
const FULL_BOUNDS = [[7.15, -81.6], [9.15, -79.3]];
function initFullMap(key, elId) {
  if (maps[key] || !window.L) return;
  const panel = document.querySelector(`.map-panel[data-panel="${key}"]`);
  const homepage = key === "ov";
  const m = maps[key] = L.map(elId, {
    zoomControl: true, zoomSnap: 0.25, tap: false,
    scrollWheelZoom: !homepage,                 // homepage: don't hijack page scrolling
    dragging: !(homepage && L.Browser.mobile),  // phones: one-finger scroll stays with the page
  }).fitBounds(FULL_BOUNDS);
  m._panel = panel;
  buildPanel(m);
  baseLayer(m);
  m._layers_ = {};
  refreshMapLayers(m, layerToggles(m));
}
const layerToggles = m => Object.fromEntries([...m._panel.querySelectorAll("input[data-layer]")].map(i => [i.dataset.layer, i.checked]));
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
  if (m._panel) {
    const q = state.quakes ? state.quakes.features.filter(f => f.properties.time > T0 + 1000).length : 0;
    m._panel.querySelector(".quake-count").innerHTML = tl(`${q} larger aftershocks (M2.5+) in the USGS catalogue; Panama's IGC records many more. Red = last hour. ${state.quakesLive ? "Live from USGS, refreshed every 2 min." : "Cached copy."}`, `${q} réplicas mayores (M2.5+) en el catálogo del USGS; el IGC de Panamá registra muchas más. Rojo = última hora. ${state.quakesLive ? "En vivo desde el USGS, cada 2 min." : "Copia en caché."}`);
  }
}
function initRiskMap() {
  if (maps.risk || !window.L) return;
  const m = maps.risk = L.map("risk-map", { zoomSnap: 0.25, scrollWheelZoom: false, dragging: !L.Browser.mobile, tap: false }).fitBounds([[7.15, -81.6], [9.0, -79.6]]);
  baseLayer(m);
  const draw = () => {
    if (m._dmg) m.removeLayer(m._dmg);
    m._dmg = damageLayer($("#risk-metric").value).addTo(m);
    const cap = { dmg: "Potential buildings with moderate or worse damage (mid-point), by district.", pop7: "Population exposed to MMI VII+ (very strong shaking), by district.", maxmmi: "Maximum modelled shaking intensity (MMI) in each district." };
    $("#risk-map-caption").textContent = t(cap[$("#risk-metric").value]);
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
  fill("#f-cat", cats.map(c => [c, t(CAT_LABEL[c] || c)]), t("All categories"));
  fill("#f-prov", provs.map(p => [p, t(p)]), t("All provinces"));
  fill("#f-conf", confs.map(c => [c, t(CONF_LABEL[c])]), t("Any confidence"));
}
function renderFeed() {
  const q = $("#f-q").value.toLowerCase(), cat = $("#f-cat").value, prov = $("#f-prov").value, conf = $("#f-conf").value, img = $("#f-img").checked;
  const list = state.reports.filter(r =>
    (!cat || r.category === cat) && (!prov || r.province === prov) && (!conf || r.confidence === conf) && (!img || r.image_url) &&
    (!q || [r.title, r.summary, r.title_es, r.summary_es, r.place, r.district, r.source_name].join(" ").toLowerCase().includes(q)));
  $("#feed").innerHTML = list.map(r => {
    const g = CAT_GROUP[r.category] || "other";
    const figs = Object.entries(r.figures || {}).filter(([, v]) => v != null).map(([k, v]) => `${fmt(v)} ${isEs() && FIG_ES[k] ? FIG_ES[k] : k.replace(/_/g, " ")}`).join(" · ");
    return `<article class="rep">
      ${r.image_url ? `<div class="img" role="img" aria-label="${esc(tx(r, "title"))}" data-img="${esc(r.image_url)}" data-cap="${esc(tx(r, "title"))}" data-url="${esc(r.url)}"><img src="${esc(r.image_url)}" referrerpolicy="no-referrer" loading="lazy" alt="" style="width:100%;height:100%;object-fit:cover;display:block" onerror="this.parentNode.remove()"></div>` : ""}
      <div class="body">
        <div class="meta"><span class="cat cat-${g}">${esc(t(CAT_LABEL[r.category] || r.category))}</span><span>${esc(tx(r, "place"))}${r.province ? ", " + esc(t(r.province)) : ""}</span></div>
        <h4>${esc(tx(r, "title"))}</h4>
        <p>${esc(tx(r, "summary"))}</p>
        ${figs ? `<div class="figs">${esc(figs)}</div>` : ""}
        <div class="src"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.source_name)} →</a><span class="conf conf-${r.confidence}">${esc(t(CONF_LABEL[r.confidence] || r.confidence))}</span></div>
        <div class="meta">${r.reported_utc ? localTime(r.reported_utc) + " · " + ago(r.reported_utc) : tl("time not stated", "hora no indicada")} · ${esc(tl(r.source_type, { official: "oficial", news: "noticias", social: "redes sociales" }[r.source_type] || r.source_type))}</div>
      </div></article>`;
  }).join("") || `<p class="muted">${t("No reports match.")}</p>`;
}
["#f-q", "#f-cat", "#f-prov", "#f-conf", "#f-img"].forEach(s => $(s).addEventListener("input", renderFeed));

// ---------- news stream ----------
function renderNews() {
  if (!state.news) return;
  const q = $("#n-q").value.toLowerCase(), lang = $("#n-lang").value;
  const lastVisit = state.lastVisit;
  const list = state.news.items.filter(n => (!lang || n.lang === lang) && (!q || (n.title + n.source).toLowerCase().includes(q)));
  $("#news-list").innerHTML = list.slice(0, 300).map(n => `<li><span class="lang">${esc(n.lang.toUpperCase())}</span><a class="t" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>${lastVisit && n.first_seen_utc > lastVisit ? `<span class="new">${tl("NEW", "NUEVO")}</span>` : ""}
    <div class="meta">${esc(n.source)}${n.kind === "humanitarian" ? " · ReliefWeb" : ""} · ${localTime(n.published_utc)} · ${ago(n.published_utc)}</div></li>`).join("");
}
["#n-q", "#n-lang"].forEach(s => $(s).addEventListener("input", renderNews));

// ---------- risk ----------
function renderRisk() {
  const s = state.summary;
  if (!s) return;
  const e = s.exposure;
  $("#risk-tiles").innerHTML = [
    [tl("People in strong shaking (MMI VI+)", "Personas con sacudida fuerte (MMI VI+)"), fmt(roundTo(e.pop_mmi6 + e.pop_mmi7plus, 1000)), tl("Census 2023-scaled WorldPop", "WorldPop ajustado al Censo 2023")],
    [tl("People in very strong shaking (VII+)", "Personas con sacudida muy fuerte (VII+)"), fmt(roundTo(e.pop_mmi7plus, 1000)), tl(`of which ${fmt(roundTo(e.pop_mmi8 + e.pop_mmi9, 100))} in severe (VIII+)`, `de ellas ${fmt(roundTo(e.pop_mmi8 + e.pop_mmi9, 100))} en severa (VIII+)`)],
    [tl("Buildings in very strong shaking (VII+)", "Edificaciones con sacudida muy fuerte (VII+)"), fmt(roundTo(e.bldg_mmi7plus, 1000)), tl("Microsoft ML building footprints", "Huellas de edificaciones Microsoft ML")],
    [t("Potential moderate+ damage"), `${fmtK(roundTo(e.dmg_mod_lo, 1000))}–${fmtK(roundTo(e.dmg_mod_hi, 1000))}`, tl(`buildings, as modelled · up to ~${fmtK(roundTo(e.dmg_mod_hi_p1, 1000))} if shaking was one level stronger`, `edificaciones, según el modelo · hasta ~${fmtK(roundTo(e.dmg_mod_hi_p1, 1000))} si la intensidad fue un nivel mayor`)],
    [tl("Potential heavy damage / collapse", "Daño potencial grave / colapso"), `${fmtK(roundTo(e.dmg_heavy_lo, 100))}–${fmtK(roundTo(e.dmg_heavy_hi, 100))}`, tl(`buildings, as modelled · up to ~${fmtK(roundTo(e.dmg_heavy_hi_p1, 100))} if shaking was one level stronger`, `edificaciones, según el modelo · hasta ~${fmtK(roundTo(e.dmg_heavy_hi_p1, 100))} si la intensidad fue un nivel mayor`)],
  ].map(([l, v, f]) => `<div class="tile"><div class="label">${l}</div><div class="value">${v}</div><div class="foot">${f}</div></div>`).join("");

  // grouped bars: population and buildings per MMI class (two series, one axis each -> two bars normalised separately? no: separate scales are labelled)
  const rows = [[6, "VI"], [7, "VII"], [8, "VIII"], [9, "IX+"]];
  const pmax = Math.max(...rows.map(([m]) => e["pop_mmi" + m])), bmax = Math.max(...rows.map(([m]) => e["bldg_mmi" + m]));
  $("#mmi-chart").innerHTML = rows.map(([m, r]) => `<div class="bc-row"><span class="lbl"><span class="mmi-chip" style="background:${mmiColor(m)}">${r}</span></span>
    <div class="bc-bars">
      <div class="bc-bar" data-tt="MMI ${r}: ${fmt(e["pop_mmi" + m])} ${tl("people", "personas")}"><span class="b" style="width:${(e["pop_mmi" + m] / pmax) * 80}%;background:var(--series-1)"></span><span class="v">${fmt(e["pop_mmi" + m])} ${tl("people", "personas")}</span></div>
      <div class="bc-bar" data-tt="MMI ${r}: ${fmt(e["bldg_mmi" + m])} ${tl("buildings", "edificaciones")}"><span class="b" style="width:${(e["bldg_mmi" + m] / bmax) * 80}%;background:var(--series-2)"></span><span class="v">${fmt(e["bldg_mmi" + m])} ${tl("buildings", "edificaciones")}</span></div>
    </div></div>`).join("") +
    `<div class="bc-legend"><span style="--c:var(--series-1)">${t("People")}</span><span style="--c:var(--series-2)">${t("Buildings")}</span><span class="muted">${t("Each series scaled to its own maximum; read values from labels.")}</span></div>`;

  const cols = [
    ["district", "District", d => esc(d.district)], ["province", "Province", d => esc(d.province)],
    ["max_mmi", "Max MMI", d => `<span class="mmi-chip" style="background:${mmiColor(d.max_mmi)}">${d.max_mmi.toFixed(1)}</span>`],
    ["pop_total", "Population", d => fmt(d.pop_total)], ["pop_mmi7plus", "Pop. MMI VII+", d => fmt(d.pop_mmi7plus)],
    ["bldg_mmi7plus", "Bldgs MMI VII+", d => fmt(d.bldg_mmi7plus)],
    ["nonblock_share", "Non-block walls", d => d.nonblock_share == null ? "–" : (d.nonblock_share * 100).toFixed(0) + "%"],
    ["dmg_mod", "Potential moderate+ damage", d => `${fmt(d.dmg_mod_lo)}–${fmt(d.dmg_mod_hi)}`],
    ["dmg_heavy", "Potential heavy / collapse", d => `${fmt(d.dmg_heavy_lo)}–${fmt(d.dmg_heavy_hi)}`],
    ["dmg_mod_hi_p1", "Moderate+ if shaking 1 level stronger", d => `${tl("up to", "hasta")} ${fmt(d.dmg_mod_hi_p1)}`],
    ["reports", "Reports", d => fmt(d.reports)],
  ];
  const sortKey = state.sortKey || "dmg_mod";
  const keyVal = (d, k) => k === "dmg_mod" ? d.dmg_mod_lo + d.dmg_mod_hi : k === "dmg_heavy" ? d.dmg_heavy_lo + d.dmg_heavy_hi : d[k];
  state.districts.forEach(d => { d.reports = state.reports.filter(r => r.district && r.district.toLowerCase() === d.district.toLowerCase()).length; });
  const rowsD = state.districts.slice().sort((a, b) => {
    const x = keyVal(a, sortKey), y = keyVal(b, sortKey);
    return typeof x === "string" ? x.localeCompare(y) : (y ?? -1) - (x ?? -1);
  });
  $("#dist-table").innerHTML = `<thead><tr>${cols.map(c => `<th data-k="${c[0]}">${t(c[1])}${c[0] === sortKey ? " ▾" : ""}</th>`).join("")}</tr></thead><tbody>${rowsD.map(d => `<tr>${cols.map(c => `<td>${c[2](d)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  $("#dist-table").querySelectorAll("th").forEach(th => th.addEventListener("click", () => { state.sortKey = th.dataset.k; renderRisk(); }));

  const R = e.rates;
  $("#rates-table").innerHTML = `<thead><tr><th>MMI</th><th>${t("Moderate or worse")}</th><th>${t("Heavy / collapse")}</th></tr></thead><tbody>${Object.entries(R).map(([m, r]) => `<tr><td><span class="mmi-chip" style="background:${mmiColor(+m)}">${ROMAN[m]}</span></td><td>${r[0] * 100}–${r[1] * 100}%</td><td>${(r[2] * 100).toFixed(1)}–${(r[3] * 100).toFixed(1)}%</td></tr>`).join("")}</tbody>`;

  $("#secondary").innerHTML = isEs() ? `
    <li><strong>Deslizamientos:</strong> modelo de falla del terreno del USGS: alerta <b>naranja</b> (~97 km² de área agregada, ~470 personas expuestas). Las zonas montañosas del sur de Azuero y Veraguas son las más susceptibles. Ya se reportan cortadas las vías a Torio/Arenas.</li>
    <li><strong>Licuefacción:</strong> alerta naranja del USGS; las llanuras costeras y deltas (Chitré–Monagrillo, Parita, Aguadulce) son susceptibles.</li>
    <li><strong>Tsunami:</strong> mensaje de amenaza del PTWC para las costas de Panamá (1–3 m) luego desactivado; no se reportan daños por tsunami. El sismo de Azuero de 1913 provocó un deslizamiento submarino que cortó un cable telegráfico.</li>
    <li><strong>Réplicas:</strong> siguen siendo posibles réplicas M6+ en los próximos días; las edificaciones dañadas pueden debilitarse aún más.</li>` : `
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
    tl(`<li>Impact reports cite ${srcs.length} outlets and accounts, including ${esc(srcs.slice(0, 18).join(", "))}${srcs.length > 18 ? "…" : ""}. Each report links to its original source.</li>`,
      `<li>Los reportes de impacto citan ${srcs.length} medios y cuentas, entre ellos ${esc(srcs.slice(0, 18).join(", "))}${srcs.length > 18 ? "…" : ""}. Cada reporte enlaza a su fuente original.</li>`);
}

// ---------- vulnerability notes ----------
async function renderVuln() {
  try {
    let r = isEs() ? await fetch("data/risk/vulnerability_es.html?t=" + Date.now()) : null;
    if (!r || !r.ok) r = await fetch("data/risk/vulnerability.html?t=" + Date.now());
    if (r.ok) $("#vuln-notes").innerHTML = await r.text();
  } catch (e) {}
}

// ---------- header ----------
function renderHeader() {
  const tt = [state.summary?.generated_utc, state.news?.updated_utc, state.highlights?.updated_utc].filter(Boolean).sort().pop();
  $("#updated").innerHTML = tt ? `${tl("Last update:", "Última actualización:")} <b>${tzFmt().format(new Date(tt))}</b> ${tl("Panama time (UTC−5)", "hora de Panamá (UTC−5)")}` : "";
  $("#foot-updated").textContent = tt ? tl("Last data update ", "Última actualización ") + localTime(tt) : "";
  $("#n-reports").textContent = state.reports.length || "";
  $("#n-news").textContent = state.news ? state.news.items.length : "";
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
    if (m._panel) refreshMapLayers(m, layerToggles(m));
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
  STATS.event("photo-open", "Photo opened");
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
// crypto.subtle only exists on https/localhost; fall back to a plain-JS SHA-256 on http.
async function sha256(t) {
  const bytes = new TextEncoder().encode(t);
  if (window.crypto && crypto.subtle) {
    const b = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
  }
  return sha256js(bytes);
}
function sha256js(bytes) {
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
  m.set(bytes); m[l] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(n - 4, (l * 8) >>> 0); dv.setUint32(n - 8, Math.floor(l / 0x20000000));
  const w = new Uint32Array(64), rotr = (x, r) => (x >>> r) | (x << (32 - r));
  for (let o = 0; o < n; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(o + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i-15], 7) ^ rotr(w[i-15], 18) ^ (w[i-15] >>> 3), s1 = rotr(w[i-2], 17) ^ rotr(w[i-2], 19) ^ (w[i-2] >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
  }
  return H.map(x => x.toString(16).padStart(8, "0")).join("");
}
function initGate() {
  if (document.documentElement.classList.contains("gate-ok")) return;
  STATS.page("/landing", "Landing page");
  setTimeout(() => $("#gate-pw").focus(), 50);
  $("#gate-form").addEventListener("submit", async ev => {
    ev.preventDefault();
    if (await sha256($("#gate-pw").value.trim()) === GATE_HASH) {
      try { localStorage.setItem("gate", "ok"); } catch (e) {}
      document.documentElement.classList.add("gate-ok");
      STATS.event("unlock", "Access code entered" + (isEs() ? " (ES)" : ""));
      showTab();
      Object.values(maps).forEach(m => m.invalidateSize());
    } else {
      $("#gate-err").textContent = t("Incorrect access code.");
      STATS.event("wrong-code", "Wrong access code");
      $("#gate-pw").select();
    }
  });
}
initGate();

// ---------- language ----------
function applyLanguage() {
  I18N.translateStatic();
  Object.values(maps).forEach(m => { if (m._panel) buildPanel(m); });
  if ($("#gate-err").textContent) $("#gate-err").textContent = t("Incorrect access code.");
  renderAll();
  renderVuln();
}
document.querySelectorAll(".lang-btn").forEach(b => b.addEventListener("click", () => {
  I18N.setLang(isEs() ? "en" : "es");
  STATS.event("lang-" + I18N.lang, "Language switched to " + I18N.lang.toUpperCase());
  applyLanguage();
}));
I18N.translateStatic();

// ---------- boot ----------
async function boot() {
  try { state.lastVisit = localStorage.getItem("lastVisit"); localStorage.setItem("lastVisit", new Date().toISOString()); } catch (e) {}
  await Promise.all([loadData(), loadQuakes()]);
  renderAll();
  renderVuln();
  showTab();
  setInterval(async () => { await loadQuakes(); renderHeader(); renderOverview(); Object.values(maps).forEach(m => m._panel && refreshMapLayers(m, layerToggles(m))); }, QUAKE_REFRESH_MS);
  setInterval(async () => { await loadData(); renderAll(); }, DATA_REFRESH_MS);
  setInterval(renderHeader, 60000);
}
boot();
})();
