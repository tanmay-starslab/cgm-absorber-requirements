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
/* vel3d: the velocity views' maps (OKLab, same stop format; not in luts.json, so not in NAMES or the field-colour list).
   tng_vel is diverging: blue (approaching, inflow, counter-rotating) through a neutral grey at 0 to red (receding,
   outflow, co-rotating), lightness rising from 0.66 at 0 to 0.80 at both ends so neither sign fades into the dark stage.
   tng_vel_po (purple to orange) and tng_vel_teal (teal to rose) are colour-blind-safer alternatives with the same
   lightness profile. tng_speed is sequential (violet to pale yellow, OKLab L 0.40 to 0.96) for |v| and σ_los. */
export const VEL_STOPS = {
  tng_vel_po: "00d3a1ff08cfa1ff10caa0ff18c69ffd20c29ff428be9eec30ba9de438b69cdc40b19bd348ad9acb50a999c358a598bb60a197b3689d96aa709a95a27896939a809292928799938f8fa0958c97a896899faf9885a7b69981afbd9a7eb7c59c7abfcc9d75c7d39e71cfda9f6cd7e1a067dfe8a162e7efa15ceff6a255f7fea34effffa446",
  tng_vel_teal: "0054d4d4085cd0cf1062cccb1868c8c7206ec4c32872bfbf3077bbba387bb7b6407eb3b24881afae5084abaa5887a7a6608aa2a2688c9e9e708e9a9a7890969680939292879a92948fa3929797ab92999fb4929ca7bc929fafc492a1b7cc92a4bfd491a6c7dc91a9cfe490acd7ec90aedff38fb1e7fb8eb3efff8db6f7ff8cb9ffff8bbb",
  tng_vel: "006ec2ff0870c0ff1072bdff1875bbff2077b8ff2879b6fa307bb3f2387db1eb407faee34881abdb5083a8d25885a5ca6087a2c168899fb7708b9bad788e97a18094929287a1928f8fac938d97b6938c9fbf938aa7c79489afcf9488b7d69487bfde9486c7e59584cfec9583d7f29582dff99581e7ff9580efff957ff7ff957effff957d",
  tng_speed: "00503975085a3b7b10643c80186e3d8520793f892884408c308f418d389a428e40a5438e48b0458e50bb478c58c64a8960d04d8668d9508270e2557d78eb5a7980f2607387f9666f8fff6d6a97ff75659fff7e60a7ff875dafff915bb7ff9a5abfffa45bc7ffae5fcfffb864d7ffc26bdfffcc74e7ffd57fefffde8af7ffe796fffff0a3"
};
export const VEL_NAMES = {signed: ["tng_vel", "tng_vel_po", "tng_vel_teal"], unsigned: ["tng_speed", "magma", "inferno", "viridis", "cividis", "grey"]};
export function lut(name, n = 256) {      // -> Uint8Array(n*4) RGBA
  const hex = STOPS[name] || VEL_STOPS[name] || STOPS.tng_dusk, m = hex.length / 8, out = new Uint8Array(n * 4);
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
