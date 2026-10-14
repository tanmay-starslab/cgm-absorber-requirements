// Worker for the cube loader (fix-ui FE-10): WebP atlas parts -> createImageBitmap -> OffscreenCanvas -> atlasToRaw ->
// sha256, off the main thread. In: {id, blobs, n, kind}; out: {id, raw (ArrayBuffer, transferred), sha} or {id, error}.
import {decodeAtlas} from "./vizload.js";
self.onmessage = async ev => { const {id, blobs, n, kind} = ev.data;
  try { const {raw, sha} = await decodeAtlas(blobs, n, kind); self.postMessage({id, raw: raw.buffer, sha}, [raw.buffer]); }
  catch (x) { self.postMessage({id, error: String(x && x.message || x)}); } };
