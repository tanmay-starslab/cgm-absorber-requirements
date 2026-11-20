# uisfx (vendored)

- Package: `uisfx` 0.4.0 from npm (`npm pack uisfx@0.4.0`), https://uisfx.com, https://github.com/romainsimon/uisfx
- `uisfx.js`: the package's `dist/index.js` (sha256 d64edf28f823b2a52a38e8df41023d31fe62de04e822e0569f4cd2e00ddfa579),
  with only the trailing `//# sourceMappingURL` comment removed. A self-contained ES module with no imports, so it loads
  from a relative path without a bundler.
- Sounds are synthesised in the browser from the runtime's recipes; none of the package's `sounds/` files are needed.
- Licences: code MIT (`LICENSE`), audio CC0 1.0 (`LICENSE-AUDIO`).
- Used by `docs/tng50/js/uisound.js`, which imports it only after a visitor turns Sounds on.
