# Changelog

All notable changes to this project are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).
Detailed notes for each release are on the [Releases](https://github.com/tanmay-starslab/cgm-absorber-requirements/releases) page.

## [Unreleased]

### Changed
- **Explorer performance**: a device tier (`html[data-tier]` low, mid or high; `?tier=` overrides) from cheap signals and a
  one-off WebGL probe. Low tier: solid panels without blur, infinite animations play once, no liquid background, and the
  3D tab shows a still with a "Render 3D anyway" button. The Spectra tab's 3D thumbnail downloads cubes by itself only on
  the high tier over 4g. Sightline binaries ship gzipped, the first fits read a few-kB per-sightline slice instead of the
  whole components catalogue, the server catalogue loads on demand, app modules are preloaded, the phone story still is
  preloaded, and js, css and data are cached for 5 minutes (vendor files for a year).

## [1.0.0] - 2026-11-16

First tagged release of the site at https://galaxies.tanmaysingh.uk.

### Added
- **Explorer**: mock quasar absorption spectra through the circumgalactic medium of 198 TNG50 Milky Way and M31
  analogues; twelve ions from H I to O VII; any resolving power and S/N; in-browser Voigt fits; a 3D view of the gas
  with velocity colour maps; new sightlines on demand; a component search; and an Ask assistant that drives the page.
- **How an absorption spectrum is made**: a guided 3D story along one sightline, to scroll or watch, plus five short
  stories (a single cloud, cool and hot gas, a damped system, an empty halo, hot gas with faint hydrogen) on the
  welcome screen.
- **Detect & Resolve**: the minimum detectable column and smallest resolvable velocity separation for twelve CGM
  transitions, with figures and a technical note.
- Liquid-glass interface, three themes on the companion site, optional music, and a README with screenshots.

[Unreleased]: https://github.com/tanmay-starslab/cgm-absorber-requirements/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tanmay-starslab/cgm-absorber-requirements/releases/tag/v1.0.0
