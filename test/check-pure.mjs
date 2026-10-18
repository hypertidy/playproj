// The core modules run without a browser: none reaches for the DOM, a
// canvas or three.js, and each one, with everything it imports, loads in
// Node. Page, scene and loading code (basemap-load.js, data.js,
// download.js, tissot-draw.js and the page files) is outside the core.
import { readFileSync } from "fs";

const CORE = [
  "families/perspective.js", "families/azimuthal.js", "families/conic.js", "families/globals.js", "families/spilhaus.js",
  "tissot.js", "distortion.js", "grids.js", "roms.js", "regular.js", "s2.js", "l3bin.js", "mgrs.js", "rasterize.js", "structure.js",
  "geotiff-write.js", "cellexport.js", "landmesh.js", "mishaps.js", "homage-geo.js", "geo.js", "basemap.js"
];
// packages a core module may import
const PACKAGES = new Set(["earcut"]);
const BROWSER = [
  [/\bdocument\./, "document"], [/\bwindow\./, "window"], [/\bnew Image\b/, "Image"], [/\bImageData\b/, "ImageData"],
  [/\.getContext\(/, "canvas context"], [/\blocalStorage\b/, "localStorage"], [/\blocation\./, "location"]
];

const root = new URL("../js/", import.meta.url);
let fails = 0;
const seen = new Set();
function scan(rel, from) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = readFileSync(new URL(rel, root), "utf8");
  // comments can mention anything
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const bad = BROWSER.filter(([re]) => re.test(code)).map(([, name]) => name);
  for (const [, spec] of code.matchAll(/^\s*import\b[^"']*["']([^"']+)["']/gm)) {
    if (spec.startsWith(".")) {
      const dep = new URL(spec, new URL(rel, root)).href.slice(root.href.length);
      if (!CORE.includes(dep)) bad.push(`imports ${dep}, which is not core`);
      else scan(dep, rel);
    } else if (!PACKAGES.has(spec)) bad.push(`imports ${spec}`);
  }
  if (bad.length) { fails++; console.log(`FAIL ${rel}${from ? ` (via ${from})` : ""}: ${bad.join(", ")}`); }
}
for (const rel of CORE) scan(rel);
for (const rel of CORE) {
  try {
    const m = await import(new URL(rel, root));
    if (!Object.keys(m).length) { fails++; console.log(`FAIL ${rel}: exports nothing`); }
  } catch (e) { fails++; console.log(`FAIL ${rel}: does not load in Node (${e.message})`); }
}
console.log(`pure: ${CORE.length} core modules${fails ? `, ${fails} failing` : ", all load in Node with no browser"}`);
if (fails) process.exit(1);
