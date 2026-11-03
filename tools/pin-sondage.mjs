// Move the sondage pin: rebuild fourd.html and cutaway.html from sondage's
// own pages at one commit, keeping playproj's title, nav and links.
//
//   node tools/pin-sondage.mjs ../sondage <commit>
//
// The sondage checkout must have the commit; the full hash is written into
// each page's script URL (jsDelivr's GitHub route).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [dir, ref] = process.argv.slice(2);
if (!dir || !ref) { console.error("usage: node tools/pin-sondage.mjs <sondage checkout> <commit>"); process.exit(1); }
const sha = execFileSync("git", ["-C", dir, "rev-parse", ref + "^{commit}"]).toString().trim();
const base = `https://cdn.jsdelivr.net/gh/allboa/sondage@${sha}`;

const one = (s, re, label) => {
  const m = s.match(re);
  if (!m) throw new Error("not found: " + label);
  return m[0];
};

for (const [page, script] of [["fourd.html", "js/fourd-page.js"], ["cutaway.html", "js/cutaway-page.js"]]) {
  const ours = readFileSync(page, "utf8");
  let s = execFileSync("git", ["-C", dir, "show", `${sha}:${page}`]).toString();
  const swap = (re, label, to) => { one(s, re, label); s = s.replace(re, to); };
  swap(/<title>sondage: /, "title", "<title>playproj: ");
  swap(/<script type="module" src="js\/[a-z-]+\.js"><\/script>/, "script",
    `<!-- the page is sondage's (https://github.com/allboa/sondage), pinned to one commit -->\n<script type="module" src="${base}/${script}"></script>`);
  swap(/>Open the full page</, "open-full", ">Open in playproj<");
  swap(/<h1>sondage<\/h1>/, "h1", "<h1>playproj</h1>");
  swap(/<nav class="pages">.*<\/nav>/, "nav", one(ours, /<nav class="pages">.*<\/nav>/, "playproj nav"));
  swap(/<a href="https:\/\/github.com\/allboa\/sondage">Source and contributing<\/a>/, "source link",
    '<a href="https://github.com/hypertidy/playproj">Source and contributing</a>');
  writeFileSync(page, s);
  console.log(page, "pinned to sondage", sha.slice(0, 7));
}
