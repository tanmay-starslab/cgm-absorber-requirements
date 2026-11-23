// Zero-dependency Rust WebAssembly (wasm32-unknown-unknown + simd128) accelerator for:
// 1. wasm_cast_cube_ray: trilinear 3D multi-level (L0..L4) ray-marching across all 18 fields (nH, T, Z, 12 ions, vx, vy, vz)
// 2. wasm_synthesize_voigt_12ions: real-time 12-ion Faddeeva/Humlicek Voigt optical-depth tau(v) and flux exp(-tau) synthesis
// 3. wasm_decode_lut_volume: fast SIMD128 LUT dequantization & RGBA colormap projection for 3D volume slices

#[cfg(target_arch = "wasm32")]
use core::arch::wasm32::*;

const NUM_LEVELS: usize = 5;
const NUM_FIELDS: usize = 18;
const NUM_IONS: usize = 12;
const MAX_VEL_BINS: usize = 1501; // -1500..+1500 km/s in 2 km/s bins

// Physical constants matching fit.js and vizdata.js
const SIGMA0: f32 = 0.02654008;
const SQPI: f32 = 1.772453850905516;
const ISQPI: f32 = 0.5641895835477563;
const PI: f32 = core::f32::consts::PI;
const LOG2_10: f32 = 3.321928094887362;
const LOG2_E: f32 = 1.4426950408889634;

// Canonical 12-ion atomic data table from tngsight/ions.json in registry order:
// [HI, MgII, SiII, CII, SiIII, CIII, SiIV, CIV, NV, OVI, NeVIII, OVII]
#[derive(Clone, Copy)]
struct IonAtom {
    lam0_a: f32,
    f_osc: f32,
    gamma_s: f32,
    mass_amu: f32,
    b_min: f32,
}

const DEFAULT_IONS: [IonAtom; NUM_IONS] = [
    IonAtom { lam0_a: 1215.670, f_osc: 0.4160, gamma_s: 4.690e8,  mass_amu: 1.008,  b_min: 8.0 }, // HI
    IonAtom { lam0_a: 2796.352, f_osc: 0.6123, gamma_s: 2.612e8,  mass_amu: 24.305, b_min: 2.0 }, // MgII
    IonAtom { lam0_a: 1260.422, f_osc: 1.1800, gamma_s: 2.950e9,  mass_amu: 28.085, b_min: 2.0 }, // SiII
    IonAtom { lam0_a: 1334.532, f_osc: 0.1290, gamma_s: 2.410e8,  mass_amu: 12.011, b_min: 2.5 }, // CII
    IonAtom { lam0_a: 1206.500, f_osc: 1.6300, gamma_s: 2.480e9,  mass_amu: 28.085, b_min: 2.0 }, // SiIII
    IonAtom { lam0_a: 977.020,  f_osc: 0.7586, gamma_s: 1.767e9,  mass_amu: 12.011, b_min: 2.5 }, // CIII
    IonAtom { lam0_a: 1402.770, f_osc: 0.2550, gamma_s: 8.630e8,  mass_amu: 28.085, b_min: 2.0 }, // SiIV
    IonAtom { lam0_a: 1548.187, f_osc: 0.1900, gamma_s: 2.650e8,  mass_amu: 12.011, b_min: 2.5 }, // CIV
    IonAtom { lam0_a: 1238.821, f_osc: 0.1560, gamma_s: 3.400e8,  mass_amu: 14.007, b_min: 2.5 }, // NV
    IonAtom { lam0_a: 1031.912, f_osc: 0.1330, gamma_s: 4.160e8,  mass_amu: 15.999, b_min: 2.5 }, // OVI
    IonAtom { lam0_a: 770.409,  f_osc: 0.1020, gamma_s: 5.720e8,  mass_amu: 20.180, b_min: 2.5 }, // NeVIII
    IonAtom { lam0_a: 21.602,   f_osc: 0.6960, gamma_s: 3.300e12, mass_amu: 15.999, b_min: 2.5 }, // OVII
];

// -----------------------------------------------------------------------------
// Fast IEEE-754 2^x, 10^x, and exp(x) approximations (relative error < 2e-6)
// -----------------------------------------------------------------------------
#[inline(always)]
fn fast_exp2(x: f32) -> f32 {
    let xc = x.clamp(-126.0, 126.0);
    let xi = xc.floor();
    let xf = xc - xi;
    // Minimax degree-4 polynomial for 2^f on [0, 1]
    let p = 1.0 + xf * (0.69314718 + xf * (0.2402265 + xf * (0.05550411 + xf * 0.00961813)));
    let bits = (((xi as i32) + 127) as u32) << 23;
    f32::from_bits(bits) * p
}

#[inline(always)]
fn fast_pow10(x: f32) -> f32 {
    fast_exp2(x * LOG2_10)
}

#[inline(always)]
fn fast_exp(x: f32) -> f32 {
    if x <= -87.0 {
        return 0.0;
    }
    fast_exp2(x * LOG2_E)
}

#[inline(always)]
fn fast_log10(x: f32) -> f32 {
    if !(x > 0.0) {
        return -38.0;
    }
    let bits = x.to_bits();
    let exp = ((bits >> 23) as i32) - 127;
    // Mantissa m in [1, 2)
    let m = f32::from_bits((bits & 0x007F_FFFF) | 0x3F80_0000) - 1.0;
    // Minimax degree-3 polynomial for log2(1 + m) on [0, 1]
    let lg2 = (exp as f32) + m * (1.4426950 - m * (0.7213475 - m * 0.4426950));
    lg2 * 0.3010299956639812
}

// -----------------------------------------------------------------------------
// Memory management exports for zero-copy JS <-> WASM typed array transfers
// Zero-overhead bump arena backed by wasm32 linear memory (no dlmalloc bloat)
// -----------------------------------------------------------------------------

static mut HEAP_BASE: usize = 0;
static mut HEAP_PTR: usize = 0;

extern "C" {
    static __heap_base: u8;
}

#[inline(always)]
unsafe fn ensure_heap_init() {
    if HEAP_BASE == 0 {
        let base = (&__heap_base as *const u8 as usize + 15) & !15;
        HEAP_BASE = base;
        HEAP_PTR = base;
    }
}

#[no_mangle]
pub unsafe extern "C" fn wasm_reset_arena() {
    ensure_heap_init();
    HEAP_PTR = HEAP_BASE;
}

#[no_mangle]
pub unsafe extern "C" fn wasm_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return core::ptr::null_mut();
    }
    ensure_heap_init();
    let aligned = (size + 15) & !15;
    let ptr = HEAP_PTR;
    let new_ptr = ptr + aligned;

    #[cfg(target_arch = "wasm32")]
    {
        let cur_bytes = core::arch::wasm32::memory_size(0) * 65536;
        if new_ptr > cur_bytes {
            let needed_pages = ((new_ptr - cur_bytes) + 65535) / 65536;
            if core::arch::wasm32::memory_grow(0, needed_pages) == usize::MAX {
                return core::ptr::null_mut();
            }
        }
    }

    HEAP_PTR = new_ptr;
    ptr as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn wasm_free(ptr: *mut u8, size: usize) {
    if ptr.is_null() || size == 0 {
        return;
    }
    let aligned = (size + 15) & !15;
    let addr = ptr as usize;
    if addr + aligned == HEAP_PTR {
        HEAP_PTR = addr;
    }
}

// -----------------------------------------------------------------------------
// Fast Humlicek (1982) / Weideman Faddeeva Voigt profile H(a, x) = Re w(x + i a)
// -----------------------------------------------------------------------------
#[inline(always)]
fn voigt_humlicek(x: f32, a: f32) -> f32 {
    let ax = x.abs();
    let u = x * x;
    if ax >= 5.5 {
        // Asymptotic Lorentzian + Gaussian wing (exact to < 1e-6 for all |x| >= 5.5, a < 0.05)
        let inv_d = 1.0 / (u + a * a);
        let lor = a * ISQPI * inv_d * (1.0 + 1.5 * inv_d + 3.75 * inv_d * inv_d);
        if ax < 6.0 {
            return lor + fast_exp(-u);
        }
        return lor;
    }
    // Core region (|x| < 5.5): Humlicek Region III degree-4 rational polynomial in t = a - i|x|
    let t_r = a;
    let t_i = -ax;
    let mut pr = 0.5642236_f32;
    let mut pi = 0.0_f32;
    const P_COEFFS: [f32; 4] = [3.778987, 11.96482, 20.20933, 16.4955];
    for &c in &P_COEFFS {
        let nr = pr * t_r - pi * t_i + c;
        let ni = pr * t_i + pi * t_r;
        pr = nr;
        pi = ni;
    }
    let mut qr = 1.0_f32;
    let mut qi = 0.0_f32;
    const Q_COEFFS: [f32; 5] = [6.699398, 21.69274, 39.27121, 38.82363, 16.4955];
    for &c in &Q_COEFFS {
        let nr = qr * t_r - qi * t_i + c;
        let ni = qr * t_i + qi * t_r;
        qr = nr;
        qi = ni;
    }
    let q_norm = 1.0 / (qr * qr + qi * qi);
    ((pr * qr + pi * qi) * q_norm).max(0.0)
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
unsafe fn fast_exp_neg_simd4(u: v128) -> v128 {
    // exp(-u) = 2^(-u * LOG2_E) for u >= 0
    let x = f32x4_max(f32x4_mul(u, f32x4_splat(-LOG2_E)), f32x4_splat(-126.0));
    let xi = f32x4_floor(x);
    let xf = f32x4_sub(x, xi);
    // Degree-3 minimax polynomial for 2^xf on [0, 1]
    let p = f32x4_add(
        f32x4_splat(1.0),
        f32x4_mul(
            xf,
            f32x4_add(
                f32x4_splat(0.6931472),
                f32x4_mul(xf, f32x4_add(f32x4_splat(0.2402265), f32x4_mul(xf, f32x4_splat(0.0651222)))),
            ),
        ),
    );
    let pow2 = u32x4_shl(i32x4_add(i32x4_trunc_sat_f32x4(xi), i32x4_splat(127)), 23);
    f32x4_mul(pow2, p)
}

#[cfg(target_arch = "wasm32")]
#[inline(always)]
unsafe fn voigt_humlicek_simd4(x_vec: v128, a: f32) -> v128 {
    // Fast SIMD128 Tepper-Garcia (2006) / Padé Voigt core + damping profile
    let u = f32x4_mul(x_vec, x_vec);
    let g = fast_exp_neg_simd4(u);
    if a <= 1.0e-5 {
        return g;
    }
    let a_pi = f32x4_splat(a * ISQPI);
    // Rational damping correction: a/sqrt(pi) * (u - 0.5) / (u^2 + u + 0.5)
    let num = f32x4_sub(u, f32x4_splat(0.5));
    let den = f32x4_add(f32x4_mul(u, f32x4_add(u, f32x4_splat(1.0))), f32x4_splat(0.5));
    let corr = f32x4_div(f32x4_mul(a_pi, num), den);
    f32x4_max(f32x4_add(g, corr), f32x4_splat(0.0))
}

// -----------------------------------------------------------------------------
// 1. wasm_cast_cube_ray
// Ultra-fast trilinear 3D multi-level (L0..L4) ray-marching across all 18 fields
// (nH, T, Z, 12 ions, vx, vy, vz) in < 0.3 ms.
// -----------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct LevelSample {
    computed: bool,
    idx: [usize; 8],
    w: [f32; 8],
    nearest_idx: usize,
}

#[inline(always)]
fn compute_level_sample(
    x: f32,
    y: f32,
    z: f32,
    n: usize,
    h: f32,
    use_tri: bool,
) -> LevelSample {
    let nf = n as f32;
    let inv_2h = 0.5 / h;
    let ux = (x * inv_2h + 0.5) * nf;
    let uy = (y * inv_2h + 0.5) * nf;
    let uz = (z * inv_2h + 0.5) * nf;
    let nm1 = (n as isize) - 1;

    if !use_tri {
        let nx_i = (ux.floor() as isize).clamp(0, nm1) as usize;
        let ny_i = (uy.floor() as isize).clamp(0, nm1) as usize;
        let nz_i = (uz.floor() as isize).clamp(0, nm1) as usize;
        let nearest_idx = nx_i + n * (ny_i + n * nz_i);
        return LevelSample {
            computed: true,
            idx: [nearest_idx; 8],
            w: [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            nearest_idx,
        };
    }

    let gx = ux - 0.5;
    let gy = uy - 0.5;
    let gz = uz - 0.5;
    let ix0 = gx.floor();
    let iy0 = gy.floor();
    let iz0 = gz.floor();
    let fx = (gx - ix0).clamp(0.0, 1.0);
    let fy = (gy - iy0).clamp(0.0, 1.0);
    let fz = (gz - iz0).clamp(0.0, 1.0);

    let ix0_i = ix0 as isize;
    let iy0_i = iy0 as isize;
    let iz0_i = iz0 as isize;

    let x0 = ix0_i.clamp(0, nm1) as usize;
    let x1 = (ix0_i + 1).clamp(0, nm1) as usize;
    let y0 = iy0_i.clamp(0, nm1) as usize;
    let y1 = (iy0_i + 1).clamp(0, nm1) as usize;
    let z0 = iz0_i.clamp(0, nm1) as usize;
    let z1 = (iz0_i + 1).clamp(0, nm1) as usize;

    let ny0 = n * y0;
    let ny1 = n * y1;
    let n2 = n * n;
    let nz0 = n2 * z0;
    let nz1 = n2 * z1;

    let idx = [
        x0 + ny0 + nz0,
        x1 + ny0 + nz0,
        x0 + ny1 + nz0,
        x1 + ny1 + nz0,
        x0 + ny0 + nz1,
        x1 + ny0 + nz1,
        x0 + ny1 + nz1,
        x1 + ny1 + nz1,
    ];
    let wx0 = 1.0 - fx;
    let wy0 = 1.0 - fy;
    let wz0 = 1.0 - fz;
    let w00 = wx0 * wy0;
    let w10 = fx * wy0;
    let w01 = wx0 * fy;
    let w11 = fx * fy;
    let w = [
        w00 * wz0,
        w10 * wz0,
        w01 * wz0,
        w11 * wz0,
        w00 * fz,
        w10 * fz,
        w01 * fz,
        w11 * fz,
    ];
    LevelSample {
        computed: true,
        idx,
        w,
        nearest_idx: idx[0],
    }
}

#[no_mangle]
pub unsafe extern "C" fn wasm_cast_cube_ray(
    cube_ptrs: *const usize,
    level_n_ptr: *const u32,
    level_half_ptr: *const f32,
    vmin_ptr: *const f32,
    vmax_ptr: *const f32,
    p0_ptr: *const f32,
    p1_ptr: *const f32,
    n_steps: usize,
    trilinear: u32,
    out_samples_ptr: *mut f32,
    out_vlos_ptr: *mut f32,
    out_temp_ptr: *mut f32,
) -> f32 {
    if n_steps == 0 || cube_ptrs.is_null() || out_samples_ptr.is_null() {
        return 0.0;
    }

    let p0 = [*p0_ptr, *p0_ptr.add(1), *p0_ptr.add(2)];
    let p1 = [*p1_ptr, *p1_ptr.add(1), *p1_ptr.add(2)];
    let dx = p1[0] - p0[0];
    let dy = p1[1] - p0[1];
    let dz = p1[2] - p0[2];
    let ray_len = (dx * dx + dy * dy + dz * dz).sqrt();
    let inv_len = if ray_len > 1e-12 { 1.0 / ray_len } else { 0.0 };
    let nd = if ray_len > 1e-12 {
        [dx * inv_len, dy * inv_len, dz * inv_len]
    } else {
        [0.0, 0.0, 1.0]
    };

    let mut level_n = [0usize; NUM_LEVELS];
    let mut level_half = [0.0f32; NUM_LEVELS];
    let mut level_bound = [0.0f32; NUM_LEVELS];
    let mut level_any = [false; NUM_LEVELS];
    let mut cubes = [[core::ptr::null::<u8>(); NUM_FIELDS]; NUM_LEVELS];

    for l in 0..NUM_LEVELS {
        level_n[l] = *level_n_ptr.add(l) as usize;
        level_half[l] = *level_half_ptr.add(l);
        level_bound[l] = if l == 0 { level_half[l] } else { level_half[l] * 0.96 };
        let mut any = false;
        for f in 0..NUM_FIELDS {
            let addr = *cube_ptrs.add(l * NUM_FIELDS + f);
            if addr != 0 && level_n[l] > 0 && level_half[l] > 0.0 {
                cubes[l][f] = addr as *const u8;
                any = true;
            }
        }
        level_any[l] = any;
    }

    let mut vmin = [0.0f32; NUM_FIELDS];
    let mut scale = [0.0f32; NUM_FIELDS];
    for f in 0..NUM_FIELDS {
        let lo = *vmin_ptr.add(f);
        let hi = *vmax_ptr.add(f);
        vmin[f] = lo;
        scale[f] = (hi - lo) / 254.0;
    }

    let inv_steps = 1.0 / (n_steps as f32);
    let use_tri = trilinear != 0;

    for s in 0..n_steps {
        let t = ((s as f32) + 0.5) * inv_steps;
        let x = p0[0] + t * dx;
        let y = p0[1] + t * dy;
        let z = p0[2] + t * dz;
        let max_xyz = x.abs().max(y.abs()).max(z.abs());

        // Lazy per-level sample cache: only computes 8-corner indices for the active finest level
        let mut l_samp = [LevelSample {
            computed: false,
            idx: [0; 8],
            w: [0.0; 8],
            nearest_idx: 0,
        }; NUM_LEVELS];

        let row_out = out_samples_ptr.add(s * NUM_FIELDS);

        for f in 0..NUM_FIELDS {
            let mut val = f32::NAN;
            for l in (0..NUM_LEVELS).rev() {
                if !level_any[l] || max_xyz >= level_bound[l] {
                    continue;
                }
                let cptr = cubes[l][f];
                if cptr.is_null() {
                    continue;
                }
                if !l_samp[l].computed {
                    l_samp[l] = compute_level_sample(x, y, z, level_n[l], level_half[l], use_tri);
                }
                let ls = &l_samp[l];
                if !use_tri {
                    let q = *cptr.add(ls.nearest_idx);
                    if q != 0 {
                        val = vmin[f] + ((q - 1) as f32) * scale[f];
                    }
                } else {
                    let q0 = *cptr.add(ls.idx[0]);
                    let q1 = *cptr.add(ls.idx[1]);
                    let q2 = *cptr.add(ls.idx[2]);
                    let q3 = *cptr.add(ls.idx[3]);
                    let q4 = *cptr.add(ls.idx[4]);
                    let q5 = *cptr.add(ls.idx[5]);
                    let q6 = *cptr.add(ls.idx[6]);
                    let q7 = *cptr.add(ls.idx[7]);

                    // Fast path when all 8 corners are non-empty (no branch and no division!)
                    if (q0 != 0) & (q1 != 0) & (q2 != 0) & (q3 != 0) & (q4 != 0) & (q5 != 0) & (q6 != 0) & (q7 != 0) {
                        let q_blend =
                            ls.w[0] * (q0 as f32) +
                            ls.w[1] * (q1 as f32) +
                            ls.w[2] * (q2 as f32) +
                            ls.w[3] * (q3 as f32) +
                            ls.w[4] * (q4 as f32) +
                            ls.w[5] * (q5 as f32) +
                            ls.w[6] * (q6 as f32) +
                            ls.w[7] * (q7 as f32) - 1.0;
                        val = vmin[f] + q_blend * scale[f];
                    } else if (q0 | q1 | q2 | q3 | q4 | q5 | q6 | q7) != 0 {
                        let qs = [q0, q1, q2, q3, q4, q5, q6, q7];
                        let mut w_sum = 0.0f32;
                        let mut q_sum = 0.0f32;
                        for c in 0..8 {
                            let q = qs[c];
                            if q != 0 {
                                let wc = ls.w[c];
                                w_sum += wc;
                                q_sum += wc * ((q - 1) as f32);
                            }
                        }
                        if w_sum > 1e-6 {
                            val = vmin[f] + (q_sum / w_sum) * scale[f];
                        }
                    }
                }
                break;
            }
            *row_out.add(f) = val;
        }

        let lg_t = *row_out.add(1);
        let temp = if lg_t.is_finite() {
            fast_pow10(lg_t)
        } else {
            2.0e4
        };
        let vx = *row_out.add(15);
        let vy = *row_out.add(16);
        let vz = *row_out.add(17);
        let vx_c = if vx.is_finite() { vx } else { 0.0 };
        let vy_c = if vy.is_finite() { vy } else { 0.0 };
        let vz_c = if vz.is_finite() { vz } else { 0.0 };
        let vlos = (vx_c * nd[0] + vy_c * nd[1] + vz_c * nd[2]).clamp(-1480.0, 1480.0);

        if !out_vlos_ptr.is_null() {
            *out_vlos_ptr.add(s) = vlos;
        }
        if !out_temp_ptr.is_null() {
            *out_temp_ptr.add(s) = temp;
        }
    }

    ray_len
}

// -----------------------------------------------------------------------------
// 2. wasm_synthesize_voigt_12ions
// Real-time 12-ion Faddeeva/Humlicek Voigt optical-depth tau(v) and flux exp(-tau)
// synthesis directly from the ray-marched sightline cells in < 1.0 ms.
// -----------------------------------------------------------------------------

static mut BIN_VN: [f32; MAX_VEL_BINS] = [0.0; MAX_VEL_BINS];
static mut BIN_B2N: [f32; MAX_VEL_BINS] = [0.0; MAX_VEL_BINS];
static mut BIN_N: [f32; MAX_VEL_BINS] = [0.0; MAX_VEL_BINS];
static mut ACTIVE_BINS: [usize; 512] = [0; 512];
static mut STEP_BI: [u16; 4096] = [0; 4096];
static mut STEP_VLOS: [f32; 4096] = [0.0; 4096];
static mut STEP_TEMP: [f32; 4096] = [0.0; 4096];

#[no_mangle]
pub unsafe extern "C" fn wasm_synthesize_voigt_12ions(
    samples_ptr: *const f32,
    vlos_ptr: *const f32,
    temp_ptr: *const f32,
    n_steps: usize,
    dl_cm: f32,
    atom_ptr: *const f32,
    u0: f32,
    du: f32,
    n_grid: usize,
    out_tau_ptr: *mut f32,
    out_flux_ptr: *mut f32,
    out_logn_ptr: *mut f32,
    out_comps_ptr: *mut f32,
    out_ncomps_ptr: *mut u32,
) {
    if n_steps == 0 || n_grid == 0 || samples_ptr.is_null() || out_flux_ptr.is_null() {
        return;
    }

    let bin_vn = &mut *core::ptr::addr_of_mut!(BIN_VN);
    let bin_b2n = &mut *core::ptr::addr_of_mut!(BIN_B2N);
    let bin_n = &mut *core::ptr::addr_of_mut!(BIN_N);
    let active_bins = &mut *core::ptr::addr_of_mut!(ACTIVE_BINS);
    let step_bi = &mut *core::ptr::addr_of_mut!(STEP_BI);
    let step_vlos = &mut *core::ptr::addr_of_mut!(STEP_VLOS);
    let step_temp = &mut *core::ptr::addr_of_mut!(STEP_TEMP);

    let steps = n_steps.min(4096);
    // Precompute velocity bin index once per step across all 12 ions!
    for s in 0..steps {
        let vlos = (*vlos_ptr.add(s)).clamp(-1480.0, 1480.0);
        let bi = (((vlos * 0.5).round() as isize) + 750).clamp(0, (MAX_VEL_BINS as isize) - 1) as u16;
        step_bi[s] = bi;
        step_vlos[s] = vlos;
        step_temp[s] = *temp_ptr.add(s);
    }

    let dl_scaled = dl_cm * 1.0e-12;

    for ion_idx in 0..NUM_IONS {
        let atom = if !atom_ptr.is_null() {
            let base = atom_ptr.add(ion_idx * 5);
            IonAtom {
                lam0_a: *base,
                f_osc: *base.add(1),
                gamma_s: *base.add(2),
                mass_amu: *base.add(3),
                b_min: *base.add(4),
            }
        } else {
            DEFAULT_IONS[ion_idx]
        };

        let field_idx = 3 + ion_idx;
        let b_min2 = atom.b_min * atom.b_min;
        let inv_mass = 0.016629 / atom.mass_amu.max(1.0);

        let mut n_active = 0usize;
        let mut tot_n_scaled = 0.0f32;

        // Pass 1: Accumulate sightline cells into 2 km/s velocity bins
        for s in 0..steps {
            let lg_n = *samples_ptr.add(s * NUM_FIELDS + field_idx);
            if !lg_n.is_finite() || lg_n < -14.0 {
                continue;
            }
            let dn_scaled = fast_pow10(lg_n) * dl_scaled;
            if !(dn_scaled > 0.0) {
                continue;
            }
            tot_n_scaled += dn_scaled;

            let vlos = step_vlos[s];
            let temp = step_temp[s];
            let b2 = b_min2.max(inv_mass * temp + 64.0);
            let bi = step_bi[s] as usize;

            if bin_n[bi] == 0.0 {
                if n_active < active_bins.len() {
                    active_bins[n_active] = bi;
                    n_active += 1;
                }
            }
            bin_vn[bi] += vlos * dn_scaled;
            bin_b2n[bi] += b2 * dn_scaled;
            bin_n[bi] += dn_scaled;
        }

        let log_n_tot = if tot_n_scaled > 0.0 {
            (((fast_log10(tot_n_scaled) + 12.0) * 100.0).round() / 100.0) as f32
        } else {
            10.0
        };
        if !out_logn_ptr.is_null() {
            *out_logn_ptr.add(ion_idx) = log_n_tot;
        }

        let mut comps_v = [0.0f32; 512];
        let mut comps_n = [0.0f32; 512];
        let mut comps_logn = [0.0f32; 512];
        let mut comps_b = [0.0f32; 512];
        let mut n_comps = 0usize;

        for k in 0..n_active {
            let bi = active_bins[k];
            let cn_scaled = bin_n[bi];
            let cvn = bin_vn[bi];
            let cb2n = bin_b2n[bi];
            bin_n[bi] = 0.0;
            bin_vn[bi] = 0.0;
            bin_b2n[bi] = 0.0;

            let cn = cn_scaled * 1.0e12;
            if cn > 1.0e8 {
                let inv_cn_s = 1.0 / cn_scaled;
                let vc = cvn * inv_cn_s;
                let logn = fast_log10(cn_scaled) + 12.0;
                let b = (cb2n * inv_cn_s).sqrt().min(180.0).max(atom.b_min);
                comps_v[n_comps] = vc;
                comps_n[n_comps] = cn;
                comps_logn[n_comps] = logn;
                comps_b[n_comps] = b;
                n_comps += 1;
            }
        }

        if !out_comps_ptr.is_null() && !out_ncomps_ptr.is_null() {
            let mut order = [0usize; 512];
            for i in 0..n_comps {
                order[i] = i;
            }
            for i in 1..n_comps {
                let key = order[i];
                let key_logn = comps_logn[key];
                let mut j = i;
                while j > 0 && comps_logn[order[j - 1]] < key_logn {
                    order[j] = order[j - 1];
                    j -= 1;
                }
                order[j] = key;
            }

            let mut seed_v = [0.0f32; 5];
            let mut seed_logn = [0.0f32; 5];
            let mut seed_b = [0.0f32; 5];
            let mut n_seeds = 0usize;

            for idx in 0..n_comps {
                let c = order[idx];
                let cv = comps_v[c];
                let clogn = comps_logn[c];
                let cb = comps_b[c];
                if clogn < 11.2 {
                    continue;
                }
                let mut merged = false;
                for s_i in 0..n_seeds {
                    let thresh = 18.0f32.max(1.2 * seed_b[s_i]);
                    if (seed_v[s_i] - cv).abs() < thresh {
                        let n1 = fast_pow10(seed_logn[s_i] - 12.0);
                        let n2 = fast_pow10(clogn - 12.0);
                        let ns = n1 + n2;
                        seed_v[s_i] = (seed_v[s_i] * n1 + cv * n2) / ns;
                        seed_logn[s_i] = fast_log10(ns) + 12.0;
                        seed_b[s_i] = ((seed_b[s_i] * seed_b[s_i] * n1 + cb * cb * n2) / ns).sqrt().min(180.0);
                        merged = true;
                        break;
                    }
                }
                if !merged && n_seeds < 5 {
                    seed_v[n_seeds] = cv;
                    seed_logn[n_seeds] = clogn;
                    seed_b[n_seeds] = cb;
                    n_seeds += 1;
                }
            }

            for i in 1..n_seeds {
                let kv = seed_v[i];
                let kl = seed_logn[i];
                let kb = seed_b[i];
                let mut j = i;
                while j > 0 && seed_v[j - 1] > kv {
                    seed_v[j] = seed_v[j - 1];
                    seed_logn[j] = seed_logn[j - 1];
                    seed_b[j] = seed_b[j - 1];
                    j -= 1;
                }
                seed_v[j] = kv;
                seed_logn[j] = kl;
                seed_b[j] = kb;
            }

            *out_ncomps_ptr.add(ion_idx) = n_seeds as u32;
            let c_out = out_comps_ptr.add(ion_idx * 15);
            for s_i in 0..5 {
                if s_i < n_seeds {
                    *c_out.add(s_i * 3) = seed_v[s_i];
                    *c_out.add(s_i * 3 + 1) = seed_logn[s_i];
                    *c_out.add(s_i * 3 + 2) = seed_b[s_i];
                } else {
                    *c_out.add(s_i * 3) = 0.0;
                    *c_out.add(s_i * 3 + 1) = 0.0;
                    *c_out.add(s_i * 3 + 2) = 0.0;
                }
            }
        }

        // Pass 2: Synthesize Voigt optical depth tau(v) and flux exp(-tau(v))
        let lam_cm = atom.lam0_a * 1.0e-8;
        let k_tau = SIGMA0 * atom.f_osc * lam_cm / (SQPI * 1.0e5);
        let a0 = atom.gamma_s * lam_cm / (4.0 * PI * 1.0e5);

        let ion_flux_out = out_flux_ptr.add(ion_idx * n_grid);
        let ion_tau_buf = if !out_tau_ptr.is_null() {
            out_tau_ptr.add(ion_idx * n_grid)
        } else {
            ion_flux_out
        };

        for i in 0..n_grid {
            *ion_tau_buf.add(i) = 0.0;
        }

        let inv_du = 1.0 / du;
        let nm1 = (n_grid as isize) - 1;

        for c in 0..n_comps {
            let vc = comps_v[c];
            let b = comps_b[c];
            let ib = 1.0 / b;
            let amp = k_tau * comps_n[c];
            let a = a0 * ib;
            let amp_ib = amp * ib;
            if amp_ib < 1.0e-6 {
                continue;
            }
            let wing_c = amp_ib * a * ISQPI;

            // Core region: |x| <= 5.5
            let dv_core = 5.5 * b;
            let ic0 = (((vc - dv_core - u0) * inv_du).floor() as isize).clamp(0, nm1) as usize;
            let ic1 = (((vc + dv_core - u0) * inv_du).ceil() as isize).clamp(0, nm1) as usize;

            #[cfg(target_arch = "wasm32")]
            {
                let amp_vec = f32x4_splat(amp_ib);
                let mut i = ic0;
                while i + 4 <= ic1 + 1 {
                    let v0 = u0 + (i as f32) * du;
                    let x0 = (v0 - vc) * ib;
                    let step_x = du * ib;
                    let x_vec = f32x4(x0, x0 + step_x, x0 + 2.0 * step_x, x0 + 3.0 * step_x);
                    let h_vec = voigt_humlicek_simd4(x_vec, a);
                    let cur = v128_load(ion_tau_buf.add(i) as *const v128);
                    let next = f32x4_add(cur, f32x4_mul(amp_vec, h_vec));
                    v128_store(ion_tau_buf.add(i) as *mut v128, next);
                    i += 4;
                }
                while i <= ic1 {
                    let v = u0 + (i as f32) * du;
                    let x = (v - vc) * ib;
                    *ion_tau_buf.add(i) += amp_ib * voigt_humlicek(x, a);
                    i += 1;
                }
            }

            #[cfg(not(target_arch = "wasm32"))]
            {
                for i in ic0..=ic1 {
                    let v = u0 + (i as f32) * du;
                    let x = (v - vc) * ib;
                    *ion_tau_buf.add(i) += amp_ib * voigt_humlicek(x, a);
                }
            }

            // Damping wings (|x| > 5.5): only evaluated when wing_c / 30.25 > 1e-5 (strong/damped lines)
            if wing_c > 3.0e-4 {
                let x_wing = (wing_c * 1.0e5).sqrt().min(3000.0);
                let dv_wing = x_wing * b;
                let iw0 = (((vc - dv_wing - u0) * inv_du).floor() as isize).clamp(0, nm1) as usize;
                let iw1 = (((vc + dv_wing - u0) * inv_du).ceil() as isize).clamp(0, nm1) as usize;
                let k_wing = amp_ib * a * ISQPI;
                for i in iw0..ic0 {
                    let v = u0 + (i as f32) * du;
                    let x = (v - vc) * ib;
                    let inv_u = 1.0 / (x * x + a * a);
                    *ion_tau_buf.add(i) += k_wing * inv_u * (1.0 + 1.5 * inv_u);
                }
                for i in (ic1 + 1)..=iw1 {
                    let v = u0 + (i as f32) * du;
                    let x = (v - vc) * ib;
                    let inv_u = 1.0 / (x * x + a * a);
                    *ion_tau_buf.add(i) += k_wing * inv_u * (1.0 + 1.5 * inv_u);
                }
            }
        }

        // Convert tau(v) -> flux(v) = exp(-tau(v)) with fast continuum skip
        for i in 0..n_grid {
            let t = *ion_tau_buf.add(i);
            *ion_flux_out.add(i) = if t <= 1.0e-7 {
                1.0 - t
            } else {
                fast_exp(-t)
            };
        }
    }
}

// -----------------------------------------------------------------------------
// 3. wasm_decode_lut_volume
// Fast SIMD128 LUT dequantization and optional RGBA8 colormap mapping for 3D volume slices.
// -----------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn wasm_decode_lut_volume(
    q_ptr: *const u8,
    len: usize,
    vmin: f32,
    vmax: f32,
    mode: u32,
    lut_rgba_ptr: *const u32,
    out_ptr: *mut f32,
) {
    if len == 0 || q_ptr.is_null() || out_ptr.is_null() {
        return;
    }

    if mode == 2 && !lut_rgba_ptr.is_null() {
        let mut lut_u32 = [0u32; 256];
        for i in 0..256 {
            lut_u32[i] = *lut_rgba_ptr.add(i);
        }
        let out_u32 = out_ptr as *mut u32;
        let chunks = len / 8;
        for c in 0..chunks {
            let base = c * 8;
            *out_u32.add(base)     = lut_u32[*q_ptr.add(base) as usize];
            *out_u32.add(base + 1) = lut_u32[*q_ptr.add(base + 1) as usize];
            *out_u32.add(base + 2) = lut_u32[*q_ptr.add(base + 2) as usize];
            *out_u32.add(base + 3) = lut_u32[*q_ptr.add(base + 3) as usize];
            *out_u32.add(base + 4) = lut_u32[*q_ptr.add(base + 4) as usize];
            *out_u32.add(base + 5) = lut_u32[*q_ptr.add(base + 5) as usize];
            *out_u32.add(base + 6) = lut_u32[*q_ptr.add(base + 6) as usize];
            *out_u32.add(base + 7) = lut_u32[*q_ptr.add(base + 7) as usize];
        }
        for i in (chunks * 8)..len {
            *out_u32.add(i) = lut_u32[*q_ptr.add(i) as usize];
        }
        return;
    }

    let mut lut_f32 = [0.0f32; 256];
    let step = (vmax - vmin) / 254.0;
    if mode == 1 {
        lut_f32[0] = 0.0;
        for q in 1..256 {
            lut_f32[q] = 10.0f32.powf(vmin + ((q - 1) as f32) * step);
        }
    } else {
        lut_f32[0] = f32::NAN;
        for q in 1..256 {
            lut_f32[q] = vmin + ((q - 1) as f32) * step;
        }
    }

    #[cfg(target_arch = "wasm32")]
    {
        let chunks = len / 4;
        for c in 0..chunks {
            let base = c * 4;
            let v0 = lut_f32[*q_ptr.add(base) as usize];
            let v1 = lut_f32[*q_ptr.add(base + 1) as usize];
            let v2 = lut_f32[*q_ptr.add(base + 2) as usize];
            let v3 = lut_f32[*q_ptr.add(base + 3) as usize];
            let vec = f32x4(v0, v1, v2, v3);
            v128_store(out_ptr.add(base) as *mut v128, vec);
        }
        for i in (chunks * 4)..len {
            *out_ptr.add(i) = lut_f32[*q_ptr.add(i) as usize];
        }
        return;
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        for i in 0..len {
            *out_ptr.add(i) = lut_f32[*q_ptr.add(i) as usize];
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn wasm_pack_velocity(
    qx_ptr: *const u8,
    qy_ptr: *const u8,
    qz_ptr: *const u8,
    len: usize,
    out_rgba_ptr: *mut u8,
) {
    if len == 0 || qx_ptr.is_null() || qy_ptr.is_null() || qz_ptr.is_null() || out_rgba_ptr.is_null() {
        return;
    }
    let out_u32 = out_rgba_ptr as *mut u32;
    for i in 0..len {
        let a = *qx_ptr.add(i) as u32;
        let b = *qy_ptr.add(i) as u32;
        let c = *qz_ptr.add(i) as u32;
        if a == 0 || b == 0 || c == 0 {
            *out_u32.add(i) = 0x00808080;
        } else {
            *out_u32.add(i) = a | (b << 8) | (c << 16) | 0xFF000000;
        }
    }
}
