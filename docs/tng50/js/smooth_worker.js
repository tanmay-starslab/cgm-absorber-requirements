// Worker for the viewer's ion-cube display prefilter (vizdata.smoothCube; tune2). In: {id, q, n, vmin, vmax, passes, ch};
// out: {id, q} with the smoothed bytes (both buffers transferred).
import {smoothCube} from "./vizdata.js";
self.onmessage = ev => { const {id, q, n, vmin, vmax, passes, ch} = ev.data;
  try { const out = smoothCube(q, n, vmin, vmax, passes, ch || 1); self.postMessage({id, q: out}, [out.buffer]); }
  catch (x) { self.postMessage({id, error: String(x && x.message || x)}); } };
