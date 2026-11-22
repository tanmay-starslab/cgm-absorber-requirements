// Head and hand tracking (classic, for importScripts): the vendored MediaPipe Face Landmarker and Gesture Recognizer off
// the main thread, so the 3D render loop never waits for them. In: {type: "init", base, face, hands} (base: the vendor
// directory's absolute URL; face, hands: which trackers to build, so Hands only never loads the face model), then
// {type: "frame", bmp, t, face, hands} (an ImageBitmap, transferred and closed here; face/hands: which tracker reads it).
// Out: {type: "ready", delegate} | {type: "res", t, ms, m (16 numbers | null, face frames), hand ({g, score, lm: 63
// numbers} | null, hand frames)} | {type: "error", message}. Frames are never kept, stored or sent anywhere.
// Without OffscreenCanvas (older iOS) headctl.js loads this file as a page script and calls self.HeadTrack directly.
(() => {
  let face = null, hands = null, handsP = null;
  async function make(T, fs, opts) {   // XNNPACK on the CPU; the GPU delegate only as a fallback
    try { return [await T.createFromOptions(fs, opts("CPU")), "CPU"]; } catch { return [await T.createFromOptions(fs, opts("GPU")), "GPU"]; }
  }
  async function handle(d) {
    if (d.type === "init") {
      try {
        if (!self.Vision) importScripts(d.base + "vision_bundle.js");
        const {FilesetResolver, FaceLandmarker, GestureRecognizer} = self.Vision, fs = await FilesetResolver.forVisionTasks(d.base + "wasm");
        let used = "CPU";
        if (d.face) [face, used] = await make(FaceLandmarker, fs, delegate => ({baseOptions: {modelAssetPath: d.base + "face_landmarker.task", delegate}, runningMode: "VIDEO",
          numFaces: 1, outputFacialTransformationMatrixes: true, outputFaceBlendshapes: false}));
        if (d.hands) [hands, used] = await make(GestureRecognizer, fs, delegate => ({baseOptions: {modelAssetPath: d.base + "gesture_recognizer.task", delegate},
          runningMode: "VIDEO", numHands: 1}));
        return {type: "ready", delegate: used};
      } catch (x) { return {type: "error", message: String(x && x.message || x)}; }
    }
    if (d.type === "hands") {
      try {
        if (!hands && d.base) {
          handsP ||= (async () => {
            const {FilesetResolver, GestureRecognizer} = self.Vision, fs = await FilesetResolver.forVisionTasks(d.base + "wasm");
            [hands] = await make(GestureRecognizer, fs, delegate => ({baseOptions: {modelAssetPath: d.base + "gesture_recognizer.task", delegate},
              runningMode: "VIDEO", numHands: 1}));
          })().finally(() => { handsP = null; });
          await handsP;
        }
        return {type: "hands-ready"};
      } catch (x) { return {type: "hands-error", message: String(x && x.message || x)}; }
    }
    if (d.type === "frame") {
      const r = {type: "res", t: d.t}, t0 = performance.now();
      try {
        if (d.face && face) { const f = face.detectForVideo(d.bmp, d.t).facialTransformationMatrixes?.[0]; r.m = f?.data ? Array.from(f.data) : null; }
        if (d.hands && hands) { const g = hands.recognizeForVideo(d.bmp, d.t), lm = g.landmarks?.[0], c = g.gestures?.[0]?.[0];
          r.hand = lm ? {g: c?.categoryName || "None", score: c?.score ?? 0, lm: lm.flatMap(p => [p.x, p.y, p.z])} : null; }
      } catch (x) { return {type: "error", message: String(x && x.message || x)}; }
      finally { d.bmp.close?.(); }
      r.ms = performance.now() - t0;
      return r;
    }
    return null;
  }
  if (typeof importScripts === "function" && typeof window === "undefined") self.onmessage = async ({data}) => { const r = await handle(data); if (r) self.postMessage(r); };
  else self.HeadTrack = handle;
})();
