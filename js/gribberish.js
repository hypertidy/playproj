// The "gribberish" Zarr codec in the browser: each chunk is the bytes of one
// GRIB message, as in dynamical.org's virtual Icechunk stores of ECMWF and
// NOAA forecasts, whose references point at whole messages in the agencies'
// own files. The decoding is gribberish (Matthew Iannucci, MIT), compiled to
// wasm32-wasi; its packing parameters live in each message, so no standard
// Zarr codec can stand in for it.
//
// gribberish's own browser loader starts a pool of workers from a package
// path, which a page loading it from a CDN cannot do. Decoding a chunk is
// synchronous, so here the same wasm is instantiated on the page's thread
// with no workers. Its memory is shared (it is a threads build), which a
// browser allows without cross-origin isolation as long as nothing is posted
// to a worker.
//
// The codec matches gribberish's zarrita codec (zarr-codec.cjs): config
// { var, adjust_longitude_range, north_up }, float32 or float64 out.

export const GRIBBERISH_VERSION = "1.11.0";
export const GRIBBERISH_WASM = `https://cdn.jsdelivr.net/npm/@mattnucc/gribberish-wasm32-wasi@${GRIBBERISH_VERSION}/gribberish-js.wasm32-wasi.wasm`;
const CONFIG_KEYS = new Set(["var", "adjust_longitude_range", "north_up"]);

// A zarrita array-to-bytes codec class around decode(bytes, var, adjustLon,
// northUp) -> Float64Array, gribberish's decodeZarrChunk.
export function gribberishCodec(decodeZarrChunk) {
  return class GribberishCodec {
    constructor(configuration, meta) {
      const c = configuration || {};
      for (const k of Object.keys(c)) if (!CONFIG_KEYS.has(k)) throw new Error(`unknown gribberish codec setting: ${k}`);
      // zarrita 0.7 passes dataType; gribberish's own codec reads data_type
      const dt = meta.dataType ?? meta.data_type;
      if (dt !== "float64" && dt !== "float32") throw new Error(`gribberish decodes to float32 or float64, not ${dt}`);
      this.kind = "array_to_bytes";
      this.configuration = { var: c.var ?? null, adjust_longitude_range: !!c.adjust_longitude_range, north_up: !!c.north_up };
      this.dataType = dt;
      this.shape = meta.shape;
      this.stride = meta.shape.map((_, i) => meta.shape.slice(i + 1).reduce((a, b) => a * b, 1));
    }
    static fromConfig(configuration, meta) { return new GribberishCodec(configuration, meta); }
    encode() { throw new Error("the gribberish codec only decodes"); }
    decode(bytes) {
      const { var: v, adjust_longitude_range: lon, north_up: up } = this.configuration;
      const values = decodeZarrChunk(bytes, v, lon, up);
      const n = this.shape.reduce((a, b) => a * b, 1);
      if (values.length !== n) throw new Error(`a GRIB message of ${values.length} values for a chunk of ${this.shape.join(" x ")}`);
      return { data: this.dataType === "float32" ? Float32Array.from(values) : values, shape: this.shape, stride: this.stride };
    }
  };
}

// gribberish's wasm, instantiated once, on this thread: its exports
// (decodeZarrChunk, parseMessagesFromBuffer, ...).
let loading = null;
export function loadGribberish(wasmUrl = GRIBBERISH_WASM) {
  if (!loading) loading = (async () => {
    const { getDefaultContext, instantiateNapiModuleSync, WASI } = await import("@napi-rs/wasm-runtime");
    const bytes = await (await fetch(wasmUrl)).arrayBuffer();
    // the module asks for at least 980 pages of shared memory
    const memory = new WebAssembly.Memory({ initial: 980, maximum: 65536, shared: true });
    const { napiModule } = instantiateNapiModuleSync(bytes, {
      context: getDefaultContext(),
      asyncWorkPoolSize: 0,
      wasi: new WASI({ version: "preview1" }),
      overwriteImports(imports) {
        imports.env = { ...imports.env, ...imports.napi, ...imports.emnapi, memory };
        return imports;
      },
      beforeInit({ instance }) {
        for (const name of Object.keys(instance.exports)) if (name.startsWith("__napi_register__")) instance.exports[name]();
      }
    });
    return napiModule.exports;
  })().catch((e) => { loading = null; throw new Error(`could not load gribberish to decode GRIB: ${e.message}`); });
  return loading;
}

// Register the codec in a zarrita registry; the wasm loads the first time a
// chunk that needs it is decoded.
export function registerGribberish(registry, load = loadGribberish) {
  registry.set("gribberish", () => load().then((g) => gribberishCodec(g.decodeZarrChunk)));
}
