// The core (everything under src/core) runs without a browser: no module
// reaches for the DOM, a canvas or three.js, none imports from outside the
// core, and each one, with everything it imports, loads in Node. Pages and
// loading code (js/) and the three.js scene layer (src/scene) are outside it.
import { readFileSync, readdirSync } from "fs";

const root = new URL("../src/core/", import.meta.url);
const CORE = readdirSync(root, { recursive: true }).filter((f) => f.endsWith(".js")).map((f) => f.split("\\").join("/")).sort();
// packages a core module may import
const PACKAGES = new Set(["earcut"]);
const BROWSER = [
  [/\bdocument\./, "document"], [/\bwindow\./, "window"], [/\bnew Image\b/, "Image"], [/\bImageData\b/, "ImageData"],
  [/\.getContext\(/, "canvas context"], [/\blocalStorage\b/, "localStorage"], [/\blocation\./, "location"]
];

let fails = 0;
const seen = new Set();
function scan(rel, from) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = readFileSync(new URL(rel, root), "utf8");
  // comments can mention anything
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const bad = BROWSER.filter(([re]) => re.test(code)).map(([, name]) => name);
  for (const [, spec] of code.matchAll(/^\s*(?:import\s*|(?:import|export)\s[^"';=]*?from\s*)["']([^"']+)["']/gm)) {
    if (spec.startsWith(".")) {
      const href = new URL(spec, new URL(rel, root)).href, dep = href.slice(root.href.length);
      if (!href.startsWith(root.href) || !CORE.includes(dep)) bad.push(`imports ${spec}, which is not core`);
      else scan(dep, rel);
    } else if (!PACKAGES.has(spec)) bad.push(`imports ${spec}`);
  }
  if (bad.length) { fails++; console.log(`FAIL ${rel}${from ? ` (via ${from})` : ""}: ${bad.join(", ")}`); }
}
// index.js reaches every core module, so the whole core is one import
scan("index.js");
for (const rel of CORE) if (!seen.has(rel)) { fails++; console.log(`FAIL ${rel} is not reached from index.js`); }
for (const rel of CORE) scan(rel);
for (const rel of CORE) {
  try {
    const m = await import(new URL(rel, root));
    if (!Object.keys(m).length) { fails++; console.log(`FAIL ${rel}: exports nothing`); }
  } catch (e) { fails++; console.log(`FAIL ${rel}: does not load in Node (${e.message})`); }
}
console.log(`pure: ${CORE.length} core modules${fails ? `, ${fails} failing` : ", all load in Node with no browser"}`);
if (fails) process.exit(1);
