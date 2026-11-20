// The device-tier WebGL check (js/tier.js probe) off the main thread, on an OffscreenCanvas: on software GL creating the
// context alone held the main thread for 3 to 4 s. Posts the probe result, or {fallback: true} when this worker cannot
// make a WebGL2 context (no OffscreenCanvas WebGL2), so the page probes on the main thread instead.
import * as G from "../learn/how-a-spectrum-is-made/js/stage/glcheck.js";
import {probe} from "./tier.js";
let r = {fallback: true};
try { if (typeof OffscreenCanvas !== "undefined") { const p = probe(G, {createElement: () => new OffscreenCanvas(256, 256)}); if (p.why !== "no WebGL2") r = p; } }
catch { /* fall back to the main thread */ }
postMessage(r);
