// playproj: a gallery of voxel blocks. Each entry is a Voxels page hash,
// shown live in an embedded frame; the list picks one, and each has a link
// to the full page and an embed snippet.

const $ = (id) => document.getElementById(id);

const ENTRIES = [
  {
    key: "kunanyi", title: "kunanyi / Mount Wellington, 2 m under the hood",
    text: "512 columns 23 m across: too fine for GEBCO, so the land comes from Tasmania's 2 m DEM, with imagery laid over the tops.",
    hash: { lon: 147.237, lat: -42.896, ext: 12, n: 512, tops: "esritex", spin: 1 }
  },
  {
    key: "cradle", title: "Cradle Mountain and Dove Lake",
    text: "The 2 m DEM again, at 384 across, with each top the mean colour of the imagery over it.",
    hash: { lon: 145.951, lat: -41.684, ext: 14, n: 384, tops: "esri", spin: 1 }
  },
  {
    key: "heard", title: "Heard Island and Big Ben",
    text: "An active volcano in the Southern Ocean, its glaciers textured from imagery, sitting on GEBCO's sea floor.",
    hash: { lon: 73.45, lat: -53.08, ext: 60, n: 256, tops: "esritex", spin: 1 }
  },
  {
    key: "maunakea", title: "Mauna Kea from the sea floor",
    text: "At true scale, no exaggeration: measured from its base the mountain is about 10 km tall, and still a gentle slope across 260 km.",
    hash: { lon: -155.5, lat: 19.6, ext: 260, n: 192, cube: 0, vx: 1, spin: 1 }
  },
  {
    key: "mariana", title: "Challenger Deep",
    text: "The deepest sea floor, drawn as cubes and filled with water to sea level. Water off shows the trench as a pit.",
    hash: { lon: 142.2, lat: 11.35, ext: 300, n: 128, water: 0, spin: 1 }
  },
  {
    key: "everest", title: "Everest and the Khumbu",
    text: "GEBCO's land is about 460 m a cell, so 128 columns across 60 km is near its own resolution.",
    hash: { lon: 86.925, lat: 27.988, ext: 60, n: 128, tops: "esritex", spin: 1 }
  },
  {
    key: "erebus-array", title: "Ross Island in array cells",
    text: "Lon/lat cells drawn square, the way the array stores them: at 77.5 S a degree of longitude is a fifth of a degree of latitude, so the island is stretched east to west.",
    hash: { lon: 167, lat: -77.55, ext: 90, n: 96, crs: "array" }
  },
  {
    key: "erebus-lonlat", title: "Ross Island in true-size cells",
    text: "The same cells at their size on the ground: each nearly five times taller than wide, and the island back in shape.",
    hash: { lon: 167, lat: -77.55, ext: 90, n: 96, crs: "lonlat" }
  },
  {
    key: "concordia", title: "Dome C on the ice sheet",
    text: "200 km of the East Antarctic plateau round Concordia Station, more than 3 km up. Drawn as cubes the heights are exaggerated many times over, and the dome is still only a gentle swell.",
    hash: { lon: 123.35, lat: -75.1, ext: 200, n: 128, spin: 1 }
  },
  {
    key: "seamounts", title: "Tasmanian seamounts, tops only",
    text: "Sides hidden: the sea floor south of Tasmania as a floating surface of voxel tops.",
    hash: { lon: 147.1, lat: -44.3, ext: 60, n: 192, sides: "none", water: 0, spin: 1 }
  },
  {
    key: "galapagos", title: "The Galapagos platform",
    text: "Volcanic islands on a shallow platform, with sides in a single colour.",
    hash: { lon: -90.6, lat: -0.55, ext: 320, n: 256, sides: "colour", sc: "3b4a5a", spin: 1 }
  },
  {
    key: "kilimanjaro", title: "Kilimanjaro at 16 columns",
    text: "A coarse overview of the same ground: press Sweep in the full page to step from 8 columns to 512.",
    hash: { lon: 37.355, lat: -3.067, ext: 70, n: 16, spin: 1 }
  }
];

const base = new URL("./voxels.html", location.href);
const hashOf = (h) => "#" + Object.entries(h).map(([k, v]) => `${k}=${v}`).join("&");
const fullUrl = (e) => base.href + hashOf(e.hash);
const embedUrl = (e) => `${base.href}?embed=1${hashOf(e.hash)}`;
const snippet = (e) => `<iframe src="${embedUrl(e)}" width="100%" height="480" style="border:0" loading="lazy" title="Voxels: ${e.title}"></iframe>`;

function show(key) {
  const e = ENTRIES.find((x) => x.key === key) || ENTRIES[0];
  $("frame").src = embedUrl(e);
  $("frame").title = `Voxels: ${e.title}`;
  $("now-title").textContent = e.title;
  $("now-text").textContent = e.text;
  $("now-open").href = fullUrl(e);
  for (const li of $("list").children) li.classList.toggle("on", li.dataset.key === e.key);
  history.replaceState(null, "", `#g=${e.key}`);
  current = e;
}

let current = null;
$("list").innerHTML = ENTRIES.map((e) => `<li data-key="${e.key}"><button type="button"><b>${e.title}</b><span>${e.text}</span></button></li>`).join("");
$("list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li");
  if (li) show(li.dataset.key);
});
$("now-embed").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(snippet(current));
    $("now-embed").textContent = "Copied";
  } catch {
    $("now-embed").textContent = "Copy failed";
  }
  setTimeout(() => { $("now-embed").textContent = "Copy embed"; }, 1500);
});
show(new URLSearchParams(location.hash.slice(1)).get("g"));
