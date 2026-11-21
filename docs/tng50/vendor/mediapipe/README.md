# MediaPipe Tasks Vision, Face Landmarker and Gesture Recognizer (vendored)

Used only by the 3D tab's opt-in head and hand control (`docs/tng50/js/headctl.js`, worker `js/headworker.js`). Nothing here
loads until a visitor presses the control button and then Start; Hands only never loads the face model, Head only never the
hand model. Every file is served from this site; no Google CDN is contacted.

| File | Size (bytes) | sha256 | Source |
|---|---:|---|---|
| `vision_bundle.js` | 155,953 | `07f439b7c42d5f75dcae5c56587da4fc33cd9b5e9a08b2cc701ea582e3309dbd` | npm `@mediapipe/tasks-vision@1.2.3`, `vision_bundle.js` (upstream sha256 `9c2d4373d0f50dfcc91b07b6a884a74c42e163e067757b40fcf24b0edf800f3d`), patched, see below |
| `wasm/vision_wasm_internal.js` | 336,624 | `2aa5fd3fdd3d8208cd7587df0bb19fb6925c4ea16a76dd025aedc1f64d6a6309` | same package, `wasm/`, unmodified |
| `wasm/vision_wasm_internal.wasm` | 14,665,716 | `225bc06c0f51a9cf31fea0e9e0b0243e9e01fb5ef332cc1a7fa6656dbdfdaabf` | same package, `wasm/`, unmodified |
| `face_landmarker.task` | 3,758,596 | `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff` | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task (float16, downloaded 2026-11-19) |
| `gesture_recognizer.task` | 8,373,440 | `97952348cf6a6a4915c2ea1496b4b37ebabc50cbbf80571435643c455f2b0482` | https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task (float16, object generation 1682480004119009 of 2023-04-26, downloaded 2026-11-21), unmodified |
| `LICENSE` | 12,331 | `8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8` | https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE (Apache-2.0) |

- Package tarball: https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.2.3.tgz
  (sha256 `469602650dab70256df387983ea44e85fa66020335bae85a54fa8fda062ca0a0`).
- Total about 27.3 MB; every file is under 25 MiB: the largest (the WASM, 14.0 MiB) is under Cloudflare Workers' 25 MiB per-asset limit.
- Only the plain WASM build is shipped (`vision_wasm_internal.*`, no `_module_` variant). It runs on the CPU with XNNPACK;
  the worker asks for the GPU delegate only if the CPU one fails to start.
- `vision_bundle.js` is the classic (IIFE, global `Vision`) build, so the worker loads it with `importScripts`. Changes,
  all in the usage logger: its 60 s `setInterval` flush is removed and the logger starts in its error state, so it never
  sends; the logging URL (`https://odml.pa.googleapis.com/v1/log`) is replaced by an empty string; the trailing
  `//# sourceMappingURL` comment is removed. No other byte differs.
- Apache-2.0: the licence text is `LICENSE`; the modifications are listed above.
