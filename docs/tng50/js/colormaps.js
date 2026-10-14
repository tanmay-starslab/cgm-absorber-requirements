// Colour maps for the 3D viewer: 33 evenly spaced sRGB stops of matplotlib 3.9 viridis, magma, inferno, cividis and
// gray (viridis/magma/inferno: van der Walt & Smith, CC0; cividis: Nuñez, Anderton & Renslow 2018), linearly
// interpolated to a 256-entry LUT. Pure module (no DOM): lut(name) -> Uint8Array(256*4) RGBA.
export const STOPS = {
  viridis: "440154470d6048186a482374472d7b4537814240863e49893b528b375b8d33638d2f6b8e2c728e297a8e26828e23898e21918c1f988b1fa08822a78528ae8032b67a3fbc734ec36b5ec96270cf5784d44b98d83eaddc30c2df23d8e219ece51bfde725",
  magma: "0000040303120a0822130d341d114729115a36106b440f7651127c5d177f6a1c81762181832681902a819c2e7faa337db73779c43c75d0416fdc4869e75263ef5d5ef56b5cf9795dfc8961fd9869fea772feb67cfec488fed395fde2a3fcf0b2fcfdbf",
  inferno: "0000040403120b0724150b37210c4a2f0a5b3d09654a0c6b57106e64156e71196e7d1e6d8a226a972766a32c61b0315bbc3754c73e4cd24644db503be45a31eb6628f1731df68013f98e09fb9d07fcac11fbbc21f9cb35f5db4cf2ea69f3f68afcffa4",
  cividis: "00224e00285b002e6a0533711a386f273e6e32436d3b496c434e6c4b546c535a6d5a5f6e61656f686a716f70737676767d7c788482798c8878938e789b9476a39a74aba072b4a76fbcae6cc4b468cdbb63d5c25edec958e7d150f0d846f9e03afee838",
  grey: "000000080808101010181818202020282828303030383838404040484848505050585858606060686868707070787878808080888888909090989898a0a0a0a8a8a8b0b0b0b8b8b8c0c0c0c8c8c8d0d0d0d8d8d8e0e0e0e8e8e8f0f0f0f8f8f8ffffff"
};
export const NAMES = Object.keys(STOPS);
export function lut(name, n = 256) {
  const hex = STOPS[name] || STOPS.viridis, m = hex.length / 6, out = new Uint8Array(n * 4);
  const c = (i, j) => parseInt(hex.substr(6 * i + 2 * j, 2), 16);
  for (let k = 0; k < n; k++) {
    const x = k / (n - 1) * (m - 1), i = Math.min(m - 2, Math.floor(x)), f = x - i;
    for (let j = 0; j < 3; j++) out[4 * k + j] = Math.round(c(i, j) * (1 - f) + c(i + 1, j) * f);
    out[4 * k + 3] = 255;
  }
  return out;
}
export function cssGradient(name, n = 9) {   // CSS linear-gradient stops for legends
  const L = lut(name), s = [];
  for (let i = 0; i < n; i++) { const k = Math.round(i / (n - 1) * 255) * 4; s.push(`rgb(${L[k]},${L[k + 1]},${L[k + 2]}) ${(100 * i / (n - 1)).toFixed(1)}%`); }
  return `linear-gradient(90deg, ${s.join(", ")})`;
}
