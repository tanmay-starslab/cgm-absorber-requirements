// Module worker of the live spectrum dock: builds the frame-independent τ cache off the main thread (DESIGN_final §3.4,
// C_eng P0-5). Start it with  new Worker(new URL("./tauworker.js", import.meta.url), {type: "module"}).
//
// Protocol
//   in  {type: "build", reqId, geometry: {cells: {lc, h, d, idx}, kernel_cdf}, grid: {V0, V1, dV}, ions: [ionInputs(...)]}
//         (ionInputs from tausum.js: {ion, atom, logN, V, b, a} as Float64Arrays; transfer them)
//   out {type: "built", reqId, ion, csr: {ion, n, N, start, len, ptr, vals}, prefix: {order, sOutSorted, ckpt, nk}, ms}
//         one message per ion, buffers transferred (≈ 4 MB per ion for 672 cells × 801 bins)
//   out {type: "error", reqId, message}
// The worker keeps no state between requests: the same input always gives the same buffers (pure build).
import {geometryOf, buildCellTau, buildPrefix} from "./tausum.js";

const now = () => (globalThis.performance ? performance.now() : Date.now());

export function handle(m, post) {
  if (!m || m.type !== "build") { post({type: "error", reqId: m && m.reqId, message: `unknown message type ${JSON.stringify(m && m.type)}`}); return; }
  try {
    const G = geometryOf({geometry: m.geometry});
    const g = m.grid || {V0: -400, V1: 400, dV: 1};
    const grid = {v0: +g.V0, dv: +g.dV, n: Math.round((+g.V1 - +g.V0) / +g.dV) + 1};
    for (const inp of m.ions || []) {
      const t0 = now();
      const csr = buildCellTau(inp, grid), prefix = buildPrefix(G, csr);
      post({type: "built", reqId: m.reqId, ion: inp.ion, csr, prefix, ms: now() - t0},
        [csr.start.buffer, csr.len.buffer, csr.ptr.buffer, csr.vals.buffer, prefix.order.buffer, prefix.sOutSorted.buffer, prefix.ckpt.buffer]);
    }
  } catch (e) {
    post({type: "error", reqId: m.reqId, message: String((e && e.message) || e)});
  }
}

if (typeof self !== "undefined" && typeof self.postMessage === "function" && typeof window === "undefined") {
  self.onmessage = e => handle(e.data, (msg, tr) => self.postMessage(msg, tr || []));
}
