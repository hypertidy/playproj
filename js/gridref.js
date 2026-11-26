// playproj: Grid references
//
// A scrolling explainer. It starts on a street directory page at Fern Tree,
// Tasmania (or wherever the pin is put), and each step asks what one more of
// the numbers means: the kilometre grid, six and eight figures, the 100 km
// square, the central meridian and false easting, the equator and false
// northing, where the zone's 0,0 is, why eastings have six digits and
// northings seven, the 0.9996 scale, the sixty zones and their bands, and
// UPS at the poles. The map is drawn in the pin's own UTM zone (eastings
// and northings are the canvas) until the globe takes over.
//
// The panel's scroll position is a continuous step number: the camera and
// every layer's opacity are interpolated between the steps either side of
// it. The numbers are src/core/gridref.js, on src/core/mgrs.js.

import * as M from "../src/core/mgrs.js";
import * as G from "../src/core/gridref.js";
import { readParams, hashWriter } from "../src/scene/hash.js";
import { shareLinks, isEmbed } from "../src/scene/share.js";
import * as R from "../src/core/mapref.js";
import { shift } from "../src/core/vicgrid.js";
import { loadCoastline } from "./data.js";

const $ = (id) => document.getElementById(id);
const DEG = String.fromCharCode(176);
const D2R = Math.PI / 180;

// colours: one per kind of digit, used for the digits and for the grid
// lines that count them
const C = {
  bg: "#05070d", sea: "#081224", coast: "rgba(215,236,255,0.75)", grat: "rgba(140,196,255,0.22)",
  hk: "#ff9f43", km: "#4dd2ff", hm: "#7bed9f", tm: "#ffd34d", m: "#c9a0ff",
  cm: "#4dd2ff", edge: "#ff7ab8", equator: "#ffd34d", origin: "#ffffff", pin: "#ff4757", ink: "#eef3fa", muted: "#9aa7ba",
  atlas: "#2b2f8f", atlasInk: "#1b1f6b"
};
const SPACING_COLOUR = { 1e6: "#ff6b6b", 1e5: C.hk, 1e4: C.km, 1e3: C.km, 100: C.hm, 10: C.tm, 1: C.m };

const PLACES = [
  ["Fern Tree, Tasmania", 147.2625, -42.9216],
  ["Hobart GPO, Tasmania", 147.3272, -42.8821],
  ["Mawson station, Antarctica", 62.8738, -67.6027],
  ["Quito, Ecuador", -78.4678, -0.1807],
  ["Greenwich, England", -0.0015, 51.4779],
  ["Tromso, Norway", 18.9553, 69.6496]
];

// ---------------------------------------------------------------- state

const defaults = { s: 0, at: "" };
const state = { ...defaults };
function readHash() { readParams(state, defaults, { at: String, s: (r) => Math.max(0, Math.floor(+r) || 0) }); }
readHash();
const writeHash = hashWriter(state, defaults);

function placeFromState() {
  const v = state.at.split(",").map(Number);
  if (v.length === 2 && v.every(isFinite) && v[1] > -80 && v[1] < 84) {
    const hit = PLACES.find((p) => Math.abs(p[1] - v[0]) < 1e-5 && Math.abs(p[2] - v[1]) < 1e-5);
    return { name: hit ? hit[0].split(",")[0] : "the pin", full: hit ? hit[0] : "the pin", lon: v[0], lat: v[1] };
  }
  const [full, lon, lat] = PLACES[0];
  return { name: full.split(",")[0], full, lon, lat };
}

let P = null, D = null, zone = 55, south = true, lon0 = 147, STEPS = [];
// the Tasmanian street atlas and map book (theLIST), and the pin's place in them
let MR = null, T = null;
let fwd = null, inv = null;

function setPlace() {
  P = placeFromState();
  D = G.describe(P.lon, P.lat);
  zone = D.zone; south = D.south; lon0 = D.lon0;
  fwd = (lon, lat) => { const [x, y] = M.tmerc(lon, lat, lon0); return [x + 5e5, south ? y + 1e7 : y]; };
  inv = (E, N) => M.tmercInverse(E - 5e5, south ? N - 1e7 : N, lon0);
  coastZone = null;
  T = null;
  if (MR && zone === 55 && south) {
    // the books are on GDA94: take the pin there, and keep the offset to draw their frames on this GDA2020 grid
    const [l94, p94] = shift(P.lon, P.lat, "GDA2020", "GDA94");
    const u = M.toUTM(l94, p94, 55, true);
    const hits = R.locate(MR, u.e, u.n);
    const sa = hits.find((h) => h.book === "SA" && h.square) || null, mb = hits.find((h) => h.book === "MB") || null;
    if (sa || mb) T = { e94: u.e, n94: u.n, dE: D.e - u.e, dN: D.n - u.n, sa, mb, hits };
  }
  STEPS = buildSteps();
  renderSteps();
  renderRefbar();
}

// ---------------------------------------------------------------- formatting

const grp = (v) => String(Math.floor(Math.abs(v))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const ns = (v) => (v < 0 ? "-" : "") + grp(v);
const fmtLat = (lat, d = 2) => `${Math.abs(lat).toFixed(d)}${DEG}${lat < 0 ? "S" : "N"}`;
const fmtLon = (lon, d = 2) => { lon = ((lon + 540) % 360) - 180; return `${Math.abs(lon).toFixed(d)}${DEG}${lon < 0 ? "W" : "E"}`; };
const lonName = (lon) => fmtLon(lon, 0);

// an easting or northing as coloured digit spans
function digitSpans(v) {
  const s = G.splitDigits(v);
  const head = s.hundredKm ? `<i class="d-hk">${s.hundredKm}</i>` : "";
  return `${head}<i class="d-km">${s.km}</i><i class="d-hm">${s.hundredM}</i><i class="d-tm">${s.tenM}</i><i class="d-m">${s.m}</i>`;
}
function shortSpans(parts) {
  const cls = ["d-km", "d-km", "d-hm", "d-tm", "d-m"];
  return parts.map((p) => [...p].map((c, i) => `<i class="${cls[i]}">${c}</i>`).join("")).join(" ");
}

// ---------------------------------------------------------------- the steps
//
// Each step has a title and text, a camera ({ E, N, span } on the zone's
// plane, span in metres across the smaller side, or { globe: [lon, lat],
// zoom } for the globe), the opacity of each layer, the refbar rows it shows
// and the digit classes it lights.

function buildSteps() {
  const d = D, a = d.atlas, nm = P.name;
  const pageC = [(a.west + a.east) / 2, (a.north + a.south) / 2];
  const sq100 = [Math.floor(d.e / 100) * 100 + 50, Math.floor(d.n / 100) * 100 + 50];
  const sq10 = [Math.floor(d.e / 10) * 10 + 5, Math.floor(d.n / 10) * 10 + 5];
  const eq = south ? 1e7 : 0;
  const fromEq = south ? 1e7 - Math.floor(d.n) : Math.floor(d.n);
  const edgeEq = G.zoneWidth(0) / 2, widthHere = G.zoneWidth(P.lat);
  const kEdge = G.scaleAndConvergence(lon0 + 3, 0, zone).k, off = G.trueScaleOffset(P.lat, zone);
  const poleN = G.poleNorthing(south), [oLon, oLat] = d.origin;
  const aus = south && P.lon > 110 && P.lon < 156 && P.lat > -45;
  const gdaName = aus ? `MGA zone ${zone} (the Map Grid of Australia on GDA2020, EPSG:${7800 + zone})` : `UTM zone ${zone}${south ? "S" : "N"} (EPSG:${d.epsg})`;
  const midN = (d.n + eq) / 2;
  const tall = Math.abs(d.n - eq) * 1.25 + 600e3;
  const ppm = (k) => `${k >= 1 ? "+" : "-"}${Math.abs((k - 1) * 1e5).toFixed(0)} cm per km`;
  const band = M.bandRange(d.band);
  const bi = M.BANDS.indexOf(d.band), bandBelow = M.BANDS[bi - 1] || "", bandAbove = M.BANDS[bi + 1] || "";
  const conv = d.conv;

  const S = [];
  const realCam = T ? bookCam(T.sa ? T.sa.page : T.mb.page) : null;
  if (T) S.push({
    title: T.sa ? T.sa.label : T.mb.label,
    body: `<p>Here is ${P.name}${T.sa ? ` in Tasmania's street atlas: <b>page ${T.sa.square.page}, square ${T.sa.square.col}${T.sa.square.row}</b>,
      written <b>${T.sa.label}</b> on an emergency callout` : ", outside the street atlas's pages"}. The map book, which covers the whole
      state at a smaller scale, has it as <b>${T.mb ? T.mb.label : "nothing"}</b>.</p>
      <p>A page and square find a place the way a row and seat number find a seat, and they only mean something with the book
      in your hand. The numbers in the margin of a topographic map, or on a phone's GPS, mean the same thing anywhere on
      Earth. What are they?</p>
      <p class="hint">Pages and squares from theLIST (the LIST &copy; State of Tasmania). There is more on the two books
      after the grid reference story.</p>`,
    cam: realCam, L: { tiles: 1, real: 1 }, rows: ["atl"], hi: ["atl"], click: true
  });
  else S.push({
    title: `Map ${a.page}, square ${a.letter}${a.number}`,
    body: `<p>Here is ${P.full}, the way a street directory shows it: <b>Map ${a.page}, square ${a.letter}${a.number}</b>.
      The page is one sheet of a book, and the letter and number find the square on that sheet, the way a row and
      seat number find a seat.</p>
      <p>That only means something with the book in your hand. The numbers in the margin of a topographic map, or on
      a phone's GPS, mean the same thing anywhere on Earth. What are they?</p>
      <p class="hint">This directory is made up for the page: its sheets are 4 by 5 km cut from the kilometre grid,
      with 500 m squares. Real directories each have their own.</p>`,
    cam: { E: pageC[0] - 700, N: pageC[1] + 300, span: 6400 }, L: { tiles: 1, atlas: 1, pages: 1 }, rows: ["atl"], hi: ["atl"], click: true
  });
  S.push({
    title: "The kilometre grid",
    body: `<p>Under the page is the national grid, ${gdaName}. Its lines are 1000 m apart, and a topographic map
      labels each one with its two big digits: <b class="c-km">${d.six[0].slice(0, 2)}</b> for the line
      ${grp(Math.floor(d.e / 1000) * 1000)} m east, <b class="c-km">${d.six[1].slice(0, 2)}</b> for
      ${grp(Math.floor(d.n / 1000) * 1000)} m north.</p>
      <p>Read across first, then up ("along the corridor, then up the stairs"): ${nm} is in the square east of line
      ${d.six[0].slice(0, 2)} and north of line ${d.six[1].slice(0, 2)}, the four-figure reference
      <b>${d.six[0].slice(0, 2)}${d.six[1].slice(0, 2)}</b>.</p>`,
    cam: { E: d.e, N: d.n, span: 3600 }, L: { tiles: 0.85, atlas: 0.25, grid: 1 }, rows: ["atl", "six"], hi: ["d-km"]
  });
  S.push({
    title: "Six figures: 100 metres",
    body: `<p>Cut the kilometre square into tenths: ${nm} is ${d.six[0][2]} tenths across and ${d.six[1][2]} tenths up.
      That is the six-figure reference <b>${shortSpans(d.six)}</b>, a square 100 m on a side.</p>
      <p>The digits are cut off, not rounded, so a reference names the square's south-west corner and everything in
      the square shares it. Six figures repeat every 100 km, so on their own they need the map sheet to go with
      them.</p>`,
    cam: { E: sq100[0], N: sq100[1], span: 520 }, L: { tiles: 0.85, grid: 1, cell100: 1 }, rows: ["six", "eight"], hi: ["d-km", "d-hm"]
  });
  S.push({
    title: "Eight figures: 10 metres",
    body: `<p>Another tenth each way gives eight figures, <b>${shortSpans(d.eight)}</b>, a square 10 m on a side: the
      front of a house. Ten figures, ${d.mgrs.split(" ").slice(2).join(" ")}, name the metre, about as well as a phone
      knows where it is.</p>
      ${aus ? `<p>At this scale the datum shows. GDA2020 and GDA94 coordinates of the same spot differ by about
      1.5 m here: the Australian plate carries the continent north-east by about 7 cm a year, and the two datums
      were fixed 26 years apart.</p>` : `<p>At this scale the datum shows: the same spot has coordinates a metre or
      more apart on datums fixed years apart, because the plates move.</p>`}`,
    cam: { E: sq10[0], N: sq10[1], span: 70 }, L: { tiles: 0.85, grid: 1, cell100: 0.6, cell10: 1 }, rows: ["six", "eight", "mgrs"], hi: ["d-hm", "d-tm", "d-m"]
  });
  S.push({
    title: "The 100 km square",
    body: `<p>Written out in full the coordinates are <b>E ${grp(d.e)}</b> and <b>N ${grp(d.n)}</b>: metres, the whole
      way. The last five digits of each are the place inside a 100 km square (orange lines). The digits in front,
      <b class="c-hk">${G.splitDigits(d.e).hundredKm}</b> and <b class="c-hk">${G.splitDigits(d.n).hundredKm}</b>,
      count whole 100 km.</p>
      <p>A military (MGRS) reference swaps those leading digits for two letters, <b class="c-hk">${d.square}</b>, and
      puts the zone and latitude band in front: <b>${d.mgrs}</b>. The letters repeat, the columns every three
      zones and the rows every 2000 km, so the zone and band are part of the name.</p>
      <p>But ${grp(d.e)} metres east of what? ${grp(d.n)} metres north of what?</p>`,
    cam: { E: d.e, N: d.n, span: 300e3 }, L: { tiles: 0.55, coast: 1, grid: 1, sq100: 1, grat: 0.6 }, rows: ["mgrs", "mga"], hi: ["d-hk"]
  });
  S.push({
    title: `E 500 000 is ${lonName(lon0)}`,
    body: `<p>Step back. The cyan line is the zone's central meridian, ${lonName(lon0)}, and it is the line
      <b>E 500 000</b>. Eastings are metres from it, with 500 000 added: ${nm} is
      <b class="c-km">${grp(d.fromCM)} m ${d.fromCM >= 0 ? "east" : "west"}</b> of ${lonName(lon0)}, so its easting
      is 500 000 ${d.fromCM >= 0 ? "+" : "-"} ${grp(d.fromCM)} = ${grp(d.e)}.</p>
      <p>Zone ${zone} runs from ${lonName(lon0 - 3)} to ${lonName(lon0 + 3)} (pink). Each side of it is another
      zone, with its own central meridian and its own E 500 000. Grid lines are straight; the meridians and
      parallels bend.</p>`,
    cam: { E: 5e5, N: d.n, span: 1000e3 }, L: { tiles: 0.45, coast: 1, grid: 1, grat: 1, cm: 1, edges: 1, offsetE: 1 }, rows: ["mga", "zone"], hi: ["d-e"]
  });
  S.push({
    title: "Why 500 000",
    body: `<p>A zone is 6 degrees of longitude: ${grp(2 * edgeEq / 1000)} km wide at the equator and narrower
      towards the poles (${grp(widthHere / 1000)} km at ${nm}'s latitude). Half the widest zone is
      ${grp(edgeEq)} m, so adding 500 000 m, the <b>false easting</b>, keeps every easting positive.</p>
      <p>On the equator they run from E ${grp(5e5 - edgeEq)} at the zone's west edge to E ${grp(5e5 + edgeEq)} at its
      east edge. Everywhere in a zone, an easting has <b>six digits</b>.</p>`,
    cam: { E: 5e5, N: midN, span: tall }, L: { coast: 1, grid: 1, grat: 0.7, cm: 1, edges: 1, equator: 1, width: 1, offsetE: 1 }, rows: ["mga", "zone"], hi: ["d-e"]
  });
  S.push({
    title: south ? "N 10 000 000 is the equator" : "N 0 is the equator",
    body: south
      ? `<p>Now the northing. In the southern hemisphere the equator (yellow) is <b>N 10 000 000</b>, and northings
        count down from it. ${nm} is <b class="c-km">${grp(fromEq)} m</b> of grid south of the equator:
        10 000 000 - ${grp(fromEq)} = ${grp(d.n)}.</p>
        <p>That ${grp(1e7)}, the <b>false northing</b>, is there so a northing is never negative anywhere south of
        the equator.</p>`
      : `<p>Now the northing. In the northern hemisphere the equator (yellow) is <b>N 0</b>, and the northing is the
        grid distance north of it: ${nm} is <b class="c-km">${grp(d.n)} m</b> north of the equator. There is no false
        northing: nothing north of the equator is negative.</p>
        <p>South of the equator the same zone counts down from 10 000 000 instead, so a southern northing is never
        negative either.</p>`,
    cam: { E: 5e5, N: midN, span: tall }, L: { coast: 1, grid: 1, grat: 0.5, cm: 1, edges: 1, equator: 1, offsetE: 1, offsetN: 1 }, rows: ["mga", "zone"], hi: ["d-n"]
  });
  S.push({
    title: "Where 0,0 really is",
    body: south
      ? `<p>So 0,0 is 500 km of grid west of the central meridian and 10 000 km of grid south of the equator. Keep
        going: the South Pole is at E 500 000, <b>N ${grp(poleN)}</b> (the 0.9996 scale makes the 10 002 km from
        equator to pole ${grp(Math.round(1e7 - poleN))} m of grid), and below it the grid carries on over the other side of the
        Earth.</p>
        <p>Zone ${zone}'s <b>0,0</b> is a real place: ${fmtLat(oLat)} ${fmtLon(oLon)}, on the East Antarctic ice sheet,
        about ${grp((90 + oLat) * 111.2)} km past the pole. Nothing is measured from there; it is only where the
        numbers would run out.</p>
        <p>North of the equator, 0,0 is simply on the equator 500 km west of the central meridian (${fmtLon(G.falseOrigin(zone, false)[0])}
        for zone ${zone}).</p>`
      : `<p>So 0,0 is on the equator, 500 km of grid west of the central meridian: for zone ${zone} that is
        <b>${fmtLon(oLon)} 0${DEG}</b>. It is a real place, and nothing is measured from it; it is only where the
        numbers would run out.</p>
        <p>South of the equator, the same zone's 0,0 is 10 000 km of grid south of the equator: past the South Pole,
        at ${fmtLat(G.falseOrigin(zone, true)[1])} ${fmtLon(G.falseOrigin(zone, true)[0])} on the East Antarctic ice sheet.</p>`,
    cam: south ? { E: 3e5, N: 4.75e6, span: 11.8e6 } : { E: 3e5, N: Math.max(d.n, 3e6) / 2, span: Math.max(d.n, 3e6) * 1.4 },
    L: { coast: 1, grid: 1, grat: 0.5, cm: 1, edges: 1, equator: 1, origin: 1, pole: 1, offsetN: 1 }, rows: ["mga"], hi: ["d-e", "d-n"]
  });
  S.push({
    title: "Six digits and seven",
    body: `<p>Eastings stay between about 166 000 and 834 000: six digits. Northings run from 0 to just under
      10 000 000: seven digits. That is why the two numbers are different lengths, and why the leading 100 km
      digits are <b class="c-hk">${G.splitDigits(d.e).hundredKm}</b> for one and
      <b class="c-hk">${G.splitDigits(d.n).hundredKm}</b> for the other.</p>
      <p>The 10 000 000 is not an accident. In 1791 the metre was defined as one ten-millionth of the distance from
      the North Pole to the equator, so the false northing is, nearly, one quadrant of the Earth. The survey that
      fixed the metre came out a little short: the quadrant is 10 001 966 m on today's ellipsoid.</p>`,
    cam: south ? { E: 5e5, N: 5e6, span: 11.2e6 } : { E: 5e5, N: 4.6e6, span: 10.2e6 },
    L: { coast: 1, grid: 1, grat: 0.3, cm: 1, edges: 1, equator: 1, origin: 1, pole: 1, million: 1 }, rows: ["mga"], hi: ["d-hk"]
  });
  S.push({
    title: "0.9996",
    body: `<p>One more number hides in every coordinate: the <b>scale factor</b>. A transverse Mercator is true to
      scale only along the line its cylinder touches. UTM shrinks it by 0.9996 so the cylinder cuts the Earth
      instead, along two lines about ${grp(off / 1000)} km either side of the central meridian (dashed). Blue is
      where a grid distance is shorter than the ground, orange where it is longer.</p>
      <p>At ${nm} the scale is <b>${d.k.toFixed(6)}</b>: a kilometre on the ground is ${(d.k * 1000).toFixed(1)} m of
      grid (${ppm(d.k)}). On the zone's edge at the equator it is ${kEdge.toFixed(5)} (${ppm(kEdge)}); without the
      0.9996 that would be ${ppm(kEdge / M.K0)}.</p>
      <p>Grid north is not true north either: here the meridian leans ${Math.abs(conv).toFixed(2)}${DEG}
      ${conv >= 0 ? "east" : "west"} of the grid lines, and the lean grows away from the central meridian.</p>`,
    cam: { E: 5e5, N: d.n, span: 1000e3 }, L: { coast: 1, scale: 1, grid: 0.6, grat: 1, cm: 1, edges: 1 }, rows: ["mga", "scale"], hi: ["kk"]
  });
  S.push({
    title: "Sixty zones",
    body: `<p>UTM is sixty of these transverse Mercators, one for each 6 degrees of longitude, numbered eastward from
      180${DEG}: zone 1 is 180${DEG}W to 174${DEG}W, and zone ${zone} is ${lonName(lon0 - 3)} to ${lonName(lon0 + 3)}.
      Each zone has its own central meridian and E 500 000, and they all share the equator, so the same numbers turn
      up in every zone: without the zone number a coordinate could be in any of sixty places.</p>
      <p>UTM was set up for military mapping after the Second World War. ${aus ? "Australia's national grid has been UTM ever since: the AMG on AGD66, then MGA on GDA94 and GDA2020." : "Most national grids that use it keep the zones and change only the datum."}</p>`,
    cam: { globe: [lon0, south ? -25 : 25], zoom: 0.92 }, L: { zones: 1, bandsLight: 0.5 }, rows: ["zone"], hi: ["d-gzd"]
  });
  S.push({
    title: `Band ${d.band}`,
    body: `<p>MGRS also cuts each zone into bands of 8 degrees of latitude, lettered C to X from 80${DEG}S (no I or O),
      so the bands ${south ? "C to M are south of the equator and N to X north of it" : "N to X are north of the equator and C to M south of it"}.
      A zone number and a band letter make a <b>grid zone</b>: ${nm} is in <b>${d.gzd}</b>, ${fmtLat(band[0], 0)} to
      ${fmtLat(band[1], 0)}${bandBelow ? `, with ${zone}${bandBelow} south of it` : ""}${bandAbove ? ` and ${zone}${bandAbove} north of it` : ""}.
      Its neighbours across the zone edges are ${(zone + 58) % 60 + 1}${d.band} and ${zone % 60 + 1}${d.band}.</p>
      <p>The band adds no digits to the coordinates: it is there so a reference with only the 100 km letters (which repeat
      every 2000 km of northing) can be placed, and so the hemisphere is never in doubt.${aus ? " Tasmania is almost all in 55G; Flinders Island reaches up into 55H, and King Island sits on the 144" + DEG + "E edge, mostly in 54H." : ""}</p>
      <p class="hint">The only exceptions are far north: 32V widened over south-west Norway, and the X band rearranged around Svalbard.</p>`,
    cam: { globe: [lon0, Math.max(-60, Math.min(60, P.lat * 0.8))], zoom: 2.1 }, L: { zones: 1, bands: 1 }, rows: ["zone"], hi: ["d-gzd"]
  });
  S.push({
    title: "Off the top and bottom: UPS",
    body: `<p>UTM stops at 80${DEG}S and 84${DEG}N. Beyond them the <b>Universal Polar Stereographic</b> grid takes over:
      one plane on each pole, at scale 0.994, with the pole at <b>E 2 000 000, N 2 000 000</b> so that, again,
      nothing is negative. Its grid lines (every 500 km here) are straight on the plane and cross at the pole.</p>
      <p>MGRS letters there are A and B in the south, west and east of Greenwich, and Y and Z in the north.</p>`,
    cam: { globe: [lon0, -90], zoom: 1.5 }, L: { zones: 1, bandsLight: 0.4, ups: 1 }, rows: ["zone"], hi: []
  });
  S.push({
    title: `Back to ${nm}`,
    body: `<p>Here are the numbers again, every one of them now a distance or a name:</p>
      <ul class="decode">
        <li><b>Zone ${zone}</b>: ${lonName(lon0 - 3)} to ${lonName(lon0 + 3)}, central meridian ${lonName(lon0)}; band
          <b>${d.band}</b> is ${fmtLat(band[0], 0)} to ${fmtLat(band[1], 0)}.</li>
        <li><b>E ${grp(d.e)}</b> = 500 000 false easting ${d.fromCM >= 0 ? "+" : "-"} ${grp(d.fromCM)} m
          ${d.fromCM >= 0 ? "east" : "west"} of ${lonName(lon0)}.</li>
        <li><b>N ${grp(d.n)}</b> = ${south ? `10 000 000 false northing - ${grp(fromEq)} m south of the equator` : `${grp(d.n)} m north of the equator`}.</li>
        <li><b>${d.square}</b>: the 100 km square, standing in for the leading ${G.splitDigits(d.e).hundredKm} and ${G.splitDigits(d.n).hundredKm}.</li>
        <li><b>${d.six.join(" ")}</b> and <b>${d.eight.join(" ")}</b>: the 100 m and 10 m squares inside it.</li>
        <li><b>${T ? [T.sa && T.sa.label, T.mb && T.mb.label].filter(Boolean).join("</b> and <b>") : `Map ${a.page} ${a.letter}${a.number}`}</b>: a page in a book.</li>
        <li>All of it on a cylinder ${M.K0} the size of the Earth, true to scale ${grp(off / 1000)} km either side of ${lonName(lon0)}.</li>
      </ul>`,
    cam: T ? realCam : { E: pageC[0] - 700, N: pageC[1] + 300, span: 6400 }, L: T ? { tiles: 1, real: 1, grid: 0.6 } : { tiles: 1, atlas: 1, pages: 1, grid: 0.6 },
    rows: ["atl", "six", "eight", "mgrs", "mga", "zone"], hi: ["all"]
  });
  for (let i = 1; i <= 4; i++) S[i].click = true;
  // in Tasmania, theLIST's own topographic map for the street steps
  if (T) for (const i of [0, 1, 2, 3, S.length - 1]) { const L = S[i].L; if (L.tiles) { L.topo = L.tiles; delete L.tiles; } }
  if (T) S.push(...bookSteps());
  return S;
}

// ---------------------------------------------------------------- the street atlas and map book

// GDA94 book coordinates onto this (GDA2020) grid
const toPlane = (x, y) => [x + T.dE, y + T.dN];
// a camera on a page frame, with room for its margin labels and tab
function bookCam(p, pad = 1.22) {
  const [E, N] = toPlane((p.xmin + p.xmax) / 2, (p.ymin + p.ymax) / 2);
  return { E, N: N + (p.ymax - p.ymin) * 0.03, span: Math.max(p.ymax - p.ymin, (p.xmax - p.xmin) * 0.9) * pad };
}

function bookSteps() {
  const S = [], sa = T.sa, mb = T.mb, nm = P.name;
  const pages = MR.pages, saP = pages.filter((p) => p.book === "SA"), mbP = pages.filter((p) => p.book === "MB");
  const saNums = [...new Set(saP.map((p) => p.page))].sort((x, y) => x - y);
  const box = mbP.reduce((b, p) => [Math.min(b[0], p.xmin), Math.min(b[1], p.ymin), Math.max(b[2], p.xmax), Math.max(b[3], p.ymax)], [Infinity, Infinity, -Infinity, -Infinity]);
  const [cE, cN] = toPlane((box[0] + box[2]) / 2, (box[1] + box[3]) / 2);
  const mbCam = mb ? (() => { const c = bookCam(mb.page, 1.14); return { ...c, E: c.E - c.span * 0.1 }; })() : null;
  const saCam = sa ? bookCam(sa.page) : mbCam;
  const ext = (p) => `${grp(p.xmax - p.xmin)} by ${grp(p.ymax - p.ymin)} m`;
  // the nearest inset page, and the squares it carries
  const pin = [T.e94, T.n94], mid = (p) => [(p.xmin + p.xmax) / 2, (p.ymin + p.ymax) / 2];
  const near = (list) => list.reduce((b, p) => { const d = Math.hypot(mid(p)[0] - pin[0], mid(p)[1] - pin[1]); return !b || d < b.d ? { p, d } : b; }, null);
  const tPages = saP.filter((p) => p.suffix === "T"), tFull = tPages.filter((p) => R.squares(MR, p.ref).length);
  const inset = near(tFull), half = near(saP.filter((p) => p.suffix && p.suffix !== "T"));
  const insetSq = inset ? R.squares(MR, inset.p.ref).map((q) => q.ref) : [];
  const insetCam = inset ? (() => { const [E, N] = toPlane(...mid(inset.p)); return { E, N, span: 2600 }; })() : saCam;
  const nb = sa ? R.neighbours(MR, sa.page.ref) : [];
  const sq = sa && sa.square, mbs = mb && mb.square;

  S.push({
    part: 2, title: "Two books",
    body: `<p>Tasmania has two books of maps that emergency services use for callouts, and theLIST (Land Tasmania) publishes
      their pages and squares. The <b>map book</b> (grey) covers the whole state in ${mbP.length} pages, MB001 to
      MB${String(Math.max(...mbP.map((p) => p.page))).padStart(3, "0")}. The <b>street atlas</b> (blue) covers the towns in
      ${saP.length} page frames, numbered ${saNums[0]} to ${saNums[saNums.length - 1]}.</p>
      <p>${nm} is on ${mb ? `map book page <b>${mb.page.ref}</b>` : "no map book page"}${sa ? ` and street atlas page <b>${sa.page.ref}</b>` : ""}.
      Both books are drawn on the national grid of their day, <b>GDA94 / MGA zone 55</b> (EPSG:28355), and every page corner
      is a whole number of metres in it.</p>`,
    cam: { E: cE, N: cN, span: (box[3] - box[1]) * 1.08 }, L: { coast: 1, mapbook: 0.55, mbAll: 1, saAll: 1 }, rows: ["atl"], hi: ["atl"], click: true
  });
  if (mb) S.push({
    title: "The map book is arithmetic",
    body: `<p>Map book pages are <b>12 km wide and 18 km tall</b>, on a lattice: their edges are at E 4 000 + 12 000k and
      N 12 000 + 18 000k (one page, MB001, sits 2 km off it). Each page is a grid of <b>500 m squares</b>, 24 columns
      lettered A to X from west to east and 36 rows numbered from the top.</p>
      <p>So the square is arithmetic: column ${mbs.col} is floor((E - ${grp(mb.page.xmin)}) / 500) + 1 = ${"ABCDEFGHIJKLMNOPQRSTUVWX".indexOf(mbs.col) + 1},
      and row ${mbs.row} is floor((${grp(mb.page.ymax)} - N) / 500) + 1, giving <b>${mb.label}</b>. Only the page number
      needs the table: pages are numbered in rows from north to south, west to east, but pages that are all sea are skipped.</p>`,
    cam: mbCam, L: { mapbook: 0.9, mbAll: 0.3, mbPage: 1, grid: 0.35 }, rows: ["atl", "mga"], hi: ["atl"], click: true
  });
  if (mb) S.push({
    title: "Street atlas pages are placed by hand",
    body: `<p>The street atlas pages (blue) on ${mb.page.ref}. They were laid out to cover built-up ground, so they do not
      sit on a lattice: page positions come only from the table. Pages with a suffix are extensions of their parent:
      <b>N</b> and <b>S</b> are half-height (3 150 by 1 650 m), <b>E</b> and <b>W</b> half-width (1 500 by 3 650 m), and
      <b>T</b> pages are small insets.</p>`,
    cam: mbCam, L: { mapbook: 0.8, mbPage: 0.35, saAll: 1, saLabels: 1 }, rows: ["atl"], hi: ["atl"], click: true
  });
  if (sa) S.push({
    title: "Six by seven, on the MGA lattice",
    body: `<p>${sa.page.ref} is ${ext(sa.page)}. Inside a <b>75 m margin</b> it holds 6 x 7 squares of <b>500 m</b>, columns
      A to F and rows 1 to 7, with the letters and numbers printed in the margin.</p>
      <p>The squares sit on the MGA 500 m lattice: every corner is a multiple of 500 m, so every second line is a kilometre grid
      line (cyan), and a street atlas square is a quarter of a kilometre square. ${nm}'s square <b>${sa.label}</b> runs from
      E ${grp(sq.xmin)} to ${grp(sq.xmax)} and N ${grp(sq.ymin)} to ${grp(sq.ymax)}, inside the four-figure square
      ${String(Math.floor(sq.xmin / 1000) % 100).padStart(2, "0")}${String(Math.floor(sq.ymin / 1000) % 100).padStart(2, "0")}.</p>`,
    cam: saCam, L: { topo: 0.8, saPage: 1, grid: 1 }, rows: ["atl", "six"], hi: ["atl", "d-km"], click: true
  });
  if (sa && nb.length) S.push({
    title: "Margins overlap",
    body: `<p>The margins make neighbouring frames overlap by 150 m (orange), so a point near a page edge can be on two
      pages, each with its own reference for the same square. ${sa.page.ref} shares ground with
      ${nb.map((p) => p.ref).join(", ")}.${T.hits.filter((h) => h.book === "SA").length > 1 ? ` ${nm} is on ${T.hits.filter((h) => h.book === "SA").map((h) => h.page.ref).join(" and ")}.` : ""}</p>`,
    cam: { ...saCam, span: saCam.span * 2.1 }, L: { topo: 0.6, saPage: 0.6, overlap: 1, saAll: 0.5, saLabels: 1 }, rows: ["atl"], hi: ["atl"], click: true
  });
  if (inset) S.push({
    title: "Insets",
    body: `<p>A <b>T</b> page is a small inset, and it can sit away from its parent page. The nearest to ${nm} is
      <b>${inset.p.ref}</b> (${ext(inset.p)}), which holds square${insetSq.length === 1 ? "" : "s"} ${insetSq.join(", ") || "none"}:
      labelled with the parent page's number, so a square reference never has a suffix, but its square can be drawn on a
      suffix page.${half ? ` The nearest half page is ${half.p.ref} (${ext(half.p)}).` : ""}</p>
      <p>The published layers are not complete: only ${tFull.length} of the ${tPages.length} insets have squares of their own
      page number inside them, and nine pages have a frame but no squares at all.</p>`,
    cam: insetCam, L: { topo: 0.8, saAll: 0.6, saLabels: 1, inset: 1 }, rows: ["atl"], hi: ["atl"], insetRef: inset.p.ref
  });
  if (sa) S.push({
    title: "Where on the page",
    body: `<p>A point's place on a page is measured from the frame's top-left corner: ${nm} is <b>${grp(sa.dx)} m east and
      ${grp(sa.dy)} m south</b> of the corner of ${sa.page.ref}, or u = ${sa.u.toFixed(3)} and v = ${sa.v.toFixed(3)} as
      fractions of the frame.${mb ? ` On ${mb.page.ref} it is ${grp(mb.dx)} m east and ${grp(mb.dy)} m south (u = ${mb.u.toFixed(3)}, v = ${mb.v.toFixed(3)}).` : ""}</p>
      <p>A scan of a printed page has the frame's corners as its corners, so u and v scale straight to pixels on it.</p>`,
    cam: saCam, L: { topo: 0.8, saPage: 1, uv: 1 }, rows: ["atl"], hi: ["atl"], click: true
  });
  S.push({
    title: "GDA94, and whole metres",
    body: `<p>The books are on GDA94. The same spot has GDA2020 coordinates about ${Math.hypot(T.dE, T.dN).toFixed(1)} m away
      (E ${T.dE >= 0 ? "+" : "-"}${Math.abs(T.dE).toFixed(2)}, N ${T.dN >= 0 ? "+" : "-"}${Math.abs(T.dN).toFixed(2)} m here), which
      matters only within a metre or two of a square's edge. This page takes the pin to GDA94 (EPSG:8048) before it
      looks it up: on GDA94 ${nm} is E ${grp(T.e94)}, N ${grp(T.n94)}.</p>
      <p>theLIST serves the pages in Web Mercator, projected from GDA94 / MGA 55 as if GDA94 were WGS84. Taken back to
      EPSG:28355 with no datum shift, the corners come out in whole metres again: the grid the books were drawn on.</p>`,
    cam: sa ? { ...toPlaneCam(sa.square), span: 900 } : mbCam, L: { topo: 1, saPage: 1, grid: 1 }, rows: ["atl", "mga"], hi: ["atl"], click: true
  });
  return S;
}
const toPlaneCam = (q) => { const [E, N] = toPlane((q.xmin + q.xmax) / 2, (q.ymin + q.ymax) / 2); return { E, N }; };

// a book rectangle as screen x, y, w, h
function bookRect(v, x0, y0, x1, y1) {
  const [a, b] = v.px(...toPlane(x0, y1)), [c, d] = v.px(...toPlane(x1, y0));
  return [a, b, c - a, d - b];
}
function pageTab(ctx, v, p, color, lift = 0) {
  let [x, y, w] = bookRect(v, p.xmin, p.ymin, p.xmax, p.ymax);
  y -= lift;
  const tab = p.ref;
  ctx.font = "600 15px system-ui, sans-serif";
  const tw = ctx.measureText(tab).width + 14;
  ctx.fillStyle = color; ctx.fillRect(x + w - tw, y - 24, tw, 24);
  label(ctx, tab, x + w - tw / 2, y - 12, { size: 15, bold: true, align: "center", color: "#ffffff", halo: false });
}
function hiRect(ctx, r) {
  ctx.fillStyle = "rgba(255,211,77,0.3)"; ctx.fillRect(...r);
  ctx.strokeStyle = C.tm; ctx.lineWidth = 2.5; ctx.strokeRect(...r);
}

function drawSAPage(ctx, v, ref, hi) {
  const f = R.frame(MR, ref);
  if (!f) return;
  const p = f.page, r = bookRect(v, p.xmin, p.ymin, p.xmax, p.ymax);
  ctx.fillStyle = "rgba(255,250,235,0.12)"; ctx.fillRect(...r);
  ctx.strokeStyle = "rgba(60,70,200,0.95)"; ctx.lineWidth = 1;
  for (const s of f.squares) ctx.strokeRect(...bookRect(v, s.xmin, s.ymin, s.xmax, s.ymax));
  if (hi) for (const s of f.squares) if (s.ref === hi.ref) hiRect(ctx, bookRect(v, s.xmin, s.ymin, s.xmax, s.ymax));
  ctx.strokeStyle = "#5865f2"; ctx.lineWidth = 3; ctx.strokeRect(...r);
  const mpx = Math.min(f.margin.top || 75, 75) * v.s, fs = Math.max(9, Math.min(15, mpx * 0.85));
  if (mpx >= 7) {
    for (const c of f.cols) for (const yy of [c.yTop, c.yBottom]) {
      const [x, y] = v.px(...toPlane(c.x, yy));
      label(ctx, c.label, x, y, { size: fs, bold: true, align: "center", color: "#c3c9ff" });
    }
    for (const rw of f.rows) for (const xx of [rw.xLeft, rw.xRight]) {
      const [x, y] = v.px(...toPlane(xx, rw.y));
      label(ctx, String(rw.label), x, y, { size: fs, bold: true, align: "center", color: "#c3c9ff" });
    }
  }
  pageTab(ctx, v, p, "#3b44c4");
}

function drawMBPage(ctx, v, p, hi) {
  const r = bookRect(v, p.xmin, p.ymin, p.xmax, p.ymax), sq = 500 * v.s;
  ctx.strokeStyle = "rgba(230,90,40,0.55)"; ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let c = 1; c < 24; c++) { const x = r[0] + c * sq; ctx.moveTo(x, r[1]); ctx.lineTo(x, r[1] + r[3]); }
  for (let k = 1; k < 36; k++) { const y = r[1] + k * sq; ctx.moveTo(r[0], y); ctx.lineTo(r[0] + r[2], y); }
  ctx.stroke();
  if (hi) hiRect(ctx, bookRect(v, hi.xmin, hi.ymin, hi.xmax, hi.ymax));
  ctx.strokeStyle = "#e8590c"; ctx.lineWidth = 3; ctx.strokeRect(...r);
  const fs = Math.max(8, Math.min(13, sq * 0.6));
  if (sq >= 9) {
    for (let c = 0; c < 24; c++) label(ctx, "ABCDEFGHIJKLMNOPQRSTUVWX"[c], r[0] + (c + 0.5) * sq, r[1] - 8, { size: fs, align: "center", color: "#ffb38a" });
    for (let k = 0; k < 36; k++) label(ctx, String(k + 1), r[0] - 6, r[1] + (k + 0.5) * sq, { size: fs, align: "right", color: "#ffb38a" });
  }
  pageTab(ctx, v, p, "#c2410c", sq >= 9 ? 18 : 0);
}

function drawBooksAll(ctx, v, book, labels) {
  const isSA = book === "SA";
  for (const p of MR.pages) {
    if (p.book !== book) continue;
    const r = bookRect(v, p.xmin, p.ymin, p.xmax, p.ymax);
    if (r[0] > v.w || r[0] + r[2] < 0 || r[1] > v.h || r[1] + r[3] < 0) continue;
    const mine = T && ((isSA && T.sa && T.sa.page === p) || (!isSA && T.mb && T.mb.page === p));
    ctx.fillStyle = isSA ? (mine ? "rgba(90,130,255,0.55)" : "rgba(70,110,255,0.28)") : (mine ? "rgba(232,89,12,0.3)" : "rgba(200,205,215,0.06)");
    ctx.fillRect(...r);
    ctx.strokeStyle = isSA ? "rgba(110,150,255,0.95)" : mine ? "#e8590c" : "rgba(200,205,215,0.5)"; ctx.lineWidth = mine ? 2 : 1;
    ctx.strokeRect(...r);
    const show = isSA ? labels && r[2] > 30 : r[2] > 22;
    if (show) label(ctx, isSA ? p.ref : String(p.page), r[0] + r[2] / 2, r[1] + r[3] / 2, { size: isSA ? 11 : Math.min(13, r[2] / 3), align: "center", color: isSA ? "#dfe6ff" : mine ? "#ffd0b8" : "rgba(220,226,236,0.8)" });
  }
}

function drawOverlap(ctx, v) {
  if (!T.sa) return;
  const p = T.sa.page;
  for (const q of R.neighbours(MR, p.ref)) {
    const x0 = Math.max(p.xmin, q.xmin), x1 = Math.min(p.xmax, q.xmax), y0 = Math.max(p.ymin, q.ymin), y1 = Math.min(p.ymax, q.ymax);
    if (x1 <= x0 || y1 <= y0) continue;
    ctx.fillStyle = "rgba(255,159,67,0.55)"; ctx.fillRect(...bookRect(v, x0, y0, x1, y1));
  }
}

function drawUV(ctx, v) {
  if (!T.sa) return;
  const p = T.sa.page, [x0, y0] = v.px(...toPlane(p.xmin, p.ymax)), [xp, yp] = v.px(D.e, D.n);
  arrow(ctx, x0, y0 - 14, xp, y0 - 14, C.tm, `dx ${grp(T.sa.dx)} m, u ${T.sa.u.toFixed(3)}`, { both: false });
  arrow(ctx, x0 - 14, y0, x0 - 14, yp, C.tm, "", { both: false });
  label(ctx, `dy ${grp(T.sa.dy)} m`, x0 - 20, (y0 + yp) / 2 - 8, { color: C.tm, size: 13, bold: true, align: "right" });
  label(ctx, `v ${T.sa.v.toFixed(3)}`, x0 - 20, (y0 + yp) / 2 + 10, { color: C.tm, size: 13, bold: true, align: "right" });
  ctx.strokeStyle = C.tm; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x0, yp); ctx.lineTo(xp, yp); ctx.moveTo(xp, y0); ctx.lineTo(xp, yp); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = C.tm; ctx.beginPath(); ctx.arc(x0, y0, 5, 0, 2 * Math.PI); ctx.fill();
}

// ---------------------------------------------------------------- panel and refbar

function renderSteps() {
  $("steps").innerHTML = STEPS.map((s, i) => (s.part === 2 ? `<div class="part-head"><h2>Part 2: the street atlas and the map book</h2><p class="hint">Tasmania's two emergency map books, from theLIST.</p></div>` : "") +
    `<section class="step" data-i="${i}"><h2><span class="n">${i + 1}</span>${s.title}</h2>${s.body}</section>`).join("");
  const j = $("jump");
  j.innerHTML = STEPS.map((s, i) => `<option value="${i}">${i + 1}. ${s.title}</option>`).join("");
  stepEls = [...document.querySelectorAll("#steps .step")];
}

function renderRefbar() {
  const d = D, a = d.atlas;
  const rows = {
    atl: T ? `<span class="k">Map books</span><span class="v">${[T.sa && T.sa.label, T.mb && T.mb.label].filter(Boolean).map((x) => `<i class="atl">${x}</i>`).join(" ")}</span>`
      : `<span class="k">Directory</span><span class="v"><i class="atl">Map ${a.page}</i> <i class="atl">${a.letter}${a.number}</i></span>`,
    six: `<span class="k">6-figure</span><span class="v">${shortSpans(d.six)}</span>`,
    eight: `<span class="k">8-figure</span><span class="v">${shortSpans(d.eight)}</span>`,
    mgrs: `<span class="k">MGRS</span><span class="v"><i class="d-gzd">${d.gzd}</i> <i class="d-hk">${d.square}</i> ${shortSpans(G.shortRef(d.e, d.n, 10))}</span>`,
    mga: `<span class="k">${south && P.lon > 110 && P.lon < 156 ? "MGA" : "UTM"} ${zone}</span><span class="v"><span class="d-e">E ${digitSpans(d.e)}</span> <span class="d-n">N ${digitSpans(d.n)}</span></span>`,
    zone: `<span class="k">Zone</span><span class="v"><i class="d-gzd">${zone}${d.band}</i> ${lonName(lon0 - 3)}-${lonName(lon0 + 3)}, CM ${lonName(lon0)}</span>`,
    scale: `<span class="k">Scale</span><span class="v"><i class="kk">k ${d.k.toFixed(6)}</i></span>`
  };
  $("refbar").innerHTML = `<button type="button" class="rb-toggle" aria-label="Show or hide the grid reference card"></button>` +
    Object.entries(rows).map(([k, v]) => `<div class="row r-${k}">${v}</div>`).join("");
  lastBar = -1;
}

let lastBar = -1;
function updateRefbar(i) {
  if (i === lastBar) return;
  lastBar = i;
  const s = STEPS[i], bar = $("refbar");
  let first = true;
  for (const el of bar.querySelectorAll(".row")) {
    el.hidden = !s.rows.includes(el.className.split(" ")[1].slice(2));
    el.classList.toggle("first", !el.hidden && first);
    if (!el.hidden) first = false;
  }
  bar.classList.toggle("multi", s.rows.length > 1);
  bar.classList.toggle("focus", !s.hi.includes("all") && s.hi.length > 0);
  for (const el of bar.querySelectorAll("i, .d-e, .d-n")) {
    const on = s.hi.some((c) => el.classList.contains(c) || (el.parentElement && el.parentElement.classList.contains(c)));
    el.classList.toggle("on", on);
  }
}

// ---------------------------------------------------------------- scroll to step number

let stepEls = [], t = 0, tTarget = null;
const embed = isEmbed();

// the reading line: a step is reached when its top comes up to it, holds
// for the first third of its length, then turns into the next
function readingLine() {
  const pr = $("panel").getBoundingClientRect();
  const top = Math.max(pr.top, 0), bottom = Math.min(pr.bottom, window.innerHeight);
  return top + (bottom - top) * 0.3;
}
function scrollT() {
  if (!stepEls.length) return 0;
  const line = readingLine();
  const tops = stepEls.map((el) => el.getBoundingClientRect().top);
  if (line <= tops[0]) return 0;
  for (let i = 0; i < tops.length - 1; i++) {
    if (line < tops[i + 1]) return i + Math.max(0, Math.min(1, ((line - tops[i]) / Math.max(1, tops[i + 1] - tops[i]) - 0.3) / 0.7));
  }
  return tops.length - 1;
}
function scrollToStep(i, behavior) {
  const panel = $("panel");
  const d = stepEls[i].getBoundingClientRect().top - readingLine() + 2;
  if (panel.scrollHeight > panel.clientHeight + 2) panel.scrollBy({ top: d, behavior });
  else window.scrollBy({ top: d, behavior });
}

function goTo(i) {
  i = Math.max(0, Math.min(STEPS.length - 1, i));
  if (embed) { tTarget = i; animate(); }
  else scrollToStep(i, "smooth");
  state.s = i; writeHash();
}

let animating = false;
function animate() {
  if (animating) return;
  animating = true;
  const tick = () => {
    const dt = tTarget - t;
    t = Math.abs(dt) < 0.002 ? tTarget : t + dt * 0.12;
    schedule();
    if (t !== tTarget) requestAnimationFrame(tick); else animating = false;
  };
  requestAnimationFrame(tick);
}

function onScroll() {
  if (embed) return;
  t = scrollT();
  const i = Math.round(t);
  if (i !== state.s) { state.s = i; writeHash(); $("jump").value = String(i); }
  schedule();
}

// ---------------------------------------------------------------- interpolation

const smooth = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => a + (b - a) * u;

function frameAt(t) {
  const i = Math.min(STEPS.length - 1, Math.floor(t)), j = Math.min(STEPS.length - 1, i + 1);
  const u = smooth(Math.min(1, Math.max(0, t - i)));
  const A = STEPS[i], B = STEPS[j];
  const layer = (k) => lerp(A.L[k] || 0, B.L[k] || 0, u);
  const ga = !!A.cam.globe, gb = !!B.cam.globe;
  const globeAlpha = lerp(ga ? 1 : 0, gb ? 1 : 0, u);
  let plane = null, globe = null;
  if (!ga && !gb) plane = planeCam(A.cam, B.cam, u);
  else if (!ga) plane = { ...A.cam, span: A.cam.span * (1 + u * 0.6) };
  else if (!gb) plane = { ...B.cam, span: B.cam.span * (1 + (1 - u) * 0.6) };
  if (ga && gb) globe = globeCam(A.cam, B.cam, u);
  else if (ga) globe = { ...A.cam, zoom: A.cam.zoom * (1 - u * 0.3) };
  else if (gb) globe = { ...B.cam, zoom: B.cam.zoom * (0.7 + u * 0.3) };
  return { i: Math.round(t), layer, plane, globe, globeAlpha };
}

// zoom in log space; the centre moves in step with the span, so the place
// being zoomed to stays in view the whole way
function planeCam(a, b, u) {
  const span = Math.exp(lerp(Math.log(a.span), Math.log(b.span), u));
  let w = u;
  if (Math.abs(Math.log(a.span / b.span)) > 0.1) w = 1 - (span - b.span) / (a.span - b.span);
  return { E: lerp(a.E, b.E, w), N: lerp(a.N, b.N, w), span };
}
function globeCam(a, b, u) {
  let dl = ((b.globe[0] - a.globe[0] + 540) % 360) - 180;
  return { globe: [a.globe[0] + dl * u, lerp(a.globe[1], b.globe[1], u)], zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), u)) };
}

// ---------------------------------------------------------------- drawing

const map = $("map");
// the reader's own pan and zoom, on top of the step's camera, until the step changes
let user = { dE: 0, dN: 0, z: 1 }, userStep = -1;
let pending = false, coast50 = null, coast110 = null, coastZone = null, view = null;
function schedule() { if (!pending) { pending = true; requestAnimationFrame(draw); } }

function draw() {
  pending = false;
  if (!D) return;
  const box = map.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(10, box.width), h = Math.max(10, box.height);
  if (map.width !== Math.round(w * dpr) || map.height !== Math.round(h * dpr)) { map.width = Math.round(w * dpr); map.height = Math.round(h * dpr); }
  const ctx = map.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
  const f = frameAt(t);
  updateRefbar(f.i);
  if (f.i !== userStep) { user = { dE: 0, dN: 0, z: 1 }; userStep = f.i; }
  if (f.plane) f.plane = { E: f.plane.E + user.dE, N: f.plane.N + user.dN, span: f.plane.span * user.z };
  $("recentre").hidden = !(user.dE || user.dN || user.z !== 1) || !f.plane || f.globeAlpha > 0.5;
  view = null;
  if (f.plane && f.globeAlpha < 0.999) {
    ctx.globalAlpha = 1 - f.globeAlpha;
    drawPlane(ctx, f.plane, f.layer, w, h, dpr);
  }
  if (f.globe && f.globeAlpha > 0.001) {
    ctx.globalAlpha = f.globeAlpha;
    drawGlobe(ctx, f.globe, f.layer, w, h);
  }
  ctx.globalAlpha = 1;
  updateScalebar(f);
}

// ---------------------------------------------------------------- the plane

function makeView(cam, w, h) {
  const s = Math.min(w, h) / cam.span;
  return {
    w, h, s, cam,
    px: (E, N) => [w / 2 + (E - cam.E) * s, h / 2 - (N - cam.N) * s],
    en: (x, y) => [cam.E + (x - w / 2) / s, cam.N - (y - h / 2) / s],
    E0: cam.E - w / 2 / s, E1: cam.E + w / 2 / s, N0: cam.N - h / 2 / s, N1: cam.N + h / 2 / s
  };
}

function drawPlane(ctx, cam, L, w, h, dpr) {
  const v = makeView(cam, w, h);
  view = v;
  const base = ctx.globalAlpha, al = (k) => base * L(k);
  ctx.fillStyle = C.sea; ctx.globalAlpha = base; ctx.fillRect(0, 0, w, h);
  if (L("scale") > 0.01) { ctx.globalAlpha = al("scale"); drawScale(ctx, v); }
  let tileA = 0;
  for (const src of Object.keys(TILESRC)) {
    const a = L(src);
    tileA = Math.max(tileA, a);
    if (a > 0.01 && cam.span < 2000e3) { ctx.globalAlpha = base * a; drawTiles(ctx, v, dpr, src); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
  }
  if (L("coast") > 0.01 || tileA < 0.99) { ctx.globalAlpha = base * Math.max(L("coast"), 0.4 * (1 - tileA)); drawCoast(ctx, v); }
  if (L("grat") > 0.01) { ctx.globalAlpha = al("grat"); drawGraticule(ctx, v); }
  if (L("pages") > 0.01) { ctx.globalAlpha = al("pages"); drawPages(ctx, v, false); }
  if (L("atlas") > 0.01) { ctx.globalAlpha = al("atlas"); drawPages(ctx, v, true); }
  if (T && MR) {
    if (L("mbAll") > 0.01) { ctx.globalAlpha = al("mbAll"); drawBooksAll(ctx, v, "MB", false); }
    if (L("saAll") > 0.01) { ctx.globalAlpha = al("saAll"); drawBooksAll(ctx, v, "SA", L("saLabels") > 0.5); }
    if (L("mbPage") > 0.01 && T.mb) { ctx.globalAlpha = al("mbPage"); drawMBPage(ctx, v, T.mb.page, T.mb.square); }
    if (L("overlap") > 0.01) { ctx.globalAlpha = al("overlap"); drawOverlap(ctx, v); }
    const rp = Math.max(L("saPage"), L("real"));
    if (rp > 0.01 && T.sa) { ctx.globalAlpha = base * rp; drawSAPage(ctx, v, T.sa.page.ref, T.sa.square); }
    if (L("real") > 0.01 && !T.sa && T.mb) { ctx.globalAlpha = al("real"); drawMBPage(ctx, v, T.mb.page, T.mb.square); }
    if (L("inset") > 0.01) { const st = STEPS.find((q) => q.insetRef); if (st) { ctx.globalAlpha = al("inset"); drawSAPage(ctx, v, st.insetRef, null); } }
    if (L("uv") > 0.01) { ctx.globalAlpha = al("uv"); drawUV(ctx, v); }
  }
  if (L("grid") > 0.01) { ctx.globalAlpha = al("grid"); drawGrid(ctx, v); }
  if (L("sq100") > 0.01) { ctx.globalAlpha = al("sq100"); drawSquares(ctx, v); }
  if (L("cell100") > 0.01) { ctx.globalAlpha = al("cell100"); drawCell(ctx, v, 100, C.hm); }
  if (L("cell10") > 0.01) { ctx.globalAlpha = al("cell10"); drawCell(ctx, v, 10, C.tm); }
  if (L("edges") > 0.01) { ctx.globalAlpha = al("edges"); drawEdges(ctx, v); }
  if (L("cm") > 0.01) { ctx.globalAlpha = al("cm"); drawCM(ctx, v); }
  if (L("equator") > 0.01) { ctx.globalAlpha = al("equator"); drawEquator(ctx, v); }
  if (L("width") > 0.01) { ctx.globalAlpha = al("width"); drawWidth(ctx, v); }
  if (L("offsetE") > 0.01) { ctx.globalAlpha = al("offsetE"); drawOffsetE(ctx, v); }
  if (L("offsetN") > 0.01) { ctx.globalAlpha = al("offsetN"); drawOffsetN(ctx, v); }
  if (L("pole") > 0.01) { ctx.globalAlpha = al("pole"); drawPole(ctx, v); }
  if (L("origin") > 0.01) { ctx.globalAlpha = al("origin"); drawOrigin(ctx, v); }
  ctx.globalAlpha = base;
  drawPin(ctx, v);
}

const inView = (v, x, y, m = 40) => x > -m && x < v.w + m && y > -m && y < v.h + m;

function label(ctx, text, x, y, { color = C.ink, size = 12, align = "left", base = "middle", bold = false, halo = true } = {}) {
  ctx.font = `${bold ? "600 " : ""}${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.textAlign = align; ctx.textBaseline = base;
  if (halo) { ctx.lineWidth = 3; ctx.strokeStyle = "rgba(5,7,13,0.85)"; ctx.lineJoin = "round"; ctx.strokeText(text, x, y); }
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

// polyline of lon/lat points through the zone's projection
function strokeLL(ctx, v, pts) {
  ctx.beginPath();
  let pen = false, last = null;
  for (const [lon, lat] of pts) {
    const dl = Math.abs(((lon - lon0 + 540) % 360) - 180);
    if (dl > 85 || !isFinite(lat)) { pen = false; continue; }
    const [x, y] = v.px(...fwd(lon, lat));
    if (pen && last && Math.hypot(x - last[0], y - last[1]) > 4000) pen = false;
    if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    pen = true; last = [x, y];
  }
  ctx.stroke();
}

// coastlines, projected once per zone
function projectedCoast() {
  if (!coast50) return null;
  if (coastZone && coastZone.zone === zone && coastZone.south === south) return coastZone.lines;
  const lines = [];
  for (const line of coast50) {
    const xy = new Float64Array(line.length);
    let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
    for (let k = 0; k < line.length; k += 2) {
      const dl = Math.abs(((line[k] - lon0 + 540) % 360) - 180);
      if (dl > 80 && Math.abs(line[k + 1]) < 70) { xy[k] = NaN; xy[k + 1] = NaN; continue; }
      const [E, N] = fwd(line[k], line[k + 1]);
      if (Math.abs(E - 5e5) > 6e6) { xy[k] = NaN; xy[k + 1] = NaN; continue; }
      xy[k] = E; xy[k + 1] = N;
      e0 = Math.min(e0, E); e1 = Math.max(e1, E); n0 = Math.min(n0, N); n1 = Math.max(n1, N);
    }
    if (e0 < Infinity) lines.push({ xy, e0, e1, n0, n1 });
  }
  coastZone = { zone, south, lines };
  return lines;
}

function drawCoast(ctx, v) {
  const lines = projectedCoast();
  if (!lines) return;
  ctx.strokeStyle = C.coast; ctx.lineWidth = 1;
  ctx.beginPath();
  for (const l of lines) {
    if (l.e1 < v.E0 || l.e0 > v.E1 || l.n1 < v.N0 || l.n0 > v.N1) continue;
    let pen = false, lx = 0, ly = 0;
    for (let k = 0; k < l.xy.length; k += 2) {
      if (!isFinite(l.xy[k])) { pen = false; continue; }
      const x = v.w / 2 + (l.xy[k] - v.cam.E) * v.s, y = v.h / 2 - (l.xy[k + 1] - v.cam.N) * v.s;
      if (pen && Math.abs(x - lx) + Math.abs(y - ly) > 3000) pen = false;
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true; lx = x; ly = y;
    }
  }
  ctx.stroke();
}

// the lon/lat range the view covers, from a lattice of its points
function viewLL(v) {
  let lo0 = Infinity, lo1 = -Infinity, la0 = Infinity, la1 = -Infinity;
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
    const [lon, lat] = inv(lerp(v.E0, v.E1, i / 6), lerp(v.N0, v.N1, j / 6));
    if (!isFinite(lon) || !isFinite(lat)) continue;
    const l = lon0 + (((lon - lon0 + 540) % 360) - 180);
    lo0 = Math.min(lo0, l); lo1 = Math.max(lo1, l); la0 = Math.min(la0, lat); la1 = Math.max(la1, lat);
  }
  return { lo0, lo1, la0, la1 };
}

function niceDeg(span) {
  for (const s of [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30]) if (span / s <= 8) return s;
  return 30;
}

function drawGraticule(ctx, v) {
  let { lo0, lo1, la0, la1 } = viewLL(v);
  const big = v.cam.span > 2.5e6;
  if (big) { lo0 = lon0 - 84; lo1 = lon0 + 84; la0 = -90; la1 = 90; }
  const st = big ? 10 : niceDeg(Math.max(lo1 - lo0, la1 - la0));
  ctx.strokeStyle = C.grat; ctx.lineWidth = 1;
  const pad = st;
  for (let lon = Math.ceil((lo0 - pad) / st) * st; lon <= lo1 + pad; lon += st) {
    const pts = [];
    for (let k = 0; k <= 160; k++) pts.push([lon, Math.max(-89.999, Math.min(89.999, lerp(la0 - pad, la1 + pad, k / 160)))]);
    strokeLL(ctx, v, pts);
  }
  for (let lat = Math.ceil((la0 - pad) / st) * st; lat <= la1 + pad; lat += st) {
    if (Math.abs(lat) >= 90) continue;
    const pts = [];
    for (let k = 0; k <= 160; k++) pts.push([lerp(lo0 - pad, lo1 + pad, k / 160), lat]);
    strokeLL(ctx, v, pts);
  }
  // a few labels along the bottom and right
  const dec = st < 0.1 ? 2 : st < 1 ? 1 : 0;
  if (big) return;
  for (let lon = Math.ceil(lo0 / st) * st; lon <= lo1; lon += st) {
    const lat = inv(v.cam.E, v.N0 + 30 / v.s)[1];
    const [x, y] = v.px(...fwd(lon, lat));
    if (x > 60 && x < v.w - 60 && y > 0 && y < v.h) label(ctx, fmtLon(lon, dec), x + 3, v.h - 14, { color: "rgba(160,205,255,0.85)", size: 10 });
  }
  for (let lat = Math.ceil(la0 / st) * st; lat <= la1; lat += st) {
    const lon = inv(v.E1 - 40 / v.s, v.cam.N)[0];
    const [x, y] = v.px(...fwd(lon, lat));
    if (y > 30 && y < v.h - 30 && x > 0) label(ctx, fmtLat(lat, dec), v.w - 6, y - 7, { color: "rgba(160,205,255,0.85)", size: 10, align: "right" });
  }
}

// grid lines at a spacing that suits the zoom, the next coarser ones heavier,
// labelled the way topographic maps do: the digits that count this spacing
// large, the ones in front small
function gridSpacing(v) {
  for (const sp of [1, 10, 100, 1e3, 1e4, 1e5, 1e6]) if (sp * v.s >= 46) return sp;
  return 1e6;
}
function drawGrid(ctx, v) {
  const sp = gridSpacing(v);
  const levels = [sp * 10, sp].filter((x) => x <= 1e6);
  for (const s of levels) {
    const heavy = s !== sp;
    ctx.strokeStyle = SPACING_COLOUR[s] || C.km;
    ctx.lineWidth = heavy ? 1.6 : 0.8;
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * (heavy ? 0.95 : 0.6);
    ctx.beginPath();
    for (let E = Math.ceil(v.E0 / s) * s; E <= v.E1; E += s) { const [x] = v.px(E, 0); ctx.moveTo(x, 0); ctx.lineTo(x, v.h); }
    for (let N = Math.ceil(v.N0 / s) * s; N <= v.N1; N += s) { const [, y] = v.px(0, N); ctx.moveTo(0, y); ctx.lineTo(v.w, y); }
    ctx.stroke();
    ctx.globalAlpha = alpha;
  }
  // labels
  const lab = (val, x, y, align, vert) => {
    const [small, big] = splitLabel(val, sp);
    ctx.font = "11px system-ui, sans-serif";
    const ws = ctx.measureText(small).width;
    ctx.font = "600 15px system-ui, sans-serif";
    const wb = ctx.measureText(big).width;
    let x0 = align === "center" ? x - (ws + wb) / 2 : x;
    if (vert) x0 = x;
    label(ctx, small, x0, y + 1, { size: 11, color: SPACING_COLOUR[sp] || C.km });
    label(ctx, big, x0 + ws, y, { size: 15, bold: true, color: SPACING_COLOUR[sp] || C.km });
  };
  ctx.font = "600 15px system-ui, sans-serif";
  const widest = ctx.measureText(splitLabel(Math.max(Math.abs(v.E0), Math.abs(v.E1)), sp).join("")).width + 14;
  const stride = Math.max(1, Math.ceil(widest / (sp * v.s)));
  for (let E = Math.ceil(v.E0 / sp / stride) * sp * stride; E <= v.E1; E += sp * stride) {
    const [x] = v.px(E, 0);
    if (x > 30 && x < v.w - 30) lab(E, x, 12, "center", false);
  }
  for (let N = Math.ceil(v.N0 / sp) * sp; N <= v.N1; N += sp) {
    const [, y] = v.px(0, N);
    if (y > 24 && y < v.h - 30) lab(N, 4, y - 9, "left", true);
  }
}
function splitLabel(val, sp) {
  if (val < 0) return ["", ns(val)];
  if (sp >= 1e4) return ["", grp(val)];
  const s = String(Math.round(val)), digits = { 1e3: [5, 3], 100: [3, 2], 10: [2, 1], 1: [1, 0] }[sp];
  const head = s.slice(0, -digits[0]), big = s.slice(-digits[0], s.length - digits[1]);
  return [head, big];
}

function drawSquares(ctx, v) {
  const s = 1e5;
  if (s * v.s < 50) return;
  for (let E = Math.floor(v.E0 / s) * s; E < v.E1; E += s) {
    for (let N = Math.floor(v.N0 / s) * s; N < v.N1; N += s) {
      const col = E / s, row = N / s;
      if (col < 1 || col > 8 || N < 0 || N >= 1e7) continue;
      const lt = M.squareLetters(zone, col, row);
      if (!lt) continue;
      const [x, y] = v.px(E + s / 2, N + s * 0.72);
      const mine = Math.floor(D.e / s) === col && Math.floor(D.n / s) === row;
      if (mine) {
        const [x0, y0] = v.px(E, N + s);
        ctx.fillStyle = "rgba(255,159,67,0.14)"; ctx.fillRect(x0, y0, s * v.s, s * v.s);
      }
      label(ctx, lt, x, y, { size: Math.min(34, Math.max(12, s * v.s / 6)), align: "center", bold: true, color: mine ? C.hk : "rgba(255,159,67,0.6)" });
    }
  }
}

function drawCell(ctx, v, size, color) {
  const E = Math.floor(D.e / size) * size, N = Math.floor(D.n / size) * size;
  const [x0, y0] = v.px(E, N + size), wpx = size * v.s;
  ctx.fillStyle = color; const a = ctx.globalAlpha; ctx.globalAlpha = a * 0.22; ctx.fillRect(x0, y0, wpx, wpx);
  ctx.globalAlpha = a; ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.strokeRect(x0, y0, wpx, wpx);
  // the corner the reference names
  ctx.beginPath(); ctx.arc(x0, y0 + wpx, 4, 0, 2 * Math.PI); ctx.fillStyle = color; ctx.fill();
  const ref = size === 100 ? D.six.join(" ") : D.eight.join(" ");
  label(ctx, ref, x0 + 6, y0 + wpx + 14, { color, bold: true, size: 13 });
}

// street directory sheets: the pin's sheet with its squares, its
// neighbours outlined with their numbers
function drawPages(ctx, v, detail) {
  const a = D.atlas, A = G.ATLAS;
  const pw = A.pageW * v.s, ph = A.pageH * v.s;
  if (!detail) {
    ctx.strokeStyle = "rgba(43,47,143,0.8)"; ctx.lineWidth = 2;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      if (!i && !j) continue;
      const W = a.west + i * A.pageW, Nn = a.north - j * A.pageH;
      const pg = G.atlas(W + 1, Nn - 1);
      const [x, y] = v.px(W, Nn);
      if (!inView(v, x + pw / 2, y + ph / 2, pw)) continue;
      ctx.strokeRect(x, y, pw, ph);
      label(ctx, `${pg.page}`, x + pw / 2, y + ph / 2, { size: 26, bold: true, align: "center", color: "rgba(120,130,255,0.75)" });
    }
    return;
  }
  const [x, y] = v.px(a.west, a.north);
  ctx.fillStyle = "rgba(255,250,235,0.10)"; ctx.fillRect(x, y, pw, ph);
  // squares
  ctx.strokeStyle = "rgba(60,70,200,0.9)"; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 1; k < 8; k++) { ctx.moveTo(x + k * A.square * v.s, y); ctx.lineTo(x + k * A.square * v.s, y + ph); }
  for (let k = 1; k < 10; k++) { ctx.moveTo(x, y + k * A.square * v.s); ctx.lineTo(x + pw, y + k * A.square * v.s); }
  ctx.stroke();
  // the pin's square
  const [sx, sy] = v.px(a.squareWest, a.squareNorth);
  ctx.fillStyle = "rgba(255,211,77,0.28)"; ctx.fillRect(sx, sy, A.square * v.s, A.square * v.s);
  ctx.strokeStyle = C.tm; ctx.lineWidth = 2; ctx.strokeRect(sx, sy, A.square * v.s, A.square * v.s);
  // frame, letters and numbers
  ctx.strokeStyle = "#5865f2"; ctx.lineWidth = 3; ctx.strokeRect(x, y, pw, ph);
  const sq = A.square * v.s, fs = Math.max(10, Math.min(16, sq * 0.3));
  for (let k = 0; k < 8; k++) label(ctx, "ABCDEFGH"[k], x + (k + 0.5) * sq, y + fs * 0.9, { size: fs, bold: true, align: "center", color: "#aab4ff" });
  for (let k = 0; k < 10; k++) label(ctx, String(k + 1), x + 4, y + (k + 0.5) * sq, { size: fs, bold: true, color: "#aab4ff" });
  // page tab
  const tab = `Map ${a.page}`;
  ctx.font = "600 16px system-ui, sans-serif";
  const tw = ctx.measureText(tab).width + 16;
  ctx.fillStyle = "#3b44c4"; ctx.fillRect(x + pw - tw, y - 26, tw, 26);
  label(ctx, tab, x + pw - tw / 2, y - 13, { size: 16, bold: true, align: "center", color: "#ffffff", halo: false });
}

function drawEdges(ctx, v) {
  for (const lon of [lon0 - 3, lon0 + 3]) {
    ctx.strokeStyle = C.edge; ctx.lineWidth = 2;
    const pts = [];
    for (let k = 0; k <= 300; k++) pts.push([lon, -80 + (164 * k) / 300]);
    strokeLL(ctx, v, pts);
    // label where the edge crosses the pin's latitude, or the view's middle
    const lat = Math.max(-79, Math.min(83, inv(v.cam.E, v.cam.N)[1]));
    const [x, y] = v.px(...fwd(lon, lat));
    const narrow = Math.abs(v.px(...fwd(lon0 + 3, lat))[0] - v.px(...fwd(lon0 - 3, lat))[0]) < 110;
    if (!narrow && inView(v, x, y, -20)) label(ctx, `${lonName(lon)}, zone edge`, x + (lon < lon0 ? -6 : 6), y - 40, { color: C.edge, size: 12, bold: true, align: lon < lon0 ? "right" : "left" });
  }
  // the zone numbers, along the top, where the zones are wide enough
  const lat = Math.max(-79, Math.min(83, inv(v.cam.E, v.N1 - 80 / v.s)[1]));
  const wide = Math.abs(v.px(...fwd(lon0 + 3, lat))[0] - v.px(...fwd(lon0 - 3, lat))[0]) > 110;
  if (wide) for (const [dz, lon] of [[-1, lon0 - 6], [1, lon0 + 6]]) {
    const [x, y] = v.px(...fwd(lon, lat));
    const z = ((zone - 1 + dz + 60) % 60) + 1;
    if (inView(v, x, y, -30)) label(ctx, `zone ${z}`, x, y, { color: "rgba(255,122,184,0.75)", size: 13, align: "center" });
  }
  const [x, y] = v.px(...fwd(lon0, lat));
  label(ctx, `zone ${zone}`, x + (wide ? -8 : 8), y + 18, { color: C.edge, size: 15, bold: true, align: wide ? "right" : "left" });
}

function drawCM(ctx, v) {
  const [x] = v.px(5e5, 0);
  ctx.strokeStyle = C.cm; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.h); ctx.stroke();
  label(ctx, `${lonName(lon0)} = E 500 000`, x + 6, 44, { color: C.cm, size: 13, bold: true });
}

function drawEquator(ctx, v) {
  const N = south ? 1e7 : 0, [, y] = v.px(0, N);
  if (y < -10 || y > v.h + 10) return;
  ctx.strokeStyle = C.equator; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(v.w, y); ctx.stroke();
  label(ctx, `equator: N ${grp(N)}`, v.w - 10, y - 10, { color: C.equator, size: 13, bold: true, align: "right" });
}

function drawWidth(ctx, v) {
  const half = G.zoneWidth(0) / 2, N = south ? 1e7 : 0;
  for (const E of [5e5 - half, 5e5 + half]) {
    const [x, y] = v.px(E, N);
    ctx.fillStyle = C.edge; ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
    label(ctx, `E ${grp(E)}`, x + (E < 5e5 ? -6 : 6), y + 16, { color: C.edge, size: 12, bold: true, align: E < 5e5 ? "right" : "left" });
  }
  const [xa, y] = v.px(5e5 - half, N), [xb] = v.px(5e5 + half, N);
  arrow(ctx, xa, y + 32, xb, y + 32, C.edge, `${grp(2 * half / 1000)} km`);
}

function arrow(ctx, x0, y0, x1, y1, color, text, opts = {}) {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = opts.width || 2;
  if (opts.dash) ctx.setLineDash(opts.dash);
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  ctx.setLineDash([]);
  const ang = Math.atan2(y1 - y0, x1 - x0), len = Math.hypot(x1 - x0, y1 - y0);
  if (len > 16) for (const [x, y, a] of [[x1, y1, ang], ...(opts.both === false ? [] : [[x0, y0, ang + Math.PI]])]) {
    ctx.beginPath(); ctx.moveTo(x, y);
    ctx.lineTo(x - 9 * Math.cos(a - 0.4), y - 9 * Math.sin(a - 0.4));
    ctx.lineTo(x - 9 * Math.cos(a + 0.4), y - 9 * Math.sin(a + 0.4));
    ctx.closePath(); ctx.fill();
  }
  if (text) {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, vertical = Math.abs(y1 - y0) > Math.abs(x1 - x0);
    const flip = vertical && mx > ctx.canvas.clientWidth - 190;
    label(ctx, text, mx + (vertical ? (flip ? -8 : 8) : 0), my + (vertical ? 0 : -12), { color, size: 13, bold: true, align: vertical ? (flip ? "right" : "left") : "center" });
  }
}

function drawOffsetE(ctx, v) {
  const [xp, yp] = v.px(D.e, D.n), [xc] = v.px(5e5, D.n), [x0] = v.px(0, D.n);
  const y = yp + 26;
  arrow(ctx, x0, y, xc, y, C.hk, "false easting 500 000", { dash: [6, 4] });
  if (Math.abs(xp - xc) > 3) arrow(ctx, xc, y + 22, xp, y + 22, C.km, `${grp(D.fromCM)} m`, { both: false });
  else label(ctx, `+${grp(D.fromCM)} m`, xc + 8, y + 22, { color: C.km, size: 13, bold: true });
}

function drawOffsetN(ctx, v) {
  const eq = south ? 1e7 : 0;
  const [xp, yp] = v.px(D.e, D.n), [, ye] = v.px(0, eq), [, y0] = v.px(0, 0);
  const x = xp + 34;
  arrow(ctx, x, ye, x, yp, C.km, `${grp(south ? 1e7 - Math.floor(D.n) : D.n)} m`, { both: false });
  if (south && y0 > -50 && y0 < v.h + 4000) arrow(ctx, x + 70, y0, x + 70, ye, C.hk, "false northing 10 000 000", { dash: [6, 4] });
}

function drawPole(ctx, v) {
  const N = G.poleNorthing(south), [x, y] = v.px(5e5, N);
  if (!inView(v, x, y)) return;
  ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
  label(ctx, `${south ? "South" : "North"} Pole: E 500 000, N ${grp(N)}`, x + 8, y + (south ? -14 : 14), { size: 12, bold: true });
}

function drawOrigin(ctx, v) {
  const [x, y] = v.px(0, 0);
  ctx.strokeStyle = "rgba(255,255,255,0.75)"; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(v.w, y); ctx.moveTo(x, y); ctx.lineTo(x, 0); ctx.stroke(); ctx.setLineDash([]);
  if (!inView(v, x, y)) return;
  ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = C.bg; ctx.lineWidth = 2; ctx.stroke();
  const [lon, lat] = D.origin;
  label(ctx, "0, 0", x - 10, y - 16, { size: 16, bold: true, align: "right" });
  label(ctx, `is ${fmtLat(lat)} ${fmtLon(lon)}`, x - 10, y + 4, { size: 12, color: "#cfd8e6", align: "right" });
}

function drawScale(ctx, v) {
  // k across the view by columns; it hardly changes along a column
  const step = 3;
  for (let x = 0; x < v.w; x += step) {
    const [E] = v.en(x + step / 2, 0);
    const lat = Math.max(-80, Math.min(84, P.lat));
    const lon = inv(E, fwd(lon0, lat)[1])[0];
    const k = isFinite(lon) ? G.scaleAndConvergence(lon, lat, zone).k : 1;
    const ppm = (k - 1) * 1e6, a = Math.min(1, Math.abs(ppm) / 1000);
    ctx.fillStyle = ppm < 0 ? `rgba(77,160,255,${0.1 + 0.3 * a})` : `rgba(255,150,60,${0.1 + 0.3 * a})`;
    ctx.fillRect(x, 0, step, v.h);
  }
  // the lines of true scale
  ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5; ctx.setLineDash([7, 5]);
  for (const sgn of [-1, 1]) {
    ctx.beginPath();
    let pen = false;
    for (let lat = -80; lat <= 84; lat += 1) {
      const N = fwd(lon0, lat)[1], [x, y] = v.px(5e5 + sgn * G.trueScaleOffset(lat, zone), N);
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  const [, yp] = v.px(0, D.n);
  for (const sgn of [-1, 1]) {
    const [x] = v.px(5e5 + sgn * G.trueScaleOffset(P.lat, zone), 0);
    label(ctx, "k = 1", x + 6, yp + 60, { size: 13, bold: true });
  }
  const [xc] = v.px(5e5, 0);
  label(ctx, `k = ${M.K0}`, xc + 6, yp + 90, { size: 13, bold: true, color: "#9cc8ff" });
}

function drawPin(ctx, v) {
  const [x, y] = v.px(D.e, D.n);
  if (!inView(v, x, y)) return;
  ctx.fillStyle = C.pin; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  label(ctx, P.name, x + 10, y - 10, { size: 14, bold: true });
}

// ---------------------------------------------------------------- web map tiles, warped into the grid
//
// OpenStreetMap anywhere; in Tasmania theLIST's own basemaps (ArcGIS tile
// caches on the same Web Mercator XYZ scheme): the Topographic map for the
// street steps and the Emergency Services map book cartography for the map
// book steps. theLIST's tiles are loaded without CORS (their servers allow
// only some origins); the canvas is only drawn on, never read back.

const LIST = "https://services.thelist.tas.gov.au/arcgis/rest/services/Basemaps/";
const TILESRC = {
  tiles: { url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, max: 19, cors: true,
    credit: `Map tiles &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>` },
  topo: { url: (z, x, y) => `${LIST}Topographic/MapServer/tile/${z}/${y}/${x}`, max: 18, cors: false,
    credit: `Topographic basemap: <a href="https://www.thelist.tas.gov.au/">the LIST</a> &copy; State of Tasmania` },
  mapbook: { url: (z, x, y) => `${LIST}ESgisMapBookPUBLIC/MapServer/tile/${z}/${y}/${x}`, max: 15, cors: false,
    credit: `Emergency Services map book basemap: <a href="https://www.thelist.tas.gov.au/">the LIST</a> &copy; State of Tasmania` }
};

const tiles = new Map();
function tile(src, z, x, y) {
  const key = `${src}/${z}/${x}/${y}`;
  let t = tiles.get(key);
  if (!t) {
    t = { img: new Image(), ok: false };
    if (TILESRC[src].cors) t.img.crossOrigin = "anonymous";
    t.img.onload = () => { t.ok = true; schedule(); };
    t.img.onerror = () => { t.bad = true; };
    t.img.src = TILESRC[src].url(z, x, y);
    tiles.set(key, t);
    if (tiles.size > 600) tiles.delete(tiles.keys().next().value);
  }
  return t;
}
const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / D2R;

function drawTiles(ctx, v, dpr, which = "tiles") {
  const ll = viewLL(v);
  if (!isFinite(ll.lo0)) return;
  const lat = (ll.la0 + ll.la1) / 2;
  let z = Math.round(Math.log2(156543.03 * Math.cos(lat * D2R) * v.s * Math.min(dpr, 1.5)));
  z = Math.max(2, Math.min(TILESRC[which].max, z));
  let x0, x1, y0, y1;
  for (;;) {
    const n = 2 ** z;
    x0 = Math.floor(((ll.lo0 + 180) / 360) * n); x1 = Math.floor(((ll.lo1 + 180) / 360) * n);
    const ty = (la) => Math.floor(((1 - Math.log(Math.tan(Math.PI / 4 + (la * D2R) / 2)) / Math.PI) / 2) * n);
    y0 = ty(Math.min(85, ll.la1)); y1 = ty(Math.max(-85, ll.la0));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 140 || z <= 2) break;
    z--;
  }
  const sub = z >= 12 ? 1 : z >= 8 ? 2 : 6;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    let src = null, za = z, xa = x, ya = y;
    const t = tile(which, z, x, y);
    if (t.ok) src = t;
    else for (let up = 1; up <= 5 && za > 0; up++) {
      za--; xa >>= 1; ya >>= 1;
      const p = tiles.get(`${which}/${za}/${xa}/${ya}`);
      if (p && p.ok) { src = p; break; }
    }
    if (src) warpTile(ctx, v, dpr, src.img, z, x, y, za, xa, ya, sub);
  }
}

function warpTile(ctx, v, dpr, img, z, x, y, za, xa, ya, sub) {
  const f = 2 ** (z - za), size = 256 / f;
  const ox = (x - xa * f) * size, oy = (y - ya * f) * size;
  const P2 = [];
  for (let j = 0; j <= sub; j++) {
    const row = [];
    for (let i = 0; i <= sub; i++) row.push(v.px(...fwd(tileLon(x + i / sub, z), tileLat(y + j / sub, z))));
    P2.push(row);
  }
  const cell = size / sub;
  for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) {
    const p00 = P2[j][i], p10 = P2[j][i + 1], p01 = P2[j + 1][i], p11 = P2[j + 1][i + 1];
    const minx = Math.min(p00[0], p10[0], p01[0], p11[0]), maxx = Math.max(p00[0], p10[0], p01[0], p11[0]);
    const miny = Math.min(p00[1], p10[1], p01[1], p11[1]), maxy = Math.max(p00[1], p10[1], p01[1], p11[1]);
    if (maxx < 0 || minx > v.w || maxy < 0 || miny > v.h) continue;
    const sx = ox + i * cell, sy = oy + j * cell;
    const a = (p10[0] - p00[0]) / cell, b = (p10[1] - p00[1]) / cell, c = (p01[0] - p00[0]) / cell, d = (p01[1] - p00[1]) / cell;
    const e = p00[0] - a * sx - c * sy, ff = p00[1] - b * sx - d * sy;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // clip to the quad, grown half a pixel so neighbours meet
    const cx = (p00[0] + p11[0]) / 2, cy = (p00[1] + p11[1]) / 2, g = (p) => { const dx = p[0] - cx, dy = p[1] - cy, l = Math.hypot(dx, dy) || 1; return [p[0] + (dx / l) * 0.6, p[1] + (dy / l) * 0.6]; };
    ctx.beginPath();
    for (const [k, p] of [p00, p10, p11, p01].map(g).entries()) k ? ctx.lineTo(...p) : ctx.moveTo(...p);
    ctx.closePath(); ctx.clip();
    ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * ff);
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }
}

// ---------------------------------------------------------------- the globe

let globeBuf = null;
function drawGlobe(ctx, cam, L, w, h) {
  const R = (Math.min(w, h) / 2) * 0.92 * cam.zoom, cx = w / 2, cy = h / 2;
  const [lc, pc] = cam.globe, l0 = lc * D2R, p0 = pc * D2R, sp0 = Math.sin(p0), cp0 = Math.cos(p0);
  const proj = (lon, lat) => {
    const l = lon * D2R - l0, p = lat * D2R, cp = Math.cos(p), sp = Math.sin(p), cl = Math.cos(l);
    const cosc = sp0 * sp + cp0 * cp * cl;
    return [cx + R * cp * Math.sin(l), cy - R * (cp0 * sp - sp0 * cp * cl), cosc];
  };
  // raster: zones, the pin's zone, the polar caps, lit from the viewer
  const sc = Math.min(1, Math.sqrt(260000 / (w * h)));
  const bw = Math.max(2, Math.round(w * sc)), bh = Math.max(2, Math.round(h * sc));
  if (!globeBuf || globeBuf.width !== bw || globeBuf.height !== bh) { globeBuf = document.createElement("canvas"); globeBuf.width = bw; globeBuf.height = bh; }
  const g = globeBuf.getContext("2d"), img = g.createImageData(bw, bh), px = img.data;
  const zA = L("zones"), uA = L("ups");
  for (let j = 0; j < bh; j++) {
    const y = -((j + 0.5) / sc - cy) / R;
    for (let i = 0; i < bw; i++) {
      const x = ((i + 0.5) / sc - cx) / R, r2 = x * x + y * y, o = 4 * (j * bw + i);
      if (r2 > 1) { px[o + 3] = 0; continue; }
      const z = Math.sqrt(1 - r2);
      const lat = Math.asin(z * sp0 + y * cp0) / D2R;
      const lon = (l0 + Math.atan2(x, z * cp0 - y * sp0)) / D2R;
      let col = [24, 40, 66];
      const inUTM = lat >= -80 && lat < 84;
      if (inUTM) {
        const zn = M.zoneOf(lon, lat);
        const zc = zn === zone ? (M.bandOf(lat) === D.band ? [190, 110, 30] : [120, 72, 26]) : zn % 2 ? [30, 56, 96] : [22, 44, 78];
        col = col.map((c, k) => c + (zc[k] - c) * zA);
      } else {
        const pc2 = [92, 50, 120];
        col = col.map((c, k) => c + (pc2[k] - c) * Math.max(uA, zA * 0.3));
      }
      const lit = 0.45 + 0.55 * z;
      px[o] = col[0] * lit; px[o + 1] = col[1] * lit; px[o + 2] = col[2] * lit; px[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(globeBuf, 0, 0, w, h);

  const line = (pts, color, width = 1) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    let pen = false;
    for (const [lon, lat] of pts) {
      const [x, y, c] = proj(lon, lat);
      if (c < 0) { pen = false; continue; }
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
  };
  // coastlines
  if (coast110) {
    ctx.strokeStyle = "rgba(225,240,255,0.8)"; ctx.lineWidth = 0.9; ctx.beginPath();
    for (const l of coast110) {
      let pen = false;
      for (let k = 0; k < l.length; k += 2) {
        const [x, y, c] = proj(l[k], l[k + 1]);
        if (c < 0) { pen = false; continue; }
        if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        pen = true;
      }
    }
    ctx.stroke();
  }
  // band lines and letters
  const bA = Math.max(L("bands"), L("bandsLight"));
  if (bA > 0.01) {
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * bA;
    for (let b = 0; b <= 20; b++) {
      const lat = b === 20 ? 84 : -80 + 8 * b, pts = [];
      for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, lat]);
      line(pts, "rgba(255,211,77,0.55)", 1);
    }
    if (L("bands") > 0.01) {
      ctx.globalAlpha = a0 * L("bands");
      for (let dz = -3; dz <= 3; dz++) for (let b = 0; b < 20; b++) {
        const z = ((zone - 1 + dz + 60) % 60) + 1;
        const band = M.BANDS[b], lr = M.gridZoneLon(z, band);
        if (!lr) continue;
        const [la, lb] = M.bandRange(band), [x, y, c] = proj((lr[0] + lr[1]) / 2, (la + lb) / 2);
        const mine = z === zone && band === D.band;
        if (c > 0.15) label(ctx, `${z}${band}`, x, y, { size: mine ? 14 : 11, bold: mine, align: "center", color: z === zone ? "#ffe2a8" : "#e7eefc" });
      }
    }
    ctx.globalAlpha = a0;
  }
  // zone numbers along the equator
  if (zA > 0.01) {
    for (let z = 1; z <= 60; z++) {
      const [x, y, c] = proj(6 * z - 183, south ? -4 : 4);
      if (c > 0.25) label(ctx, String(z), x, y, { size: z === zone ? 15 : 11, bold: z === zone, align: "center", color: z === zone ? "#ffd8a0" : "rgba(230,238,252,0.85)" });
    }
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, 0]);
    line(pts, "rgba(255,211,77,0.7)", 1.2);
  }
  // UPS: the caps' edges and the grid on the south (or north) plane
  if (uA > 0.01) {
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * uA;
    for (const lat of [-80, 84]) { const pts = []; for (let lon = -180; lon <= 180; lon += 2) pts.push([lon, lat]); line(pts, "#d6a6ff", 2); }
    const north = !south || cam.globe[1] > 0;
    for (let k = -3; k <= 3; k++) {
      const c = 2e6 + k * 5e5, ptsE = [], ptsN = [];
      for (let q = -1.6e6; q <= 1.6e6; q += 4e4) {
        ptsE.push(M.fromUPS(north, c, 2e6 + q));
        ptsN.push(M.fromUPS(north, 2e6 + q, c));
      }
      const keep = (p) => (north ? p[1] > 72 : p[1] < -72);
      line(ptsE.filter(keep), k ? "rgba(214,166,255,0.55)" : "#ffffff", k ? 1 : 2);
      line(ptsN.filter(keep), k ? "rgba(214,166,255,0.55)" : "#ffffff", k ? 1 : 2);
    }
    // labels on the axes
    const q = M.fromUPS(north, 2e6 + 1.2e6, 2e6), r = M.fromUPS(north, 2e6, 2e6 + 1.2e6);
    let [x, y, c] = proj(...q);
    if (c > 0) label(ctx, "N 2 000 000", x, y - 10, { size: 12, bold: true });
    [x, y, c] = proj(...r);
    if (c > 0) label(ctx, "E 2 000 000", x + 6, y, { size: 12, bold: true });
    for (const [lt, lon] of north ? [["Y", -90], ["Z", 90]] : [["A", -90], ["B", 90]]) {
      [x, y, c] = proj(lon, north ? 87 : -86.5);
      if (c > 0) label(ctx, lt, x, y, { size: 22, bold: true, align: "center", color: "#f0dcff" });
    }
    [x, y, c] = proj(0, north ? 90 : -90);
    if (c > 0) { ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill(); }
    ctx.globalAlpha = a0;
  }
  // the pin's zone outline and the pin
  const out = [];
  for (let lat = -80; lat <= 84; lat += 2) out.push([lon0 - 3, lat]);
  for (let lat = 84; lat >= -80; lat -= 2) out.push([lon0 + 3, lat]);
  line(out, "#ffb35c", 1.6);
  const [x, y, c] = proj(P.lon, P.lat);
  if (c > 0) {
    ctx.fillStyle = C.pin; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    label(ctx, P.name, x + 9, y - 9, { size: 13, bold: true });
  }
  // the rim
  ctx.strokeStyle = "rgba(160,200,255,0.5)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
}

// ---------------------------------------------------------------- scale bar and credit

function updateScalebar(f) {
  const bar = $("scalebar");
  if (!view || f.globeAlpha > 0.5) { bar.hidden = true; return; }
  bar.hidden = false;
  const target = 120 / view.s;
  const p = 10 ** Math.floor(Math.log10(target));
  const m = [1, 2, 5, 10].map((k) => k * p).filter((x) => x <= target).pop();
  bar.querySelector("span").style.width = `${m * view.s}px`;
  bar.querySelector("b").textContent = m >= 1000 ? `${grp(m / 1000)} km of grid` : `${m} m of grid`;
  const st = STEPS[f.i], srcs = st ? Object.keys(TILESRC).filter((k) => (st.L[k] || 0) > 0) : [];
  const books = T && st && ["real", "saPage", "mbPage", "saAll", "mbAll", "inset"].some((k) => st.L[k]);
  $("credit").innerHTML = (srcs.length ? srcs.map((k) => TILESRC[k].credit).join("; ") : "Coastlines: Natural Earth") +
    (books && !srcs.some((k) => k !== "tiles") ? `; book pages: the LIST &copy; State of Tasmania` : books ? " (and book pages)" : "");
}

// ---------------------------------------------------------------- input

const placeSel = $("place");
for (const [name, lon, lat] of PLACES) placeSel.add(new Option(name, `${lon},${lat}`));
placeSel.add(new Option("A clicked point", "custom"));
function syncPlaceSel() {
  const v = state.at || `${PLACES[0][1]},${PLACES[0][2]}`;
  placeSel.value = [...placeSel.options].some((o) => o.value === v) ? v : "custom";
}
placeSel.addEventListener("change", () => {
  if (placeSel.value === "custom") return;
  state.at = placeSel.value === `${PLACES[0][1]},${PLACES[0][2]}` ? "" : placeSel.value;
  user = { dE: 0, dN: 0, z: 1 };
  writeHash(); setPlace(); syncPlaceSel(); schedule();
});

$("prev").addEventListener("click", () => goTo(Math.round(t) - 1));
$("next").addEventListener("click", () => goTo(Math.round(t) + 1));
$("jump").addEventListener("change", (e) => goTo(+e.target.value));

// drag to pan and pinch or wheel to zoom the plane (the step's camera comes
// back at the next step, or with Recentre); a click in the local steps
// moves the pin
let down = null, moved = false;
const ptrs = new Map();
const zoomAt = (k, x, y) => {
  if (!view) return;
  const r = map.getBoundingClientRect(), [E, N] = view.en(x - r.left, y - r.top);
  const z = Math.max(0.05, Math.min(20, user.z * k)), f = z / user.z;
  // keep E, N under the cursor
  user.dE += (E - view.cam.E) * (1 - f); user.dN += (N - view.cam.N) * (1 - f); user.z = z;
  schedule();
};
map.addEventListener("pointerdown", (e) => {
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (ptrs.size === 1) { down = [e.clientX, e.clientY]; moved = false; }
  map.setPointerCapture(e.pointerId);
});
map.addEventListener("pointermove", (e) => {
  const prev = ptrs.get(e.pointerId);
  if (!prev || !view) return;
  if (ptrs.size === 1) {
    if (!moved && Math.hypot(e.clientX - down[0], e.clientY - down[1]) <= 4) return;
    moved = true;
    user.dE -= (e.clientX - prev[0]) / view.s; user.dN += (e.clientY - prev[1]) / view.s;
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    schedule();
  } else if (ptrs.size === 2) {
    moved = true;
    const other = [...ptrs.entries()].find(([id]) => id !== e.pointerId)[1];
    const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]), d1 = Math.hypot(e.clientX - other[0], e.clientY - other[1]);
    ptrs.set(e.pointerId, [e.clientX, e.clientY]);
    user.dE -= (e.clientX - prev[0]) / 2 / view.s; user.dN += (e.clientY - prev[1]) / 2 / view.s;
    if (d0 > 0 && d1 > 0) zoomAt(d0 / d1, (e.clientX + other[0]) / 2, (e.clientY + other[1]) / 2);
    schedule();
  }
});
const lift = (e) => { ptrs.delete(e.pointerId); };
map.addEventListener("pointercancel", lift);
map.addEventListener("wheel", (e) => {
  if (!view) return;
  e.preventDefault();
  zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY);
}, { passive: false });
$("recentre").addEventListener("click", () => { user = { dE: 0, dN: 0, z: 1 }; schedule(); });
map.addEventListener("pointerup", (e) => {
  lift(e);
  if (!down || moved || ptrs.size || !view) { if (!ptrs.size) down = null; return; }
  down = null;
  if (!(STEPS[Math.round(t)] || {}).click) return;
  const r = map.getBoundingClientRect(), [lon, lat] = inv(...view.en(e.clientX - r.left, e.clientY - r.top));
  if (!(lat > -80 && lat < 84)) return;
  state.at = `${lon.toFixed(5)},${lat.toFixed(5)}`;
  writeHash(); setPlace(); syncPlaceSel(); schedule();
});

// the reference card folds to its first row (always so on a phone to start)
const bar = $("refbar");
if (window.matchMedia("(max-width: 820px)").matches) bar.classList.add("min");
bar.addEventListener("click", () => bar.classList.toggle("min"));

$("panel").addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("hashchange", () => {
  const at = state.at;
  readHash();
  if (state.at !== at) { setPlace(); syncPlaceSel(); }
  schedule();
});
new ResizeObserver(() => { if (!embed) t = scrollT(); schedule(); }).observe($("stage"));

shareLinks("playproj: Grid references", { height: 600 });
MR = await fetch(new URL("../data/tas-mapref.json", import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((j) => (j ? R.read(j) : null)).catch(() => null);
setPlace();
syncPlaceSel();
// start at the step in the hash
const s0 = Math.min(STEPS.length - 1, state.s);
if (s0 > 0) {
  if (embed) t = s0;
  else requestAnimationFrame(() => { scrollToStep(s0, "auto"); t = scrollT(); schedule(); });
}
if (embed) document.body.classList.add("gridref-embed");
$("jump").value = String(s0);
schedule();

loadCoastline("50m").then((c) => { coast50 = c; coastZone = null; schedule(); }).catch(() => {});
loadCoastline("110m").then((c) => { coast110 = c; schedule(); }).catch(() => {});
