// Head-control worker (classic, for importScripts): runs the vendored MediaPipe Face Landmarker off the main thread so
// the 3D render loop never waits for it. In: {type: "init", base, model} (absolute URLs), then {type: "frame", bmp, t}
// (an ImageBitmap, transferred and closed here). Out: {type: "ready", delegate} | {type: "pose", m (16 numbers) | null, t}
// | {type: "error", message}. Frames are never kept, stored or sent anywhere.
let lm = null;
self.onmessage = async ({data: d}) => {
  if (d.type === "init") {
    try {
      importScripts(d.base + "vision_bundle.js");
      const {FilesetResolver, FaceLandmarker} = self.Vision, fs = await FilesetResolver.forVisionTasks(d.base + "wasm");
      const opts = delegate => ({baseOptions: {modelAssetPath: d.model, delegate}, runningMode: "VIDEO", numFaces: 1,
        outputFacialTransformationMatrixes: true, outputFaceBlendshapes: false});
      let used = "CPU";
      try { lm = await FaceLandmarker.createFromOptions(fs, opts("CPU")); }   // XNNPACK on the CPU; the GPU delegate only as a fallback
      catch { lm = await FaceLandmarker.createFromOptions(fs, opts("GPU")); used = "GPU"; }
      self.postMessage({type: "ready", delegate: used});
    } catch (x) { self.postMessage({type: "error", message: String(x && x.message || x)}); }
    return;
  }
  if (d.type === "frame") {
    let m = null;
    try { if (lm) { const r = lm.detectForVideo(d.bmp, d.t); m = r.facialTransformationMatrixes?.[0]?.data ? Array.from(r.facialTransformationMatrixes[0].data) : null; } }
    catch (x) { self.postMessage({type: "error", message: String(x && x.message || x)}); }
    finally { d.bmp.close(); }
    self.postMessage({type: "pose", m, t: d.t});
  }
};
