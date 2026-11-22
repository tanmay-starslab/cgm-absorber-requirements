# Contributing

Thank you for taking a look! This is a fun, fast-moving space for exploring galaxy halos and absorption spectra — bug reports, wild ideas, science feedback and pull requests are all warmly welcome. The place to start is [GitHub Issues](https://github.com/tanmay-starslab/cgm-absorber-requirements/issues).

## Ways to help

- **Report a bug.** Please include:
  - the page URL, with its `#…` part (it holds the galaxy, sightline and instrument settings);
  - your browser, its version and your device;
  - the steps that lead to the problem;
  - a screenshot;
  - any errors in the browser console.
- **Suggest an idea or a feature.** Say what you want to do and why. A rough sketch helps.
- **Check the science.** If a number, unit or physics claim looks wrong, open an issue that names the page or file
  and, if you can, a reference.
- **Send a pull request** for code or docs. For anything larger than a small fix, open an issue first so we can
  agree on the approach.

## Using AI tools

This site was built heavily with **Claude** and **Antigravity**, and you are warmly encouraged to use AI coding and research tools to move fast, prototype ideas and accelerate your contributions!

The most important requirement is **scientific accuracy**: because the maintainer may not be able to inspect every generated line by hand, you are responsible for verifying that every equation, unit, atomic constant, physical claim and test in your contribution is scientifically sound and passes the test suite.

## Development setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt   # Detect & Resolve, figures, tests
.venv/bin/pip install -r requirements-tng.txt                         # the explorer backend (see the README)
```

The figures need LaTeX with `txfonts`, `dvipng`, `type1cm` and `cm-super`. The JS tests need a recent Node (22 or
later, for the built-in `WebSocket`) and have no npm dependencies.

To run the pages locally, serve `docs/` and open http://127.0.0.1:8000/tng50/ (the explorer) or
http://127.0.0.1:8000/ (Detect & Resolve):

```bash
(cd docs && python3 -m http.server 8000)
```

To build the site exactly as it is deployed (written to `dist/`):

```bash
node scripts/build_site.mjs
```

[`docs/TNG50_OPERATIONS.md`](docs/TNG50_OPERATIONS.md) covers the data rebuilds, the backend and deployment.

## Tests

```bash
.venv/bin/python -m pytest tests
PYTHON=.venv/bin/python node tests/js/run_all.mjs
```

The headless-browser tests are skipped unless `TNG_BROWSER=1` is set (and need a Chromium-based browser; set
`TNG_EDGE` to its path if it is not found).

## Conventions

- Branches are named `area/short-name`: `explorer/…`, `explainer/…`, `docs/…`, `grids/…`, `paper/…`.
- Keep commits small, with descriptive messages.
- Pull requests are merged with a merge commit, never squashed.
- UI style: minimal on-screen text, no dot separators, spectra dominant, and reduced motion respected.
- Do not change the physics, the grids or published numbers without discussing it in an issue first. They feed a
  technical note and a proposal.

## Labels, releases and versions

- Every issue and pull request gets a `type:` label (bug, feature, docs, science, performance, refactor, test, chore)
  and an `area:` label (explorer, explainer, 3d, spectra, chat, server, data, requirements, site, ci). `priority:` and
  `status:` labels are used during triage.
- Releases are tagged `vMAJOR.MINOR.PATCH` ([Semantic Versioning](https://semver.org/)). Release notes are generated
  from merged pull requests, grouped by their `type:` label, and [CHANGELOG.md](CHANGELOG.md) summarises each release.
- CI (GitHub Actions) runs the Python tests, the JS tests and a site build on every pull request.

## Data and licences

- Code is MIT ([`LICENSE`](LICENSE)). By contributing you agree that your code is released under it.
- TNG50-derived data are not MIT. They follow the TNG Collaboration's
  [terms and citation request](https://www.tng-project.org/data/docs/background/#citation); see the README's licence
  section.
- Please do not add GPL-licensed code.
- Large data lives on Hugging Face, not in git.

## Be kind

Be respectful and patient with everyone; we are all here to learn.
