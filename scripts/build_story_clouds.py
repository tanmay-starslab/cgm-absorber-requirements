#!/usr/bin/env python
"""CREST-3D v2 clouds on the story ray (story-data/2, DESIGN_final C_science H5/H6, P2-11).

Finds the 3D gas structures that the story sightline pierces and maps every fitted spectral component onto them, for
any galaxy and ray with a story cell dump (scripts/export_story_data.py cells). Adapted from the R_clouds prototype
(notes/story2/R_clouds.md, scratch/story2_w/R_clouds/crest3d/clouds3d.py) with these changes:

  * the ray is the story ray itself (library geom start/end, the yt ray of the cell dump), not a line through the first
    and last cell generators; the on-ray members are exactly the story's ray cells, joined by cutout cell index, and
    their l_in/l_out are the story's kernel entry/exit s_in/s_out (asserted against the cloud's own projection);
  * galaxy, ray, inputs and outputs are parameters (no hard-coded 488530 paths);
  * a precomputed 0.25-dex iso ladder (+-1 dex around the chosen level) for the threshold handle, each ladder cloud
    linked to its parent cloud at the chosen level by shared on-ray column;
  * the pts record is 11 B (u2x3, u1, u1, u1, i1, u1), documented as such.

Method (unchanged from the prototype, R_clouds section 2): CREST responsibilities phi_ic of the per-cell Voigt
optical depths against the catalogue components (region rule); Delaunay graph (= Voronoi adjacency) of all cells
within tube_kpc of the ray, hull edges longer than edge_fac (r_i + r_j) dropped; friends of friends per ion linking
neighbours with n_ion >= n_iso at both ends, r_perp <= R_max and |V_i - V_j| <= max(b_i, b_j, 8 km/s); clouds are the
linked structures that contain a ray cell; n_iso starts at the lowest ion density of the ray cells holding 99 % of the
column minus 0.5 dex and is raised in 0.25 dex steps until no structure holds > 50 % of the ray column or spans > 60 kpc
of the ray (non-percolation rule). Techniques after Lucchini et al. (2024, 2025; TNG50 HVCs: contiguous Voronoi-
neighbour walks, kinematic coherence reported as a diagnostic) and the owner's CREST attribution. vortrace is not used.

Usage:
  python scripts/build_story_clouds.py [--galaxy 488530] [--ray rand_b062_a062] [--work DIR] [--out DIR] [--ions HI OVI]
Outputs <out>/<gid>_<ray>/clouds.json (schema clouds3d/3) and per-cloud *.bin.gz; diagnostics to <work>/<gid>_<ray>_clouds_report.json.
"""
from __future__ import annotations
import argparse
import gzip
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import export_story_data as E          # noqa: E402

KB, AMU, C_KMS, KPC_CM = E.KB, E.AMU, E.C, E.KPC_CM
# ion key -> (ray dump field, Trident atomic mass, viz-cache cell key)
IONS = {"HI": ("H_p0_number_density", 1.00794), "MgII": ("Mg_p1_number_density", 24.305),
        "SiII": ("Si_p1_number_density", 28.0855), "CII": ("C_p1_number_density", 12.0107),
        "SiIII": ("Si_p2_number_density", 28.0855), "CIV": ("C_p3_number_density", 12.0107),
        "OVI": ("O_p5_number_density", 15.9994)}
P2 = dict(col_frac=0.99, iso_dex=0.5, dv_link_floor=8.0, R_max=40.0, tube_kpc=55.0, edge_fac=1.5, grid_max=32,
          min_cells_vol=8, vox_min_kpc=0.25, dv3_frac=0.5, dv3_min=30.0, min_ray_frac=0.01, min_comp_frac=0.05,
          perc_frac=0.5, perc_kpc=60.0, ladder_dex=0.25, ladder_n=4, ladder_mesh_frac=0.05, ladder_grid=16)
VGRID = np.arange(-1500.0, 1500.0 + 0.125, 0.25)
DV = 0.25
SCHEMA = "clouds3d/3"
ENC = {"pts": "per cell 11 B, little endian, packed: u2x3 position q (disk frame kpc = lo + q/65535*span), "
              "u1 log10 r_eq kpc ((x/255)*3.5 - 2), u1 log10 n_ion cm^-3 ((x/255)*16 - 16), u1 log10 T K ((x/255)*5 + 3), "
              "i1 (V - V_cloud)/2 km/s, u1 flags (1 = on the story ray)",
       "cube": "u8 log10 n_ion cm^-3 ((x/255)*16 - 16), C order [ix][iy][iz], voxel centres lo + i*dx (disk frame kpc)",
       "mesh": "nv x 3 u8 vertex = round(255 * cube_index/(shape-1)) (position lo + v/255*(shape-1)*dx), then nf x 3 "
               "u16 triangle indices (u32 when nv >= 65536); iso surface at the cloud's log n_iso",
       "ladder": "concatenation of mesh blobs (same encoding, each on its own cube given in the index) at byte offsets"}


def log(*a):
    print(f"[{time.strftime('%H:%M:%S')}]", *a, flush=True)


# ------------------------------------------------------------------------------------------------ inputs
def viz_cache_dir(gid: int) -> Path:
    if int(gid) == E.REF_GALAXY:
        return E.work_root() / "data" / "library_v3r" / "viz_cache" / "gas"
    return E.work_root() / "data" / "gal" / str(int(gid)) / "viz_cache" / "gas"


def load_tube_cells(gid, paths, gal, ions, H, extra=()):
    """Per-cell arrays (cutout order) needed by the cloud finder: box positions (kpc), h, V_cm3, m, T, ion densities,
    box velocities. From the galaxy's viz cache when it is complete, else computed by yt (tngsight.volume.cell_arrays)."""
    import h5py
    cache = viz_cache_dir(gid)
    keys = ["h", "V_cm3", "m", "T"] + list(ions) + [k for k in extra if k not in ions]
    have = all((cache / f"cells_{k}.npy").is_file() for k in keys + ["pos_disk"])
    with h5py.File(paths["cutout"], "r") as f:
        a = float(f["Header"].attrs.get("Time", 1.0))
        xb = f["PartType0/Coordinates"][:].astype(np.float64) / H
        vb = f["PartType0/Velocities"][:].astype(np.float64) * math.sqrt(a)
    if have:
        cells = {k: np.load(cache / f"cells_{k}.npy", mmap_mode="r") for k in keys}
        src = "viz cache " + "/".join(Path(cache).parts[-3:])   # no host path in shipped JSON (film_final privacy check)
    else:                                   # any of the 198 hosts: the pipeline's own per-cell fields through yt
        from tngsight import generate as G
        from tngsight import volume as Vo
        idx = Path(os.environ["TNG_INDEX_FILE"])
        cut = E.cutout_view(Path(paths["cutout"]), idx.parent)
        gen = G.Generator(cutout=cut, index_filename=idx, workdir=idx.parent / "gen", fit_components=False)
        gen.load()
        allc = Vo.cell_arrays(gen.ds)
        cells = {k: allc[k] for k in keys}
        src = "yt (tngsight.volume.cell_arrays)"
    if len(cells["h"]) != len(xb):
        raise SystemExit(f"cell arrays ({len(cells['h'])}) and cutout ({len(xb)}) differ in length")
    cells["xb"] = xb; cells["vb"] = vb
    return cells, src


# ------------------------------------------------------------------------------------------------ CREST
def tau_voigt(V, logN, b, key):
    from tngsight import vpfit
    return vpfit.tau_components(VGRID, [[V, logN, b]], key)


def cell_tau(V, N, b, key):
    """per-cell tau on VGRID (rows = cells), the tngsight.vpfit Voigt formula (same as the components)."""
    from tngsight import vpfit
    out = np.zeros((len(V), VGRID.size))
    for i in range(len(V)):
        if not (N[i] > 0 and b[i] > 0) or math.log10(N[i]) < 5:
            continue
        w = np.abs(VGRID - V[i]) < max(60.0 * b[i], 300.0) if key != "HI" else slice(None)
        out[i, w] = vpfit.tau_components(VGRID[w], [[V[i], math.log10(N[i]), b[i]]], key)
    return out


def crest(tau_i, comps, regions, key):
    """CREST responsibilities phi (ncell, ncomp) with the region rule; beta (claimed / fitted tau), kappa (orphans)."""
    from tngsight import vpfit
    nc = len(comps)
    tau_c = np.zeros((nc, VGRID.size)); active = np.zeros((nc, VGRID.size), bool)
    reg = {int(r[0]): (r[1], r[2]) for r in regions}
    for c, row in enumerate(comps):
        tau_c[c] = vpfit.tau_components(VGRID, [[row[0], row[2], row[4]]], key)
        lo, hi = reg.get(int(row[6]), (VGRID[0], VGRID[-1]))
        active[c] = (VGRID >= lo) & (VGRID < hi)
    ta = np.where(active, tau_c, 0.0)
    den = ta.sum(0)
    rho = np.divide(ta, den, out=np.zeros_like(ta), where=den > 0)
    tot = tau_i.sum(1) * DV
    R = tau_i @ rho.T * DV
    phi = np.divide(R, tot[:, None], out=np.zeros_like(R), where=tot[:, None] > 0)
    beta = R.sum(0) / np.maximum(tau_c.sum(1) * DV, 1e-300)
    kappa = (tau_c * (tau_i.sum(0) > 0)).sum(1) / np.maximum(tau_c.sum(1), 1e-300)
    return phi, beta, kappa


# ------------------------------------------------------------------------------------------------ graph + FoF
def build_graph(pos_d, h, ray):
    """Delaunay of every cell within tube_kpc of the story ray line (disk frame), hull edges pruned."""
    from scipy.spatial import Delaunay
    rel = pos_d - ray["p0"]; s = rel @ ray["n"]
    perp = np.linalg.norm(rel - s[:, None] * ray["n"], axis=1)
    sel = np.flatnonzero((perp <= P2["tube_kpc"]) & (s >= -20) & (s <= ray["L"] + 20))
    t = time.time()
    tri = Delaunay(pos_d[sel])
    indptr, nbr = tri.vertex_neighbor_vertices
    r_cell = 0.5 * np.asarray(h)[sel]
    src = np.repeat(np.arange(sel.size), np.diff(indptr))
    d = np.linalg.norm(pos_d[sel][src] - pos_d[sel][nbr], axis=1)
    ok = d <= P2["edge_fac"] * (r_cell[src] + r_cell[nbr])
    log("tube", sel.size, "delaunay", round(time.time() - t, 1), "s, edges kept", round(float(ok.mean()), 4))
    return dict(sel=sel, src=src[ok], dst=nbr[ok], s=s[sel], perp=perp[sel],
                stats=dict(n_tube=int(sel.size), n_edges=int(nbr.size), frac_kept=float(ok.mean())))


def fof(G, nion, Vl, b_ion, n_iso, ray_local):
    from scipy.sparse import csr_matrix
    from scipy.sparse.csgraph import connected_components
    src, dst = G["src"], G["dst"]
    ok_node = (nion >= n_iso) & (G["perp"] <= P2["R_max"])
    link = np.maximum(np.maximum(b_ion[src], b_ion[dst]), P2["dv_link_floor"])
    e = ok_node[src] & ok_node[dst] & (np.abs(Vl[src] - Vl[dst]) <= link)
    A = csr_matrix((np.ones(int(e.sum()), np.int8), (src[e], dst[e])), shape=(G["sel"].size,) * 2)
    _, lab = connected_components(A, directed=False)
    lab = np.where(ok_node, lab, -1)
    keep = np.unique(lab[ray_local][lab[ray_local] >= 0])
    return lab, keep


def principal_axes(pos, w):
    mu = (pos * w[:, None]).sum(0) / w.sum()
    d = pos - mu
    I = (d[:, :, None] * d[:, None, :] * w[:, None, None]).sum(0) / w.sum()
    ev, evec = np.linalg.eigh(I)
    return mu, np.sqrt(np.maximum(ev[::-1], 0)) * 2.0, evec[:, ::-1]


def splat_cube(pos, r, w, grid_max=None):
    grid_max = grid_max or P2["grid_max"]
    lo = pos.min(0) - 2 * r.max(); hi = pos.max(0) + 2 * r.max()
    ext = float((hi - lo).max())
    dx = max(ext / grid_max, P2["vox_min_kpc"])
    n = np.minimum(np.ceil((hi - lo) / dx).astype(int) + 1, grid_max)
    dx = float(max(((hi - lo) / (n - 1)).max(), dx))
    cube = np.zeros(tuple(n))
    ax = [lo[k] + dx * np.arange(n[k]) for k in range(3)]
    for p, rr, ww in zip(pos, r, w):
        sg = max(rr / 1.5, 0.5 * dx)
        idx = []
        for k in range(3):
            a = np.searchsorted(ax[k], p[k] - 3 * sg); b = np.searchsorted(ax[k], p[k] + 3 * sg)
            idx.append((a, max(b, a + 1)))
        g = [np.exp(-0.5 * ((ax[k][idx[k][0]:idx[k][1]] - p[k]) / sg) ** 2) for k in range(3)]
        st = g[0][:, None, None] * g[1][None, :, None] * g[2][None, None, :]
        ssum = st.sum()
        if ssum > 0:
            cube[idx[0][0]:idx[0][1], idx[1][0]:idx[1][1], idx[2][0]:idx[2][1]] += ww * st / ssum
    return cube / dx ** 3, lo, dx


def mesh_bytes(lc, level):
    if not (lc.max() > level > lc.min()):
        return b"", 0, 0
    from skimage.measure import marching_cubes
    vv, ff, _, _ = marching_cubes(np.pad(lc, 1, constant_values=-30), level=level)
    vv = vv - 1
    b = np.round(np.clip(vv / (np.array(lc.shape) - 1), 0, 1) * 255).astype("u1").tobytes() + \
        ff.astype("<u2" if len(vv) < 65536 else "<u4").tobytes()
    return b, len(vv), len(ff)


def cloud_cube(pos, r_cell, Nion_cell, grid_max=None):
    cube, clo, dx = splat_cube(pos, r_cell, Nion_cell / KPC_CM ** 3, grid_max)
    lc = np.log10(np.maximum(cube, 1e-30))
    return lc, clo, dx


def doppler_z(v_box, n_los):
    """yt/Trident's redshift_dopp of cells with 3D simulation-frame velocity v_box (km/s, shape (n, 3)) seen along
    n_los: 1 + z = gamma(|v|) (1 - v.n_los / c), the full relativistic shift including the transverse term."""
    v = np.atleast_2d(np.asarray(v_box, float))
    beta2 = np.sum((v / C_KMS) ** 2, axis=1)
    return (1 - (v @ np.asarray(n_los, float)) / C_KMS) / np.sqrt(1 - beta2) - 1


# ------------------------------------------------------------------------------------------------ main
def build(gid, ray_id, work: Path, out: Path, ions=("HI", "OVI")):
    from tngsight.library import load_npz
    gid = int(gid)
    paths = E.galaxy_paths(gid)
    st = E.stem(gid, ray_id)
    raw = np.load(work / f"{st}_cells.npz")
    lib = E.story_library(gid, ray_id, work, paths)   # one-ray Trident library from stage_cells, if any
    p = load_npz(str(lib / "sightlines" / f"{ray_id}.npz"), id=ray_id)
    comps_all = json.loads((lib / "components" / f"{ray_id}.json").read_text())
    gal = json.loads(paths["galaxy_json"].read_text())
    H = float(gal["TNG_H"])
    vsys = float(p["v_sys"])
    qg, ug, tab = E.kernel_cdf_table()
    geo = E.cell_geometry(raw, gal, p["geom"], paths["cutout"], tab)
    ray = geo["ray"]
    log("geometry", geo["checks"], "n_crossed", geo["n_crossed"])
    cells, src = load_tube_cells(gid, paths, gal, ions, H)
    c, R = ray["centre"], ray["R"]
    pos_d = (cells["xb"] - c) @ R.T
    n_los = np.asarray(p["geom"]["n_los"], float)
    vrel = cells["vb"] - np.asarray(gal["SubhaloVel_kms"], float)
    Vcell = -(vrel @ n_los)                                   # spectrum-frame V of every cell (galaxy at 0)
    v3_disk = vrel @ R.T
    T_all = np.asarray(cells["T"]); h_all = np.asarray(cells["h"]); Vcm3 = np.asarray(cells["V_cm3"])
    mass = np.asarray(cells["m"])
    gidx_ray = geo["gidx"]
    # yt/Trident's redshift_dopp is the relativistic Doppler shift: invert it exactly (c z exceeds the line-of-sight
    # speed by ~ beta^2 c / 2, 0.7 km/s at 650 km/s) before comparing with the cell velocities
    # V_ray (spectrum frame, c z) stays what the spectrum uses; only the check uses the physical speed
    zd = np.asarray(raw["redshift_dopp"], float)
    V_ray = C_KMS * zd + vsys
    V_phys = C_KMS * ((1 + zd) ** 2 - 1) / ((1 + zd) ** 2 + 1) + vsys
    sign_radial = float(np.max(np.abs(Vcell[gidx_ray] - V_phys)))
    # yt's redshift_dopp is the full relativistic shift in the simulation (box) frame:
    # 1 + z = gamma(|v_box|) (1 + v_los,box / c). The radial-only inverse above misses the transverse term
    # (~ beta_t^2 c / 2: 0.65 km/s on rand_b045_a300_s459727623, whose ray cells move fast across the line of
    # sight), so the check predicts z forward from each ray cell's 3D box-frame velocity instead.
    z_pred = doppler_z(np.asarray(cells["vb"], float)[gidx_ray], n_los)
    sign_check = float(np.max(np.abs(C_KMS * (z_pred - zd))))
    log("V check (km/s): forward relativistic", sign_check, "radial-only inverse", sign_radial)
    if sign_check > 0.5:
        raise SystemExit(f"V of the ray cells differs from the cell velocities by {sign_check} km/s "
                         f"(radial-only inverse {sign_radial})")
    G = build_graph(pos_d, h_all, ray)
    g_of = -np.ones(len(pos_d), np.int64); g_of[G["sel"]] = np.arange(G["sel"].size)
    ray_local = g_of[gidx_ray]
    if (ray_local < 0).any():
        raise SystemExit("a ray cell lies outside the graph tube")
    # every member's own projection on the story ray, to assert against the exporter's s_in/s_out
    s_proj = G["s"][ray_local] - ray["half"]
    dproj = float(np.max(np.abs(s_proj - geo["lc"])))
    if dproj > 0.05:
        raise SystemExit(f"ray cells: projection differs from the exporter's l by {dproj} kpc")
    report = dict(galaxy=gid, ray=ray_id, method="crest3d/2 on the story ray (FoF on Voronoi graph in position + "
                  "V_los, CREST map)", params=P2, cells_source=src, V_sign_check_kms=sign_check,
                  geometry_checks=geo["checks"], proj_vs_exporter_max_kpc=dproj, graph=G["stats"], ions={})
    odir = out / st
    odir.mkdir(parents=True, exist_ok=True)
    for f in odir.glob("*.bin.gz"):
        f.unlink()
    web = dict(schema=SCHEMA, galaxy=gid, ray_id=ray_id,
               frame="disk frame (xhat, yhat, Lhat), kpc from the galaxy centre; V in the spectrum frame (km/s, "
                     "galaxy systemic at 0); l = s - half along the story ray (kpc, 0 at the ray midpoint)",
               ray=dict(p0=ray["p0"].round(4).tolist(), p1=ray["p1"].round(4).tolist(), n=ray["n"].round(7).tolist(),
                        L=round(ray["L"], 4), half=round(ray["half"], 4),
                        frame=dict(n=ray["n"].round(7).tolist(), up=ray["up"].round(7).tolist(),
                                   side=ray["side"].round(7).tolist())),
               enc=ENC, params=P2,
               method=dict(cite=["Lucchini et al. 2024 (TNG50 HVCs, contiguous Voronoi-neighbour cloud finding)",
                                 "Lucchini et al. 2025, ApJ 990, 118 (kinematic coherence; reported, not enforced)",
                                 "CREST component attribution (owner's M61 / COS-GASS implementation)"],
                           vortrace="evaluated, not used or vendored",
                           caveat="clouds exist only above the chosen ion density level n_iso; warm-hot (C IV, O VI) "
                                  "structures percolate at low levels and are truncated at R_max, so their extents are "
                                  "lower limits"),
               ions={})
    s_in, s_out, lc = geo["s_in"], geo["s_out"], geo["lc"]
    members_dump = {}
    for key in ions:
        fld, amu = IONS[key]
        n_ray = raw[fld]; N_i = n_ray * raw["dl"]
        b_ray = np.sqrt(2 * KB * raw["temperature"] / (amu * AMU)) / 1e5
        tau_i = cell_tau(V_ray, N_i, b_ray, key)
        comps = comps_all["components"][key]; regions = comps_all["aod"][key][1]
        phi, beta, kappa = crest(tau_i, comps, regions, key)
        Ncrest = phi.T @ N_i
        o = np.argsort(-N_i)
        k99 = int(np.searchsorted(np.cumsum(N_i[o]) / N_i.sum(), P2["col_frac"])) + 1
        n_iso = float(n_ray[o[:k99]].min()) * 10 ** (-P2["iso_dex"])
        nion = np.asarray(cells[key])[G["sel"]]
        Vl = Vcell[G["sel"]]
        b_ion = np.sqrt(2 * KB * T_all[G["sel"]] / (amu * AMU)) / 1e5
        n_iso0 = n_iso; steps = []
        for _ in range(24):
            lab, keep = fof(G, nion, Vl, b_ion, n_iso, ray_local)
            rl = lab[ray_local]
            fr = [float(N_i[rl == L].sum() / N_i.sum()) for L in keep]
            ext = [float(np.ptp(lc[rl == L])) for L in keep]
            steps.append([round(math.log10(n_iso), 3), len(keep), round(max(fr, default=0.0), 3),
                          round(max(ext, default=0.0), 1)])
            if max(fr, default=0.0) <= P2["perc_frac"] and max(ext, default=0.0) <= P2["perc_kpc"]:   # none: no cloud
                break
            n_iso *= 10 ** 0.25
        else:
            raise SystemExit(f"{key}: no non-percolating level in 24 steps")
        log(key, "iso steps", steps)

        def clouds_at(lab, keep):
            rl = lab[ray_local]
            out_c = []
            for L in keep:
                on = np.flatnonzero(rl == L)
                mem = np.flatnonzero(lab == L)
                gidx = G["sel"][mem]
                Nion_cell = np.asarray(cells[key])[gidx] * Vcm3[gidx]
                out_c.append(dict(on=on, gidx=gidx, Nion_cell=Nion_cell, Nray=float(N_i[on].sum()),
                                  M=(phi[on] * N_i[on, None]).sum(0)))
            return out_c

        allc = clouds_at(lab, keep)
        sig = [(cl["Nray"] >= P2["min_ray_frac"] * N_i.sum()) or
               (np.max(cl["M"] / np.maximum(Ncrest, 1e-300)) >= P2["min_comp_frac"]) for cl in allc]
        minor = [cl for cl, k in zip(allc, sig) if not k]
        clouds = sorted([cl for cl, k in zip(allc, sig) if k], key=lambda cl: float(s_in[cl["on"]].min()))
        M = np.array([cl["M"] for cl in clouds]) if clouds else np.zeros((0, len(comps)))
        unclouded = Ncrest - M.sum(0)
        minor_N = float(sum(cl["Nray"] for cl in minor))
        web_clouds, rep_clouds = [], []
        for si, cl in enumerate(clouds):
            gidx, Nion_cell, on = cl["gidx"], cl["Nion_cell"], cl["on"]
            pos = pos_d[gidx]
            mu, axes, evec = principal_axes(pos, Nion_cell)
            Vm = float((Vcell[gidx] * Nion_cell).sum() / Nion_cell.sum())
            Vsd = float(np.sqrt(((Vcell[gidx] - Vm) ** 2 * Nion_cell).sum() / Nion_cell.sum()))
            v3 = v3_disk[gidx]; vref = (v3 * Nion_cell[:, None]).sum(0) / Nion_cell.sum()
            coh = float(Nion_cell[np.linalg.norm(v3 - vref, axis=1) <= max(P2["dv3_frac"] * np.linalg.norm(vref),
                                                                               P2["dv3_min"])].sum() / Nion_cell.sum())
            rperp = np.linalg.norm((pos - ray["p0"]) - ((pos - ray["p0"]) @ ray["n"])[:, None] * ray["n"], axis=1)
            ow = np.argsort(rperp); cw_ = np.cumsum(Nion_cell[ow]) / Nion_cell.sum()
            rperp90 = float(rperp[ow][min(int(np.searchsorted(cw_, 0.9)), len(ow) - 1)])
            share = cl["M"] / max(cl["Nray"], 1e-300)
            cid = f"{key}_s{si}"
            members_dump[cid] = gidx
            r_cell = 0.5 * h_all[gidx]
            lo = pos.min(0); span = np.maximum(pos.max(0) - lo, 1e-6)
            rec = np.zeros(gidx.size, dtype=[("q", "<u2", 3), ("r", "u1"), ("n", "u1"), ("t", "u1"), ("dv", "i1"),
                                             ("f", "u1")])
            assert rec.dtype.itemsize == 11
            rec["q"] = np.round((pos - lo) / span * 65535).astype(np.uint16)
            rec["r"] = np.clip(np.round((np.log10(r_cell) + 2) / 3.5 * 255), 0, 255)
            rec["n"] = np.clip(np.round((np.log10(np.maximum(np.asarray(cells[key])[gidx], 1e-30)) + 16) / 16 * 255), 0, 255)
            rec["t"] = np.clip(np.round((np.log10(T_all[gidx]) - 3) / 5 * 255), 0, 255)
            rec["dv"] = np.clip(np.round((Vcell[gidx] - Vm) / 2), -127, 127)
            rec["f"] = np.isin(gidx, gidx_ray).astype(np.uint8)
            files = {}
            lcube, clo, dx = cloud_cube(pos, r_cell, Nion_cell)
            level = math.log10(n_iso)
            cq = np.clip(np.round((lcube + 16) / 16 * 255), 0, 255).astype(np.uint8)
            mesh, nv, nf = mesh_bytes(lcube, level) if gidx.size >= P2["min_cells_vol"] else (b"", 0, 0)
            for kind, b in (("pts", rec.tobytes()), ("cube", cq.tobytes() if gidx.size >= P2["min_cells_vol"] else b""),
                            ("mesh", mesh)):
                if b:
                    gz = gzip.compress(b, 9, mtime=0)
                    (odir / f"{cid}.{kind}.bin.gz").write_bytes(gz)
                    files[kind] = dict(file=f"{cid}.{kind}.bin.gz", raw=len(b), gz=len(gz))
            members = [int(i) for i in on]
            wc = dict(id=cid, n_cells=int(gidx.size), members=members, n_members=len(members),
                      l_in=round(float(s_in[on].min()), 3), l_out=round(float(s_out[on].max()), 3),
                      lc_range=[round(float(lc[on].min()), 3), round(float(lc[on].max()), 3)],
                      logN_ray=round(math.log10(max(cl["Nray"], 1e-300)), 4),
                      frac_ion_column=round(cl["Nray"] / N_i.sum(), 5),
                      centre=mu.round(3).tolist(), axes=axes.round(3).tolist(), evec=evec.round(5).tolist(),
                      r_perp_max=round(float(rperp.max()), 2), r_perp_90=round(rperp90, 2), at_R_max=bool(rperp.max() > P2["R_max"] - 2 * r_cell.max()),
                      V=round(Vm, 2), sigV=round(Vsd, 2), logT=round(float(np.median(np.log10(T_all[gidx]))), 3),
                      M_gas_Msun=sig4(mass[gidx].sum()), kin_coherent_frac=round(coh, 3),
                      comps={str(k): round(float(x), 4) for k, x in enumerate(share) if x > 0.01},
                      pts=dict(lo=lo.round(4).tolist(), span=span.round(4).tolist(), n=int(gidx.size)),
                      cube=dict(shape=list(cq.shape), lo=clo.round(4).tolist(), dx=round(dx, 5)),
                      mesh=dict(nv=nv, nf=nf, iso_log_n=round(level, 3)), files=files)
            web_clouds.append(wc)
            rep_clouds.append(dict(wc, members=None, M_comp=[sig4(x) for x in cl["M"]]))
            log(key, cid, f"cells={gidx.size} ray={len(members)} logN={wc['logN_ray']:.3f} l=[{wc['l_in']:+.2f},"
                f"{wc['l_out']:+.2f}] axes={wc['axes']} V={Vm:+.1f}±{Vsd:.1f} rperp={wc['r_perp_max']}")
        # ---------------------------------------------------------------- iso ladder (0.25 dex, +-1 dex)
        ladder, blob = [], bytearray()
        base_on = [set(cl["on"].tolist()) for cl in clouds]
        for k in range(-P2["ladder_n"], P2["ladder_n"] + 1):
            lev = n_iso * 10 ** (k * P2["ladder_dex"])
            labk, keepk = fof(G, nion, Vl, b_ion, lev, ray_local)
            ck = clouds_at(labk, keepk)
            ck = sorted([x for x in ck if x["Nray"] >= P2["min_ray_frac"] * N_i.sum()],
                        key=lambda x: float(s_in[x["on"]].min()) if x["on"].size else 0.0)
            ents = []
            for x in ck:
                par = None; best = 0.0
                for si, bo in enumerate(base_on):
                    sh = float(N_i[[i for i in x["on"] if i in bo]].sum()) if bo else 0.0
                    if sh > best:
                        best, par = sh, si
                ent = dict(members=[int(i) for i in x["on"]], logN_ray=round(math.log10(max(x["Nray"], 1e-300)), 4),
                           frac_ion_column=round(x["Nray"] / N_i.sum(), 5), n_cells=int(x["gidx"].size),
                           l_in=round(float(s_in[x["on"]].min()), 3), l_out=round(float(s_out[x["on"]].max()), 3),
                           parent=par, parent_share=round(best / max(x["Nray"], 1e-300), 4))
                if (x["Nray"] >= P2["ladder_mesh_frac"] * N_i.sum() and x["gidx"].size >= P2["min_cells_vol"]
                        and k != 0 and par is not None and best >= 0.5 * x["Nray"]):
                    pos = pos_d[x["gidx"]]
                    lcube, clo, dx = cloud_cube(pos, 0.5 * h_all[x["gidx"]], x["Nion_cell"], P2["ladder_grid"])
                    mb, nv, nf = mesh_bytes(lcube, math.log10(lev))
                    if mb:
                        ent["mesh"] = dict(offset=len(blob), nbytes=len(mb), nv=nv, nf=nf, shape=list(lcube.shape),
                                           lo=clo.round(4).tolist(), dx=round(dx, 5))
                        blob += mb
                elif k == 0 and par is not None:
                    ent["mesh"] = "chosen level: see clouds[parent]"
                ents.append(ent)
            fr = max([e["frac_ion_column"] for e in ents], default=0.0)
            ladder.append(dict(step=k, log_n_iso=round(math.log10(lev), 3), n_clouds=len(ents), max_frac=round(fr, 4),
                               clouds=ents))
        lfile = None
        if blob:
            gz = gzip.compress(bytes(blob), 9, mtime=0)
            lfile = dict(file=f"{key}_ladder.mesh.bin.gz", raw=len(blob), gz=len(gz))
            (odir / lfile["file"]).write_bytes(gz)
        crep = []
        for ci, row in enumerate(comps):
            tot = Ncrest[ci]
            if tot <= 0:
                crep.append(dict(c=ci, v=row[0], logN=row[2], b=row[4], flag=int(row[7]), logN_crest=None, clouds=[],
                                 unclouded=0.0))
                continue
            order = np.argsort(-M[:, ci]) if len(clouds) else []
            crep.append(dict(c=ci, v=row[0], logN=row[2], b=row[4], flag=int(row[7]), beta=round(float(beta[ci]), 4),
                             kappa=round(float(kappa[ci]), 4), logN_crest=round(math.log10(tot), 4),
                             clouds=[[int(j), round(float(M[j, ci] / tot), 4)] for j in order if M[j, ci] / tot > 0.01],
                             unclouded=round(float(unclouded[ci] / tot), 5)))
        ion_web = dict(logN_ray=round(math.log10(N_i.sum()), 4), n_iso_log=round(math.log10(n_iso), 3),
                       n_iso_start_log=round(math.log10(n_iso0), 3), iso_steps=steps,
                       iso_steps_cols=["log n_iso", "n structures", "max share of ray column", "max l extent kpc"],
                       frac_column_in_clouds=round(sum(cl["Nray"] for cl in clouds) / N_i.sum(), 5),
                       minor=dict(n=len(minor), logN_ray=round(math.log10(max(minor_N, 1e-300)), 3)),
                       crest_cover=round(float(Ncrest.sum() / N_i.sum()), 5),
                       M=[[sig4(x) for x in r] for r in M], M_units="cm^-2 (ray column of cloud s given to component c)",
                       N_crest=[sig4(x) for x in Ncrest], comps=crep, clouds=web_clouds,
                       ladder=dict(levels=ladder, file=lfile,
                                   note="0.25 dex steps around the chosen level; ladder clouds hold >= 1 % of the ray "
                                        "column; parent = chosen-level cloud sharing most on-ray column"))
        web["ions"][key] = ion_web
        report["ions"][key] = dict({k: v for k, v in ion_web.items() if k not in ("clouds", "ladder")},
                                   clouds=rep_clouds, ladder_summary=[[x["step"], x["log_n_iso"], x["n_clouds"],
                                                                       x["max_frac"]] for x in ladder])
    txt = json.dumps(web, separators=(",", ":"), allow_nan=False)
    (odir / "clouds.json").write_text(txt)
    np.savez_compressed(work / f"{st}_cloud_members.npz", **members_dump)     # cutout indices, for build_story_tube
    (work / f"{st}_clouds_report.json").write_text(json.dumps(report, indent=1, default=float))   # diagnostics, not shipped
    tot = sum(f.stat().st_size for f in odir.glob("*.bin.gz")) + len(gzip.compress(txt.encode(), 9))
    log(f"wrote {odir}: clouds.json {len(txt)/1024:.1f} kB raw; all assets {tot/1024:.1f} kB gz")
    return web


def sig4(x):
    return E.sig(x, 4)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--galaxy", type=int, default=E.REF_GALAXY)
    ap.add_argument("--ray", default=E.REF_RAY)
    ap.add_argument("--work", type=Path, default=None, help="dir with <gid>_<ray>_cells.npz (export_story_data cells)")
    ap.add_argument("--out", type=Path, default=E.OUT_DEFAULT / "clouds")
    ap.add_argument("--ions", nargs="+", default=["HI", "OVI"], choices=list(IONS))
    a = ap.parse_args(argv)
    work = a.work or E.work_root() / "scratch" / "story_data"
    build(a.galaxy, a.ray, work, a.out, tuple(a.ions))


if __name__ == "__main__":
    main()
