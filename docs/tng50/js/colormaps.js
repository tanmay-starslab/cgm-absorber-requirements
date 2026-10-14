// Colour maps for the 3D viewer (Phase-2b design §5.2): 33 sRGB stops of every LUT in docs/tng50/data/luts/luts.json,
// each "iirrggbb" (entry index 0..255, then the colour of that entry), linearly interpolated back to 256 entries
// (tests/js/colormaps.mjs: within ±1 of luts.json; the stops are placed where the maps bend).
// tng_dusk and tng_ice are our own OKLab maps; magma, inferno, viridis (CC0, van der Walt & Smith) and cividis
// (Nuñez, Anderton & Renslow 2018) come from matplotlib 3.9; grey is linear. The STOPS block is written by
// `python docs/tng50/data/luts/make_luts.py --js docs/tng50/js/colormaps.js`. Pure module (no DOM).
export const STOPS = {
  tng_dusk: "0001041f070307280f080a33160f0e3c1d161146241e144f2b26175833311a623b3c1d6c434720764b53237f576c2782607e2a8169912d7d73a532767db8386d86c83f628fd7485494de4e4b9ae45849a1ea6347a7ef6d45aef57844b5fa8344bdff9046c6ffa256d0ffb469d6ffbe73ddffc87de4ffd289ebffdc95f4fee9abfffef7c9",
  tng_ice: "000005140a000c1f1400142a1e001c35290025412f002b483600314f3c00375643003e5e50004a6c570051745e00597b650061816d0069887500728e7d007b958500859c8d008ea2950098a89d00a1aea500abb4ad00b5b9b111babbb834c1bec04fc8c2c966d0c7d37edacdda8de0d2e29de7d7eaadeeddf2bdf5e4fdd1ffeeffdafff1",
  magma: "000000040703030f0d07061c140e0b2b1d19103f262512553036106b3a4710784254137d4b621980526d1d815a7922826184268169912b81709c2e7f77a8327d7eb3367a85bf3a778ecd407198dc4869a0e75263a8ef5d5eaff4695cb6f8765cbcfa815fc3fc8e64ccfe9f6dd5feb078dbfebb81e2fec88ceffde0a1f7fceeb0fffcfdbf",
  inferno: "00000004070302100e09061f16120a321c1b0c4123260c512d38096233420a683a4d0d6c4057106e4661136e4c6a176e52741a6e5d85216b638f2469699827666fa22b6275ab2f5e81bd38538ccc424897da4e3ca1e55c30acef6c23b7f67e14c2fa9207c9fc9f07d2fcb014d9fbbe23e1f8cd37ecf3e35af5f2f27dfbf6fa96fffcffa4",
  viridis: "004401540a47106314481d6f1b4826772346307e2e433e85344045883a3e4c8a4339558c4c355f8d5531688e5e2d718e6729798e7126828e7a228b8d841f948c8b1e9b8a931fa2879a23a983a22ab07faa35b779b344bf70bc56c667c66ccd5acc7ad151d289d548d898d83edfaadc32e6bddf26edd0e11cf4e2e418fdf8e621fffde725",
  cividis: "0000224e0a002a5f14003070170132711d14367023203a6f29293f6e2f31436d3538476c3b3e4b6c41444f6c4c4f576c57595e6e5d5e636f646568706b6b6d72727172747d7a7a7888848279918d88789b969077a5a09875afaaa073b7b3a670bfbbad6dc7c3b369cfccba64dbd9c55ce7e6d051ededd54af9fbe138fcfee434fffee838",
  grey: "00000000070707070f0f0f0f171717171f1f1f1f272727272f2f2f2f373737373f3f3f3f474747474f4f4f4f575757575f5f5f5f676767676f6f6f6f777777777f7f7f7f878787878f8f8f8f979797979f9f9f9fa7a7a7a7afafafafb7b7b7b7bfbfbfbfc7c7c7c7cfcfcfcfd7d7d7d7dfdfdfdfe7e7e7e7efefefeff7f7f7f7ffffffff"
};
export const NAMES = ["tng_dusk", "tng_ice", "magma", "inferno", "viridis", "cividis", "grey"];
export function lut(name, n = 256) {      // -> Uint8Array(n*4) RGBA
  const hex = STOPS[name] || STOPS.tng_dusk, m = hex.length / 8, out = new Uint8Array(n * 4);
  const c = (i, j) => parseInt(hex.substr(8 * i + 2 * j, 2), 16);     // j = 0: entry index, 1..3: R, G, B
  for (let k = 0, i = 0; k < n; k++) {
    const x = k / (n - 1) * 255;
    while (i < m - 2 && c(i + 1, 0) < x) i++;
    const a = c(i, 0), b = c(i + 1, 0), f = b > a ? (x - a) / (b - a) : 0;
    for (let j = 1; j <= 3; j++) out[4 * k + j - 1] = Math.round(c(i, j) * (1 - f) + c(i + 1, j) * f);
    out[4 * k + 3] = 255;
  }
  return out;
}
export function cssGradient(name, n = 9) {   // CSS linear-gradient stops for legends
  const L = lut(name), s = [];
  for (let i = 0; i < n; i++) { const k = Math.round(i / (n - 1) * 255) * 4; s.push(`rgb(${L[k]},${L[k + 1]},${L[k + 2]}) ${(100 * i / (n - 1)).toFixed(1)}%`); }
  return `linear-gradient(90deg, ${s.join(", ")})`;
}
