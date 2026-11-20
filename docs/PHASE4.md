# Phase 4: galaxy registry and physics definitions

Two data files every Phase 4 page reads. Python and JS read the same files.

## Physics definitions: `tngsight/definitions.json`

This file is the one source of truth for the D8/D9 physics choices (owner approved 2026-11-19). It holds:

- **phases:** cool < 10^4.5 K, warm, hot > 10^5.5 K (non-SF gas). The toggles are the observer 4-phase scheme and the
  virial split at f T200 (f = 0.3, 0.5). SF gas is its own class, "ISM (eEOS)". It is counted in masses but left out of
  T, K, P, t_cool and ion statistics.
- **regions:** CGM = non-SF gas at 0.15–1 R200c. ISM = SF gas plus everything inside 0.15 R200c. Outskirts run to
  2 R200c.
- **virial:** T200 = μ m_p G M200c / (2 k R200c) with μ = 0.59. The spherical-overdensity rules for R200c, R200m and
  R_vir (Bryan & Norman 1998).
- **frame:** the default is the signed stellar spin within 2 r_1/2,*. The alternatives are cold-gas spin, SF-gas spin
  and the TNG cutout frame. The cutout frame has no sign, so its angles are folded to 0–90°.
- **cooling** (native `GFM_CoolingRate`, or the PS20 table), the **t_ff** convention and **satellites** (all gas, or
  exclude Subfind-bound gas).
- **toggles:** every toggle with its options and default.
- **bins:** log T edges 4.5, 5, 5.5, 6; r edges 0.1, 0.15, 0.3, 1 and 2 R200c, plus R200m per halo.
- **texts:** the caveat and stamp lines.
- **citations:** arXiv IDs. PS20 is arXiv:2006.14322.

`tngsight.definitions.load()` parses and validates the file. `validate()` checks:

- the bin edges are sorted and include the required ones;
- every phase boundary and region edge is a bin edge;
- every toggle default is one of its options;
- the section defaults agree with the toggles;
- the texts follow house style.

## Galaxy registry: `galaxies/<sim>-<snap>-<id>.json`

There is one record per galaxy, e.g. `galaxies/tng50-1-099-488530.json` (about 3 kB). It follows the schema in
`tests/schemas/galaxy.schema.json` (`galaxy/1`). Units are physical kpc, Msun, km/s, K and degrees. Each record holds:

- **identity:** sim, snap, Subfind ID, central or FoF satellite, and the host subhalo;
- **position and velocity:** `pos_kpc` (minimum-potential bound particle) and `vel_kms` (mass-weighted bound
  particles);
- **radii:** `so.R200c`, `so.R200m` and `so.Rvir_BN` (R and M), recomputed about the galaxy itself from all particle
  types in the cutout. For the 8 FoF satellites, the catalogue R200c belongs to the host group. `host_so` recomputes
  that host value as a check;
- **T200, r_1/2,*, M★, M_gas and SFR** (bound particles; M★ excludes wind particles);
- **frame:** `frame.R` holds rows x, y, z, with r_disk = R (r_box − pos). z is the signed stellar spin of the bound
  stars within 2 r_1/2,*, measured about their bulk velocity within 10 kpc. x is the projected stellar major axis;
- **misalignments:** `misalignment_deg` against the cold-gas spin, the SF-gas spin and the TNG cutout frame (raw and
  folded);
- **satellite gas:** `sat_gas_frac`, the fraction of 0.15–1 R200c gas bound to other subhalos;
- **phase masses:** `masses_Msun`, CGM masses by phase (all gas, and with bound satellite gas excluded), the ISM and
  the outskirts;
- `flags` and `catalogue`, the host-catalogue values kept for cross-checks;
- `provenance`: the source URL, the cutout's sha256, the definitions version and the methods.

How to build and check the records:

```bash
python -m tngsight.registry build --ids 488530           # one galaxy (about 20 s to 3 min, 1-2 GB)
python -m tngsight.registry build --chunk 3/20           # SLURM array task 3 of 20
python -m tngsight.registry check                        # catalogue cross-checks and schema errors
```

The inputs are the published TNG50-1 MW/M31 cutouts (`$TNG_MWM31_ROOT`, see `tngsight/galaxy.py`). The build only
reads them. `tests/test_registry.py` runs on the committed records plus a synthetic cutout, so no SOL data is needed.

**Note:** the explorer still uses the cold-gas frame from `tngsight/galaxy_488530.json`. Switching it to the registry
frame waits for the owner's review.
