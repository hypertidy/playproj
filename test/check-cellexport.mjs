// The projections js/cellexport.js writes cells in, against proj4js:
// gnomonic about any centre (s2 faces, cubed-sphere faces) and north and
// south polar stereographic (tripolar cap cells).
import proj4 from "proj4";
import { gnomonic, polarStere } from "../js/cellexport.js";

let fails = 0;
const check = (label, err, tol) => {
  const ok = err < tol;
  fails += !ok;
  console.log(ok ? "ok  " : "FAIL", label.padEnd(44), `max error ${err.toExponential(2)}`);
};
const pts = [];
for (let lat = -85; lat <= 85; lat += 17) for (let lon = -175; lon <= 175; lon += 25) pts.push([lon, lat]);

for (const [lat0, lon0] of [[0, 0], [0, 90], [0, 180], [0, -90], [90, 0], [-90, 0], [-42, 147]]) {
  const P = proj4("+proj=longlat +R=1", `+proj=gnom +lat_0=${lat0} +lon_0=${lon0} +x_0=0 +y_0=0 +R=1`);
  const g = gnomonic(lat0, lon0);
  let err = 0;
  for (const [lon, lat] of pts) {
    const xy = g.forward(lon, lat);
    if (!xy || Math.hypot(...xy) > 3) continue;
    const ref = P.forward([lon, lat]);
    err = Math.max(err, Math.abs(xy[0] - ref[0]) + Math.abs(xy[1] - ref[1]));
    const back = g.inverse(...xy);
    err = Math.max(err, Math.abs(((back[0] - lon + 540) % 360) - 180) + Math.abs(back[1] - lat));
  }
  check(`gnom lat_0=${lat0} lon_0=${lon0}`, err, 1e-9);
}

for (const south of [false, true]) {
  const P = proj4("+proj=longlat +R=1", `+proj=stere +lat_0=${south ? -90 : 90} +lon_0=0 +k=1 +x_0=0 +y_0=0 +R=1`);
  const s = polarStere(south, 0);
  let err = 0;
  for (const [lon, lat] of pts) {
    if (south ? lat > 60 : lat < -60) continue;
    const xy = s.forward(lon, lat), ref = P.forward([lon, lat]);
    err = Math.max(err, Math.abs(xy[0] - ref[0]) + Math.abs(xy[1] - ref[1]));
    const back = s.inverse(...xy);
    err = Math.max(err, Math.abs(((back[0] - lon + 540) % 360) - 180) + Math.abs(back[1] - lat));
  }
  check(`stere lat_0=${south ? -90 : 90}`, err, 1e-9);
}
process.exit(fails ? 1 : 0);
