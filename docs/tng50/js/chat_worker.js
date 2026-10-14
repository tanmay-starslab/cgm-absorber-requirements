/* Web worker for the local chat model (docs/tng50/js/chat.js): runs the WebLLM engine off the main thread.
   Loaded only after the user clicks "Load local model". WebLLM is the same pinned, hash-checked bundle as in chat.js
   (importVerified: fetch with Subresource Integrity, then import the verified bytes). MIT. */
import {importVerified, WEBLLM_URL, WEBLLM_SRI} from "./chat.js";

const early = [];                       // messages that arrive while the bundle is still being fetched and checked
let handler = null;
self.onmessage = msg => (handler ? handler.onmessage(msg) : early.push(msg));
importVerified(WEBLLM_URL, WEBLLM_SRI).then(({WebWorkerMLCEngineHandler}) => {
  handler = new WebWorkerMLCEngineHandler();
  for (const m of early.splice(0)) handler.onmessage(m);
}).catch(e => { self.onmessage = null; setTimeout(() => { throw new Error("WebLLM failed its integrity check or could not be fetched: " + e.message); }); });
