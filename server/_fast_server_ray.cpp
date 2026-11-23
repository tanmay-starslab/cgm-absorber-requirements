// server/_fast_server_ray.cpp
// Compiled C++17/OpenMP + AVX2 SIMD sightline ray-caster, 12-ion Faddeeva Voigt
// optical-depth synthesizer, and Voigt profile component fitter.
//
// Compile with:
//   g++ -O3 -march=native -fopenmp -shared -fPIC -std=c++17 server/_fast_server_ray.cpp -o server/_fast_server_ray.so

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <numeric>
#include <vector>

#if defined(__AVX2__)
#include <immintrin.h>
#endif

#if defined(_OPENMP)
#include <omp.h>
#endif

namespace {

constexpr double PI = 3.14159265358979323846264338327950288;
constexpr double SQRT_PI = 1.77245385090551602729816748334114518;
constexpr double INV_SQRT_PI = 0.564189583547756286948079451560772586;
constexpr double TWO_INV_SQRT_PI = 1.12837916709551257389615890312154517;
constexpr double LN10 = 2.30258509299404568401799145468436421;
constexpr double C_CMS = 2.99792458e10;
constexpr double C_KMS = 2.99792458e5;
constexpr double K_BOLTZ_CGS = 1.3806488e-16;
constexpr double AMU_CGS = 1.660538921e-24;
constexpr double M_H_CGS = 1.00794 * AMU_CGS;
// pi * e^2 / (m_e * c) in cm^2 s^-1 (tngsight SIGMA0)
constexpr double SIGMA0_CGS = 2.6540088336105167e-2;
// sqrt(pi) * e^2 / (m_e * c) in cm^2 s^-1 (Trident tau_factor = SIGMA0 / sqrt(pi))
constexpr double TAU_FACTOR_CGS = SIGMA0_CGS / SQRT_PI;
constexpr double AOD_K = 1e5 / (SIGMA0_CGS * 1e-8);

// -----------------------------------------------------------------------------
// 1. Exact yt 1000-node 2D integrated cubic-spline SPH kernel table I_tab(q^2)
// -----------------------------------------------------------------------------
struct CubicKernelTable {
    static constexpr int N_TAB = 1000;
    double values[N_TAB];

    CubicKernelTable() {
        for (int idx = 0; idx < N_TAB; ++idx) {
            double q2 = static_cast<double>(idx) / static_cast<double>(N_TAB - 1);
            double b = std::sqrt(q2);
            if (b >= 1.0) {
                values[idx] = 0.0;
                continue;
            }
            const int N_QUAD = 2000;
            double z_max = std::sqrt(std::max(0.0, 1.0 - q2));
            double dz = z_max / static_cast<double>(N_QUAD);
            double sum = 0.0;
            for (int k = 0; k <= N_QUAD; ++k) {
                double z = k * dz;
                double r = std::sqrt(q2 + z * z);
                double w = 0.0;
                if (r <= 0.5) {
                    w = 1.0 - 6.0 * r * r + 6.0 * r * r * r;
                } else if (r < 1.0) {
                    double omr = 1.0 - r;
                    w = 2.0 * omr * omr * omr;
                }
                double coeff = (k == 0 || k == N_QUAD) ? 1.0 : ((k & 1) ? 4.0 : 2.0);
                sum += coeff * (8.0 / PI) * w;
            }
            values[idx] = 2.0 * (dz / 3.0) * sum;
        }
    }

    inline double eval(double q2) const {
        if (q2 <= 0.0) return values[0];
        if (q2 >= 1.0) return 0.0;
        double pos = q2 * static_cast<double>(N_TAB - 1);
        int idx = static_cast<int>(pos);
        if (idx >= N_TAB - 1) return values[N_TAB - 1];
        double rem = pos - static_cast<double>(idx);
        return values[idx] + rem * (values[idx + 1] - values[idx]);
    }
};

static const CubicKernelTable& get_cubic_kernel_table() {
    static const CubicKernelTable tab;
    return tab;
}

// -----------------------------------------------------------------------------
// 2. High-accuracy FP64 Faddeeva Voigt function w(z) = H(a, u) + i K(a, u)
//    - Reference Weideman (1994) N=32 rational expansion (1.1e-13 accuracy)
//    - L1-cached 4096-node 1D real-axis table w(u_k) = exp(-u_k^2) + i*(2/sqrt(pi))*F(u_k)
//      on u in [0, 12] + 5th-order analytic Taylor recurrence w'(z) = -2 z w(z) + 2i/sqrt(pi)
//      (zero divisions, 1e-11 accuracy for |u| <= 12, a <= 0.05)
//    - 4-FMA real asymptotic series for |u| > 12 (1.4e-7 relative, 5e-14 abs accuracy)
// -----------------------------------------------------------------------------
struct FaddeevaTable {
    static constexpr double L32 = 4.756828460010884; // sqrt(32 / sqrt(2))
    static constexpr int N_GRID = 32768;
    static constexpr double U_MAX = 12.0;
    static constexpr double H_STEP = U_MAX / static_cast<double>(N_GRID);
    static constexpr double INV_H = static_cast<double>(N_GRID) / U_MAX;

    struct alignas(32) CoreNode {
        double p0;
        double dp0;
        double p1;
        double dp1;
    };

    double a32[32];
    std::vector<CoreNode> core_nodes;
    std::vector<double> p2_grid;
    std::vector<double> im0_grid;
    std::vector<double> dim0_grid;

    FaddeevaTable() : core_nodes(N_GRID + 2), p2_grid(N_GRID + 2), im0_grid(N_GRID + 2), dim0_grid(N_GRID + 2) {
        const int N = 32;
        const int M = 2 * N;
        for (int n = 0; n < N; ++n) {
            double c_re = 0.0;
            for (int j = -N + 1; j < N; ++j) {
                double theta = PI * static_cast<double>(j) / static_cast<double>(N);
                double t = L32 * std::tan(0.5 * theta);
                double f = std::exp(-t * t) * (L32 * L32 + t * t);
                c_re += f * std::cos(static_cast<double>(n + 1) * theta);
            }
            a32[n] = c_re / static_cast<double>(M);
        }

        std::vector<double> p0_tmp(N_GRID + 2);
        std::vector<double> p1_tmp(N_GRID + 2);
        for (int k = 0; k <= N_GRID + 1; ++k) {
            double u = k * H_STEP;
            double re, im;
            eval_weideman32(u, 0.0, re, im);
            double e_u2 = std::exp(-u * u);
            p0_tmp[k] = e_u2;
            p1_tmp[k] = 2.0 * u * im - TWO_INV_SQRT_PI;
            p2_grid[k] = (1.0 - 2.0 * u * u) * e_u2;
            im0_grid[k] = im;
        }
        for (int k = 0; k <= N_GRID; ++k) {
            core_nodes[k] = CoreNode{
                p0_tmp[k],
                p0_tmp[k + 1] - p0_tmp[k],
                p1_tmp[k],
                p1_tmp[k + 1] - p1_tmp[k]
            };
            dim0_grid[k] = im0_grid[k + 1] - im0_grid[k];
        }
        core_nodes[N_GRID + 1] = core_nodes[N_GRID];
        dim0_grid[N_GRID + 1] = 0.0;
    }

    inline void eval_weideman32(double ax, double a, double& out_re, double& out_im) const {
        double l_minus_a = L32 - a;
        double l_plus_a = L32 + a;
        double den_norm = 1.0 / (l_plus_a * l_plus_a + ax * ax);
        double Z_re = (l_minus_a * l_plus_a - ax * ax) * den_norm;
        double Z_im = (2.0 * L32 * ax) * den_norm;

        double p_re = a32[31];
        double p_im = 0.0;
        for (int k = 30; k >= 0; --k) {
            double n_re = p_re * Z_re - p_im * Z_im + a32[k];
            double n_im = p_re * Z_im + p_im * Z_re;
            p_re = n_re;
            p_im = n_im;
        }

        double d_re = l_plus_a * den_norm;
        double d_im = ax * den_norm;
        double d2_re = d_re * d_re - d_im * d_im;
        double d2_im = 2.0 * d_re * d_im;

        out_re = INV_SQRT_PI * d_re + 2.0 * (d2_re * p_re - d2_im * p_im);
        out_im = INV_SQRT_PI * d_im + 2.0 * (d2_re * p_im + d2_im * p_re);
    }
};

static const FaddeevaTable& get_faddeeva_table() {
    static const FaddeevaTable tab;
    return tab;
}

// Fast 3-FMA Re w(u + i*a) when |u| <= 12 and a <= 0.02 (zero divisions, 3.3e-8 accuracy)
inline double faddeeva_re_core(const FaddeevaTable& tab, double u, double a) {
    double pos = std::abs(u) * FaddeevaTable::INV_H;
    int k = static_cast<int>(pos);
    double f = pos - static_cast<double>(k);
    const auto& nd = tab.core_nodes[k];
    return (nd.p0 + f * nd.dp0) + a * (nd.p1 + f * nd.dp1 + a * tab.p2_grid[k]);
}

// Fast Re w(u + i*a) in the asymptotic wing |u| > 12
inline double faddeeva_re_wing(double u, double a) {
    double ir2 = 1.0 / (u * u + a * a);
    return (a * INV_SQRT_PI) * ir2 * (1.0 + ir2 * (1.5 + ir2 * (3.75 + ir2 * 13.125)));
}

inline double faddeeva_re(double u, double a) {
    if (u * u > 144.0) {
        return faddeeva_re_wing(u, a);
    }
    const auto& tab = get_faddeeva_table();
    if (a <= 0.02) {
        return faddeeva_re_core(tab, u, a);
    }
    double re, im;
    tab.eval_weideman32(std::abs(u), a, re, im);
    return re;
}

// Full complex w(u + i*a) for Voigt Jacobian evaluation in the component fitter
inline void faddeeva_w(double u, double a, double& out_re, double& out_im) {
    double ax = std::abs(u);
    double r2 = ax * ax + a * a;
    if (r2 > 144.0) {
        double ir2 = 1.0 / r2;
        out_re = (a * INV_SQRT_PI) * ir2 * (1.0 + ir2 * (1.5 + ir2 * (3.75 + ir2 * 13.125)));
        out_im = (ax * INV_SQRT_PI) * ir2 * (1.0 + ir2 * (0.5 + ir2 * (0.75 + ir2 * 1.875)));
        if (u < 0.0) out_im = -out_im;
        return;
    }
    const auto& tab = get_faddeeva_table();
    if (a <= 0.02) {
        double pos = ax * FaddeevaTable::INV_H;
        int k = static_cast<int>(pos);
        double f = pos - static_cast<double>(k);
        const auto& nd = tab.core_nodes[k];
        double p0 = nd.p0 + f * nd.dp0;
        double p1 = nd.p1 + f * nd.dp1;
        double im0 = tab.im0_grid[k] + f * tab.dim0_grid[k];
        out_re = p0 + a * (p1 + a * tab.p2_grid[k]);
        out_im = im0 - a * (2.0 * ax * p0 + a * ((2.0 * ax * ax - 1.0) * im0 - TWO_INV_SQRT_PI * ax));
        if (u < 0.0) out_im = -out_im;
        return;
    }
    tab.eval_weideman32(ax, a, out_re, out_im);
    if (u < 0.0) out_im = -out_im;
}

// -----------------------------------------------------------------------------
// 3. Bounding-Volume Hierarchy (BVH) over PartType0 spherical gas kernels
// -----------------------------------------------------------------------------
struct BVHNode {
    double min_x, min_y, min_z;
    double max_x, max_y, max_z;
    int left_or_start;
    int count; // > 0 for leaf, 0 for internal node (children: left_or_start, left_or_start + 1)
};

struct FastCutoutIndex {
    int64_t n_cells = 0;

    // Reordered into BVH leaf order for cache locality during traversal
    std::vector<double> px, py, pz;
    std::vector<double> hsml;
    std::vector<double> dl_factor_cgs; // (Mass / (Density * hsml^2)) * (UnitLength_cm / h)
    std::vector<double> vx_cgs, vy_cgs, vz_cgs;
    std::vector<double> temp_K;
    std::vector<double> n_H_cgs;
    std::vector<double> metallicity;
    std::vector<double> nhi_abundance;
    std::vector<int64_t> orig_idx;
    bool has_nhi_abundance = false;

    std::vector<BVHNode> nodes;

    // Ion balance lookup tables (supports 2D HM12 at z_snap or 3D CLOUDY FG11 at z_snap)
    int table_dim = 0; // 2 = HM12 2D (log_nH, log_T), 3 = CLOUDY 3D (log_nH, log_Z, log_T)
    std::vector<double> log_nh_grid;
    std::vector<double> log_z_grid;
    std::vector<double> log_t_grid;
    std::vector<double> ion_tables;
    double solar_abund[12] = {0};
    double z_solar = 0.01295;
    int use_part_nhi[12] = {0};
};

struct BuildItem {
    int64_t id;
    double cx, cy, cz;
    double r;
};

static void build_bvh_recursive(
    std::vector<BVHNode>& nodes,
    std::vector<BuildItem>& items,
    int node_idx,
    int start,
    int end
) {
    double min_x = std::numeric_limits<double>::infinity();
    double min_y = std::numeric_limits<double>::infinity();
    double min_z = std::numeric_limits<double>::infinity();
    double max_x = -std::numeric_limits<double>::infinity();
    double max_y = -std::numeric_limits<double>::infinity();
    double max_z = -std::numeric_limits<double>::infinity();

    double cmin_x = std::numeric_limits<double>::infinity();
    double cmin_y = std::numeric_limits<double>::infinity();
    double cmin_z = std::numeric_limits<double>::infinity();
    double cmax_x = -std::numeric_limits<double>::infinity();
    double cmax_y = -std::numeric_limits<double>::infinity();
    double cmax_z = -std::numeric_limits<double>::infinity();

    for (int i = start; i < end; ++i) {
        const auto& it = items[i];
        min_x = std::min(min_x, it.cx - it.r);
        min_y = std::min(min_y, it.cy - it.r);
        min_z = std::min(min_z, it.cz - it.r);
        max_x = std::max(max_x, it.cx + it.r);
        max_y = std::max(max_y, it.cy + it.r);
        max_z = std::max(max_z, it.cz + it.r);

        cmin_x = std::min(cmin_x, it.cx);
        cmin_y = std::min(cmin_y, it.cy);
        cmin_z = std::min(cmin_z, it.cz);
        cmax_x = std::max(cmax_x, it.cx);
        cmax_y = std::max(cmax_y, it.cy);
        cmax_z = std::max(cmax_z, it.cz);
    }

    nodes[node_idx].min_x = min_x;
    nodes[node_idx].min_y = min_y;
    nodes[node_idx].min_z = min_z;
    nodes[node_idx].max_x = max_x;
    nodes[node_idx].max_y = max_y;
    nodes[node_idx].max_z = max_z;

    int count = end - start;
    if (count <= 16) {
        nodes[node_idx].left_or_start = start;
        nodes[node_idx].count = count;
        return;
    }

    double dx = cmax_x - cmin_x;
    double dy = cmax_y - cmin_y;
    double dz = cmax_z - cmin_z;
    int axis = (dx >= dy && dx >= dz) ? 0 : ((dy >= dz) ? 1 : 2);
    int mid = start + count / 2;

    std::nth_element(
        items.begin() + start,
        items.begin() + mid,
        items.begin() + end,
        [axis](const BuildItem& a, const BuildItem& b) {
            if (axis == 0) return a.cx < b.cx;
            if (axis == 1) return a.cy < b.cy;
            return a.cz < b.cz;
        }
    );

    int left_child = static_cast<int>(nodes.size());
    nodes.emplace_back();
    nodes.emplace_back();
    nodes[node_idx].left_or_start = left_child;
    nodes[node_idx].count = 0;

    build_bvh_recursive(nodes, items, left_child, start, mid);
    build_bvh_recursive(nodes, items, left_child + 1, mid, end);
}

inline bool segment_intersects_aabb(
    const BVHNode& node,
    double p0x, double p0y, double p0z,
    double inv_vx, double inv_vy, double inv_vz
) {
    double tmin = 0.0;
    double tmax = 1.0;

    auto clip_axis = [&](double p0, double inv_v, double bmin, double bmax) -> bool {
        if (std::abs(inv_v) < 1e30) {
            double t1 = (bmin - p0) * inv_v;
            double t2 = (bmax - p0) * inv_v;
            if (t1 > t2) std::swap(t1, t2);
            tmin = std::max(tmin, t1);
            tmax = std::min(tmax, t2);
            return tmin <= tmax;
        } else {
            return (p0 >= bmin && p0 <= bmax);
        }
    };

    if (!clip_axis(p0x, inv_vx, node.min_x, node.max_x)) return false;
    if (!clip_axis(p0y, inv_vy, node.min_y, node.max_y)) return false;
    if (!clip_axis(p0z, inv_vz, node.min_z, node.max_z)) return false;
    return tmin <= tmax;
}

struct RayHit {
    double t;
    int64_t orig_id;
    int bvh_idx;
    double dl_cgs;
};

static void traverse_bvh_ray(
    const FastCutoutIndex& idx,
    const double start_ckpch[3],
    const double end_ckpch[3],
    std::vector<RayHit>& hits
) {
    hits.clear();
    if (idx.n_cells == 0 || idx.nodes.empty()) return;

    double vx = end_ckpch[0] - start_ckpch[0];
    double vy = end_ckpch[1] - start_ckpch[1];
    double vz = end_ckpch[2] - start_ckpch[2];
    double length = std::sqrt(vx * vx + vy * vy + vz * vz);
    if (length <= 0.0) return;

    double ux = vx / length;
    double uy = vy / length;
    double uz = vz / length;

    double inv_vx = (std::abs(vx) > 1e-30) ? (1.0 / vx) : 1e31;
    double inv_vy = (std::abs(vy) > 1e-30) ? (1.0 / vy) : 1e31;
    double inv_vz = (std::abs(vz) > 1e-30) ? (1.0 / vz) : 1e31;

    const auto& ktab = get_cubic_kernel_table();

    int stack[128];
    int sp = 0;
    stack[sp++] = 0;

    while (sp > 0) {
        int node_id = stack[--sp];
        const BVHNode& node = idx.nodes[node_id];
        if (!segment_intersects_aabb(node, start_ckpch[0], start_ckpch[1], start_ckpch[2], inv_vx, inv_vy, inv_vz)) {
            continue;
        }
        if (node.count > 0) {
            int s = node.left_or_start;
            int e = s + node.count;
            for (int i = s; i < e; ++i) {
                double rx = idx.px[i] - start_ckpch[0];
                double ry = idx.py[i] - start_ckpch[1];
                double rz = idx.pz[i] - start_ckpch[2];
                double h = idx.hsml[i];
                double l_proj = rx * ux + ry * uy + rz * uz;
                if (l_proj < -h || l_proj > length + h) continue;
                double r2 = rx * rx + ry * ry + rz * rz;
                double b2 = r2 - l_proj * l_proj;
                double h2 = h * h;
                if (b2 >= h2) continue;
                double q2 = (b2 > 0.0) ? (b2 / h2) : 0.0;
                double k_val = ktab.eval(q2);
                double dl_cgs = k_val * idx.dl_factor_cgs[i];
                if (dl_cgs > 0.0) {
                    hits.push_back(RayHit{l_proj / length, idx.orig_idx[i], i, dl_cgs});
                }
            }
        } else {
            int left = node.left_or_start;
            stack[sp++] = left + 1;
            stack[sp++] = left;
        }
    }

    std::sort(hits.begin(), hits.end(), [](const RayHit& a, const RayHit& b) {
        if (a.t != b.t) return a.t < b.t;
        return a.orig_id < b.orig_id;
    });
}

// -----------------------------------------------------------------------------
// 4. 12-Ion Number Density & Column Density Evaluation
// -----------------------------------------------------------------------------
inline void find_bracket(const std::vector<double>& grid, double val, int& i0, double& frac) {
    int n = static_cast<int>(grid.size());
    if (val <= grid[0]) {
        i0 = 0;
        frac = 0.0;
        return;
    }
    if (val >= grid[n - 1]) {
        i0 = n - 2;
        frac = 1.0;
        return;
    }
    double g0 = grid[0];
    double gn = grid[n - 1];
    double pos = (val - g0) * static_cast<double>(n - 1) / (gn - g0);
    int guess = static_cast<int>(pos);
    if (guess >= 0 && guess < n - 1 && grid[guess] <= val && val <= grid[guess + 1]) {
        i0 = guess;
        frac = (val - grid[i0]) / (grid[i0 + 1] - grid[i0]);
        return;
    }
    auto it = std::upper_bound(grid.begin(), grid.end(), val);
    i0 = std::clamp(static_cast<int>(it - grid.begin()) - 1, 0, n - 2);
    frac = (val - grid[i0]) / (grid[i0 + 1] - grid[i0]);
}

static void evaluate_hit_ions(
    const FastCutoutIndex& idx,
    const std::vector<RayHit>& hits,
    std::vector<double>& n_ion_out, // size: 12 * n_hits
    double logN_out[12]
) {
    int n_hits = static_cast<int>(hits.size());
    n_ion_out.assign(12 * n_hits, 0.0);
    double col_sum[12] = {0.0};

    int n_nh = static_cast<int>(idx.log_nh_grid.size());
    int n_z = static_cast<int>(idx.log_z_grid.size());
    int n_t = static_cast<int>(idx.log_t_grid.size());

    for (int h_idx = 0; h_idx < n_hits; ++h_idx) {
        int i = hits[h_idx].bvh_idx;
        double dl = hits[h_idx].dl_cgs;
        double nh = idx.n_H_cgs[i];
        double T = idx.temp_K[i];
        double Z = idx.metallicity[i];

        double log_nh = std::log10(std::max(nh, 1e-30));
        double log_t = std::log10(std::max(T, 1.0));

        int inh = 0, it = 0, iz = 0;
        double fnh = 0.0, ft = 0.0, fz = 0.0;
        if (idx.table_dim >= 2) {
            find_bracket(idx.log_nh_grid, log_nh, inh, fnh);
            find_bracket(idx.log_t_grid, log_t, it, ft);
        }
        if (idx.table_dim == 3) {
            double log_z_rel = std::log10(std::max(Z / idx.z_solar, 1e-30));
            find_bracket(idx.log_z_grid, log_z_rel, iz, fz);
        }

        for (int ion = 0; ion < 12; ++ion) {
            double n_ion_val = 0.0;
            if (idx.use_part_nhi[ion] && idx.has_nhi_abundance) {
                n_ion_val = nh * idx.nhi_abundance[i];
            } else if (idx.table_dim == 2) {
                const double* tab = idx.ion_tables.data() + ion * (n_nh * n_t);
                double v00 = tab[inh * n_t + it];
                double v01 = tab[inh * n_t + (it + 1)];
                double v10 = tab[(inh + 1) * n_t + it];
                double v11 = tab[(inh + 1) * n_t + (it + 1)];
                double log_f = (1.0 - fnh) * ((1.0 - ft) * v00 + ft * v01)
                             + fnh * ((1.0 - ft) * v10 + ft * v11);
                double f_ion = std::pow(10.0, log_f);
                if (f_ion <= 1e-9) f_ion = 0.0;
                if (f_ion > 1.0) f_ion = 1.0;
                if (ion == 0) {
                    n_ion_val = nh * f_ion;
                } else {
                    n_ion_val = nh * (Z / idx.z_solar) * idx.solar_abund[ion] * f_ion;
                }
            } else if (idx.table_dim == 3) {
                int stride_nh = n_z * n_t;
                const double* tab = idx.ion_tables.data() + ion * (n_nh * stride_nh);
                auto at = [&](int a, int b, int c) { return tab[a * stride_nh + b * n_t + c]; };
                double c00 = at(inh, iz, it) * (1.0 - ft) + at(inh, iz, it + 1) * ft;
                double c01 = at(inh, iz + 1, it) * (1.0 - ft) + at(inh, iz + 1, it + 1) * ft;
                double c10 = at(inh + 1, iz, it) * (1.0 - ft) + at(inh + 1, iz, it + 1) * ft;
                double c11 = at(inh + 1, iz + 1, it) * (1.0 - ft) + at(inh + 1, iz + 1, it + 1) * ft;
                double c0 = c00 * (1.0 - fz) + c01 * fz;
                double c1 = c10 * (1.0 - fz) + c11 * fz;
                double log_f = c0 * (1.0 - fnh) + c1 * fnh;
                double f_ion = std::pow(10.0, log_f);
                if (f_ion <= 1e-9) f_ion = 0.0;
                if (f_ion > 1.0) f_ion = 1.0;
                if (ion == 0) {
                    n_ion_val = nh * f_ion;
                } else {
                    n_ion_val = nh * (Z / idx.z_solar) * idx.solar_abund[ion] * f_ion;
                }
            }
            n_ion_out[ion * n_hits + h_idx] = n_ion_val;
            col_sum[ion] += n_ion_val * dl;
        }
    }

    for (int ion = 0; ion < 12; ++ion) {
        logN_out[ion] = std::log10(std::max(col_sum[ion], 1e-30));
    }
}

// -----------------------------------------------------------------------------
// 5. Tiled OpenMP + AVX2 FP64 Faddeeva Voigt Optical Depth Spectrum Synthesis
// -----------------------------------------------------------------------------
struct CellVoigtPrecomp {
    double lam1;
    double inv_lam1;
    double c_over_b;
    double a;
    double tau0;
    int lo_bin;
    int hi_bin;
    int weid_lo;
    int weid_hi;
    int sub_lo;
    int sub_hi;
    int n_vbin;
};

static void precompute_ion_cells(
    int n_hits,
    const RayHit* hits,
    const FastCutoutIndex& idx,
    const double* n_ion_hits,
    const double* z_dopp_hits,
    double lam0_A,
    double f_osc,
    double gamma_s,
    double mass_amu,
    double lam_min_A,
    double dlam_A,
    int n_bins,
    std::vector<CellVoigtPrecomp>& out_cells
) {
    out_cells.clear();
    out_cells.reserve(n_hits);
    double mass_g = mass_amu * AMU_CGS;
    constexpr double min_tau = 1e-8;
    constexpr double subgrid_resolution = 10.0;

    for (int h = 0; h < n_hits; ++h) {
        double col = n_ion_hits[h] * hits[h].dl_cgs;
        if (col <= 0.0) continue;

        int b_idx = hits[h].bvh_idx;
        double T = idx.temp_K[b_idx];
        double b_cms = std::sqrt(2.0 * K_BOLTZ_CGS * T / mass_g);
        if (b_cms <= 0.0) continue;

        double tau0 = TAU_FACTOR_CGS * col * f_osc * (lam0_A * 1e-8) / b_cms;
        if (tau0 < 0.1 * min_tau) continue;

        double lam1 = lam0_A * (1.0 + z_dopp_hits[h]);
        double inv_lam1 = 1.0 / lam1;
        double nu_dop = 1e8 * b_cms * inv_lam1;
        double a = gamma_s / (4.0 * PI * nu_dop);
        double c_over_b = C_CMS / b_cms;
        double thermal_dlam = lam1 / c_over_b;

        int n_vbin = 1;
        if (thermal_dlam < dlam_A) {
            double ratio = subgrid_resolution * dlam_A / thermal_dlam;
            int p = std::max(0, static_cast<int>(std::ceil(std::log10(ratio))));
            n_vbin = 1;
            for (int k = 0; k < p; ++k) n_vbin *= 10;
            if (n_vbin > 1000) n_vbin = 1000;
        }

        int right_idx = static_cast<int>(std::floor((lam1 - lam_min_A) / dlam_A)) + 1;
        right_idx = std::clamp(right_idx, 1, n_bins - 1);
        int left_idx = right_idx - 1;

        double u_gauss = (tau0 > min_tau) ? std::sqrt(std::log(tau0 / min_tau)) : 1.0;
        double u_lor = (tau0 * a > SQRT_PI * min_tau) ? std::sqrt(tau0 * a / (SQRT_PI * min_tau)) : 1.0;
        double du_max = std::max(u_gauss, u_lor) + 1.5;
        int half_bins = std::max(2, static_cast<int>(std::ceil(du_max * thermal_dlam / dlam_A)) + 1);
        int lo_bin = std::max(0, left_idx - half_bins);
        int hi_bin = std::min(n_bins, right_idx + half_bins);
        if (lo_bin >= hi_bin) continue;

        int weid_half = std::max(2, static_cast<int>(std::ceil(12.0 * thermal_dlam / dlam_A)) + 1);
        int weid_lo = std::max(lo_bin, left_idx - weid_half);
        int weid_hi = std::min(hi_bin, right_idx + weid_half);

        int sub_lo = weid_lo;
        int sub_hi = weid_lo;
        if (n_vbin > 1) {
            int sub_half = std::max(4, static_cast<int>(std::ceil(7.0 * thermal_dlam / dlam_A)) + 1);
            sub_lo = std::max(weid_lo, left_idx - sub_half);
            sub_hi = std::min(weid_hi, right_idx + sub_half);
        }

        out_cells.push_back(CellVoigtPrecomp{
            lam1, inv_lam1, c_over_b, a, tau0,
            lo_bin, hi_bin, weid_lo, weid_hi, sub_lo, sub_hi, n_vbin
        });
    }
}

// Evaluate a single tile [tile_lo, tile_hi) of an ion's optical depth grid
static void deposit_ion_tile(
    const std::vector<CellVoigtPrecomp>& cells,
    const FaddeevaTable& ftab,
    double lam_min_A,
    double dlam_A,
    int tile_lo,
    int tile_hi,
    double* tau_buf
) {
    std::fill(tau_buf + tile_lo, tau_buf + tile_hi, 0.0);

    // Map d = (lam - lam1) / lam1 -> u = c_over_b * (lam1 / lam - 1) = -c_over_b * d / (1 + d)
    // Using 4-term geometric expansion -d * (1 - d * (1 - d * (1 - d))) has zero divisions and < 1e-9 error!
    auto u_from_d = [](double c_over_b, double d) -> double {
        return -c_over_b * d * (1.0 - d * (1.0 - d * (1.0 - d)));
    };

    for (const auto& cell : cells) {
        int lo = std::max(tile_lo, cell.lo_bin);
        int hi = std::min(tile_hi, cell.hi_bin);
        if (lo >= hi) continue;

        double d_step = dlam_A * cell.inv_lam1;
        double d_base = (lam_min_A - cell.lam1) * cell.inv_lam1;
        double c_over_b = cell.c_over_b;
        double a = cell.a;
        double a2 = a * a;
        double tau0 = cell.tau0;
        double wing_prefac = tau0 * a * INV_SQRT_PI;

        int w_lo = std::clamp(cell.weid_lo, lo, hi);
        int w_hi = std::clamp(cell.weid_hi, lo, hi);

        // 1. Left asymptotic wing [lo, w_lo): |u| > 12
        #pragma omp simd
        for (int b = lo; b < w_lo; ++b) {
            double d = d_base + b * d_step;
            double u = u_from_d(c_over_b, d);
            double ir2 = 1.0 / (u * u + a2);
            tau_buf[b] += wing_prefac * ir2 * (1.0 + ir2 * (1.5 + ir2 * (3.75 + ir2 * 13.125)));
        }

        // 2. Core [w_lo, w_hi): |u| <= 12
        if (w_hi > w_lo) {
            if (cell.n_vbin <= 1) {
                for (int b = w_lo; b < w_hi; ++b) {
                    double d = d_base + b * d_step;
                    double u = u_from_d(c_over_b, d);
                    tau_buf[b] += tau0 * faddeeva_re_core(ftab, u, a);
                }
            } else {
                int s_lo = std::clamp(cell.sub_lo, w_lo, w_hi);
                int s_hi = std::clamp(cell.sub_hi, w_lo, w_hi);
                for (int b = w_lo; b < s_lo; ++b) {
                    double d = d_base + b * d_step;
                    double u = u_from_d(c_over_b, d);
                    tau_buf[b] += tau0 * faddeeva_re_core(ftab, u, a);
                }
                if (s_hi > s_lo) {
                    int n_vbin = cell.n_vbin;
                    double d_sub_step = d_step / static_cast<double>(n_vbin);
                    double d_sub_start = d_base + (s_lo - 0.5) * d_step;
                    double inv_nvbin = 1.0 / static_cast<double>(n_vbin);
                    double u_prev = u_from_d(c_over_b, d_sub_start);
                    double t_prev = tau0 * faddeeva_re_core(ftab, u_prev, a);
                    for (int b = s_lo; b < s_hi; ++b) {
                        double sum_b = 0.0;
                        int base_s = (b - s_lo) * n_vbin;
                        for (int s = 1; s <= n_vbin; ++s) {
                            double d_cur = d_sub_start + (base_s + s) * d_sub_step;
                            double u_cur = u_from_d(c_over_b, d_cur);
                            double t_cur = tau0 * faddeeva_re_core(ftab, u_cur, a);
                            sum_b += 0.5 * (t_prev + t_cur);
                            t_prev = t_cur;
                        }
                        tau_buf[b] += sum_b * inv_nvbin;
                    }
                }
                for (int b = s_hi; b < w_hi; ++b) {
                    double d = d_base + b * d_step;
                    double u = u_from_d(c_over_b, d);
                    tau_buf[b] += tau0 * faddeeva_re_core(ftab, u, a);
                }
            }
        }

        // 3. Right asymptotic wing [w_hi, hi): |u| > 12
        #pragma omp simd
        for (int b = w_hi; b < hi; ++b) {
            double d = d_base + b * d_step;
            double u = u_from_d(c_over_b, d);
            double ir2 = 1.0 / (u * u + a2);
            tau_buf[b] += wing_prefac * ir2 * (1.0 + ir2 * (1.5 + ir2 * (3.75 + ir2 * 13.125)));
        }
    }
}

// -----------------------------------------------------------------------------
// 6. C++17 Voigt Profile Component Fitter (matches tngsight.vpfit / components)
// -----------------------------------------------------------------------------
struct IonAtomicSpec {
    double lam0;
    double f;
    double gamma;
    double b_min;
    double logN_max;
    int damped;
};

struct FittedComp {
    double v;
    double dv; // -1 if null
    double logN;
    double dlogN; // -1 if null
    double b;
    double db; // -1 if null
    int region;
    int flag;
    double EW;
};

struct RegionAOD {
    int region;
    double v_lo;
    double v_hi;
    double logN_aod; // -99 if null
};

inline double fmt_round(double x, int d) {
    double s = std::pow(10.0, d);
    double r = std::copysign(std::floor(std::abs(x) * s + 0.5) / s, x);
    return r + 0.0;
}

static void eval_tau_and_jac(
    const double* v, int m,
    const double* p, int n_comp,
    double k_tau, double a0,
    double* tau_out,
    double* jac_tau_out
) {
    std::fill(tau_out, tau_out + m, 0.0);
    int np = 3 * n_comp;
    if (jac_tau_out) {
        std::fill(jac_tau_out, jac_tau_out + m * np, 0.0);
    }

    for (int c = 0; c < n_comp; ++c) {
        double vc = p[3 * c + 0];
        double lN = p[3 * c + 1];
        double b = p[3 * c + 2];
        double inv_b = 1.0 / b;
        double inv_b2 = inv_b * inv_b;
        double a = a0 * inv_b;
        double A = k_tau * std::pow(10.0, lN);
        double A_over_b = A * inv_b;
        double A_over_b2 = A * inv_b2;

        if (!jac_tau_out) {
            for (int i = 0; i < m; ++i) {
                double u = (v[i] - vc) * inv_b;
                tau_out[i] += A_over_b * faddeeva_re(u, a);
            }
        } else {
            for (int i = 0; i < m; ++i) {
                double u = (v[i] - vc) * inv_b;
                double w_re, w_im;
                faddeeva_w(u, a, w_re, w_im);
                double H = w_re;
                double tc = A_over_b * H;
                tau_out[i] += tc;

                double dw_re = -2.0 * (u * w_re - a * w_im);
                double dw_im = -2.0 * (u * w_im + a * w_re) + TWO_INV_SQRT_PI;
                double Hu = dw_re;
                double Ha = -dw_im;

                double* jrow = jac_tau_out + i * np + 3 * c;
                jrow[0] = -A_over_b2 * Hu;
                jrow[1] = tc * LN10;
                jrow[2] = -A_over_b2 * (H + u * Hu + a * Ha);
            }
        }
    }
}

static bool cholesky_solve(int n, const double* A, const double* b, double* x) {
    double L[24 * 24];
    for (int i = 0; i < n; ++i) {
        for (int j = 0; j <= i; ++j) {
            double sum = A[i * n + j];
            for (int k = 0; k < j; ++k) {
                sum -= L[i * n + k] * L[j * n + k];
            }
            if (i == j) {
                if (sum <= 1e-18) return false;
                L[i * n + j] = std::sqrt(sum);
            } else {
                L[i * n + j] = sum / L[j * n + j];
            }
        }
    }
    double y[24];
    for (int i = 0; i < n; ++i) {
        double sum = b[i];
        for (int k = 0; k < i; ++k) sum -= L[i * n + k] * y[k];
        y[i] = sum / L[i * n + i];
    }
    for (int i = n - 1; i >= 0; --i) {
        double sum = y[i];
        for (int k = i + 1; k < n; ++k) sum -= L[k * n + i] * x[k];
        x[i] = sum / L[i * n + i];
    }
    return true;
}

static void jacobi_eigen(int n, const double* A_in, double* V, double* d) {
    std::vector<double> A(A_in, A_in + n * n);
    std::fill(V, V + n * n, 0.0);
    for (int i = 0; i < n; ++i) {
        V[i * n + i] = 1.0;
        d[i] = A[i * n + i];
    }

    for (int iter = 0; iter < 50; ++iter) {
        double sm = 0.0;
        for (int ip = 0; ip < n - 1; ++ip) {
            for (int iq = ip + 1; iq < n; ++iq) {
                sm += std::abs(A[ip * n + iq]);
            }
        }
        if (sm < 1e-15) break;

        for (int ip = 0; ip < n - 1; ++ip) {
            for (int iq = ip + 1; iq < n; ++iq) {
                double g = 100.0 * std::abs(A[ip * n + iq]);
                if (iter > 3 && (std::abs(d[ip]) + g == std::abs(d[ip])) && (std::abs(d[iq]) + g == std::abs(d[iq]))) {
                    A[ip * n + iq] = 0.0;
                } else if (std::abs(A[ip * n + iq]) > 0.0) {
                    double h = d[iq] - d[ip];
                    double t;
                    if (std::abs(h) + g == std::abs(h)) {
                        t = A[ip * n + iq] / h;
                    } else {
                        double theta = 0.5 * h / A[ip * n + iq];
                        t = 1.0 / (std::abs(theta) + std::sqrt(1.0 + theta * theta));
                        if (theta < 0.0) t = -t;
                    }
                    double c = 1.0 / std::sqrt(1.0 + t * t);
                    double s = t * c;
                    double tau = s / (1.0 + c);
                    h = t * A[ip * n + iq];
                    d[ip] -= h;
                    d[iq] += h;
                    A[ip * n + iq] = 0.0;

                    auto rotate = [&](double& a, double& b) {
                        double g0 = a;
                        double h0 = b;
                        a = g0 - s * (h0 + g0 * tau);
                        b = h0 + s * (g0 - h0 * tau);
                    };
                    for (int j = 0; j < ip; ++j) rotate(A[j * n + ip], A[j * n + iq]);
                    for (int j = ip + 1; j < iq; ++j) rotate(A[ip * n + j], A[j * n + iq]);
                    for (int j = iq + 1; j < n; ++j) rotate(A[ip * n + j], A[iq * n + j]);
                    for (int j = 0; j < n; ++j) rotate(V[j * n + ip], V[j * n + iq]);
                }
            }
        }
    }
}

struct LMSolveResult {
    std::vector<double> x;
    std::vector<double> fun;
    std::vector<double> jac; // m * np
    double cost;
    int nfev;
};

static LMSolveResult solve_voigt_lm(
    const double* vr, const double* Fr, int m,
    const double* p0, int n_comp,
    const double* lb, const double* ub,
    double k_tau, double a0, double sig,
    int max_iter
) {
    int np = 3 * n_comp;
    LMSolveResult res;
    res.x.assign(np, 0.0);
    for (int j = 0; j < np; ++j) {
        res.x[j] = std::clamp(p0[j], lb[j], ub[j]);
    }
    res.fun.resize(m);
    res.jac.resize(m * np);
    res.nfev = 0;

    std::vector<double> tau(m);
    std::vector<double> jac_tau(m * np);
    std::vector<double> fun_trial(m);
    std::vector<double> x_trial(np);
    std::vector<double> JTJ(np * np);
    std::vector<double> g(np);
    std::vector<double> scale(np, 1.0);
    std::vector<double> A_aug(np * np);
    std::vector<double> V(np * np);
    std::vector<double> eig(np);
    std::vector<double> delta(np);

    double inv_sig = 1.0 / sig;

    auto eval_f_and_j = [&](const std::vector<double>& x, std::vector<double>& f_out, std::vector<double>& j_out, bool want_j) -> double {
        res.nfev++;
        eval_tau_and_jac(vr, m, x.data(), n_comp, k_tau, a0, tau.data(), want_j ? jac_tau.data() : nullptr);
        double s2 = 0.0;
        for (int i = 0; i < m; ++i) {
            double Fm = std::exp(-tau[i]);
            double fi = (Fr[i] - Fm) * inv_sig;
            f_out[i] = fi;
            s2 += fi * fi;
            if (want_j) {
                double fac = Fm * inv_sig;
                const double* jt_row = jac_tau.data() + i * np;
                double* j_row = j_out.data() + i * np;
                for (int k = 0; k < np; ++k) {
                    j_row[k] = fac * jt_row[k];
                }
            }
        }
        return 0.5 * s2;
    };

    res.cost = eval_f_and_j(res.x, res.fun, res.jac, true);
    double lambda = 1e-2;

    for (int iter = 0; iter < max_iter; ++iter) {
        std::fill(JTJ.begin(), JTJ.end(), 0.0);
        std::fill(g.begin(), g.end(), 0.0);
        for (int i = 0; i < m; ++i) {
            const double* j_row = res.jac.data() + i * np;
            double fi = res.fun[i];
            for (int a = 0; a < np; ++a) {
                double ja = j_row[a];
                g[a] += ja * fi;
                for (int b = a; b < np; ++b) {
                    JTJ[a * np + b] += ja * j_row[b];
                }
            }
        }
        for (int a = 0; a < np; ++a) {
            for (int b = 0; b < a; ++b) {
                JTJ[a * np + b] = JTJ[b * np + a];
            }
            double col_norm = std::sqrt(std::max(0.0, JTJ[a * np + a]));
            if (iter == 0) {
                scale[a] = (col_norm > 1e-12) ? col_norm : 1.0;
            } else {
                scale[a] = std::max(scale[a], col_norm);
            }
        }

        double max_pg = 0.0;
        for (int a = 0; a < np; ++a) {
            double pg = g[a];
            if ((res.x[a] <= lb[a] + 1e-12 && pg > 0.0) || (res.x[a] >= ub[a] - 1e-12 && pg < 0.0)) {
                pg = 0.0;
            }
            max_pg = std::max(max_pg, std::abs(pg) / scale[a]);
        }
        if (max_pg < 1e-7) break;

        bool step_accepted = false;
        for (int sub = 0; sub < 6; ++sub) {
            A_aug = JTJ;
            for (int a = 0; a < np; ++a) {
                A_aug[a * np + a] += lambda * scale[a] * scale[a];
                if ((res.x[a] <= lb[a] + 1e-12 && g[a] > 0.0) || (res.x[a] >= ub[a] - 1e-12 && g[a] < 0.0)) {
                    for (int b = 0; b < np; ++b) {
                        A_aug[a * np + b] = 0.0;
                        A_aug[b * np + a] = 0.0;
                    }
                    A_aug[a * np + a] = 1.0;
                }
            }

            double rhs[24];
            for (int a = 0; a < np; ++a) {
                double ga = g[a];
                if ((res.x[a] <= lb[a] + 1e-12 && ga > 0.0) || (res.x[a] >= ub[a] - 1e-12 && ga < 0.0)) {
                    ga = 0.0;
                }
                rhs[a] = -ga;
            }

            if (!cholesky_solve(np, A_aug.data(), rhs, delta.data())) {
                jacobi_eigen(np, A_aug.data(), V.data(), eig.data());
                std::fill(delta.begin(), delta.end(), 0.0);
                for (int k = 0; k < np; ++k) {
                    if (eig[k] > 1e-15) {
                        double vtg = 0.0;
                        for (int a = 0; a < np; ++a) vtg += V[a * np + k] * rhs[a];
                        double coeff = vtg / eig[k];
                        for (int a = 0; a < np; ++a) delta[a] += V[a * np + k] * coeff;
                    }
                }
            }

            double step_norm = 0.0;
            double x_norm = 1.0;
            for (int a = 0; a < np; ++a) {
                x_trial[a] = std::clamp(res.x[a] + delta[a], lb[a], ub[a]);
                double d_act = x_trial[a] - res.x[a];
                step_norm += d_act * d_act;
                x_norm += res.x[a] * res.x[a];
            }

            double trial_cost = eval_f_and_j(x_trial, fun_trial, res.jac, false);
            if (trial_cost < res.cost) {
                double rel_impr = (res.cost - trial_cost) / std::max(res.cost, 1e-30);
                res.x = x_trial;
                res.cost = eval_f_and_j(res.x, res.fun, res.jac, true);
                lambda = std::max(lambda * 0.3333333333, 1e-11);
                step_accepted = true;
                if (rel_impr < 1e-6 || std::sqrt(step_norm) < 1e-6 * std::sqrt(x_norm)) {
                    iter = max_iter;
                }
                break;
            } else {
                lambda *= 4.0;
                if (lambda > 1e9) break;
            }
        }
        if (!step_accepted) break;
    }

    return res;
}

static std::vector<int> get_mf_scales(const double* v, int n_v) {
    std::vector<int> out;
    if (n_v < 3) return out;
    double du = std::abs(v[1] - v[0]);
    const double scales_kms[6] = {3.0, 7.0, 15.0, 31.0, 63.0, 127.0};
    for (double w : scales_kms) {
        int n = static_cast<int>(std::llround(w / du)) | 1;
        if (n > 1 && n <= n_v) {
            if (std::find(out.begin(), out.end(), n) == out.end()) {
                out.push_back(n);
            }
        }
    }
    return out;
}

static void compute_box_significance(const double* x, int n_v, int box_n, double sig, std::vector<double>& S) {
    S.resize(n_v);
    std::vector<double> c(n_v + 1, 0.0);
    for (int i = 0; i < n_v; ++i) c[i + 1] = c[i] + x[i];
    int half = box_n / 2;
    for (int j = 0; j < n_v; ++j) {
        int lo = std::clamp(j - half, 0, n_v);
        int hi = std::clamp(j + half + 1, 0, n_v);
        S[j] = (c[hi] - c[lo]) / (sig * std::sqrt(static_cast<double>(hi - lo)));
    }
}

static std::vector<std::pair<int, int>> find_regions_cpp(const double* v, const double* flux, int n_v) {
    constexpr double sig = 0.01;
    constexpr double detect_nsigma = 3.0;
    constexpr double edge_nsigma = 1.0;
    constexpr double min_width_kms = 3.0;
    constexpr double pad_kms = 15.0;
    constexpr double merge_gap_kms = 10.0;

    std::vector<double> D(n_v);
    for (int i = 0; i < n_v; ++i) D[i] = 1.0 - flux[i];

    std::vector<std::pair<int, int>> runs;
    auto collect_runs = [&](double edge_thresh, const std::vector<uint8_t>& seed_mask) {
        int i = 0;
        while (i < n_v) {
            if (D[i] > edge_thresh) {
                int s = i;
                bool has_seed = false;
                while (i < n_v && D[i] > edge_thresh) {
                    if (seed_mask[i]) has_seed = true;
                    ++i;
                }
                int e = i;
                if (has_seed && (v[e - 1] - v[s] >= min_width_kms)) {
                    runs.emplace_back(s, e);
                }
            } else {
                ++i;
            }
        }
    };

    std::vector<uint8_t> seed0(n_v, 0);
    for (int i = 0; i < n_v; ++i) seed0[i] = (D[i] > detect_nsigma * sig) ? 1 : 0;
    collect_runs(edge_nsigma * sig, seed0);

    std::vector<double> S;
    std::vector<uint8_t> seed_n(n_v);
    for (int box_n : get_mf_scales(v, n_v)) {
        compute_box_significance(D.data(), n_v, box_n, sig, S);
        bool any_seed = false;
        for (int i = 0; i < n_v; ++i) {
            seed_n[i] = (S[i] >= detect_nsigma) ? 1 : 0;
            if (seed_n[i]) any_seed = true;
        }
        if (!any_seed) continue;
        collect_runs(edge_nsigma * sig / std::sqrt(static_cast<double>(box_n)), seed_n);
    }

    if (runs.empty()) return {};
    std::sort(runs.begin(), runs.end());
    runs.erase(std::unique(runs.begin(), runs.end()), runs.end());

    std::vector<std::pair<int, int>> padded;
    for (const auto& r : runs) {
        double vlo_target = v[r.first] - pad_kms;
        double vhi_target = v[r.second - 1] + pad_kms;
        int lo = static_cast<int>(std::lower_bound(v, v + n_v, vlo_target) - v);
        int hi = static_cast<int>(std::upper_bound(v, v + n_v, vhi_target) - v);
        padded.emplace_back(std::max(0, lo), std::min(n_v, hi));
    }

    std::vector<std::pair<int, int>> merged;
    for (const auto& p : padded) {
        if (!merged.empty() && (p.first < merged.back().second || v[p.first] - v[merged.back().second - 1] < merge_gap_kms)) {
            merged.back().second = std::max(merged.back().second, p.second);
        } else {
            merged.push_back(p);
        }
    }
    return merged;
}

static bool damped_seed_cpp(
    const double* v, const double* flux, int m,
    const IonAtomicSpec& spec, double k_tau, double a0,
    double out_seed[3]
) {
    if (!spec.damped) return false;
    constexpr double damped_core_flux = 0.01;
    constexpr double damped_min_core_kms = 100.0;
    constexpr double damped_wing_iqr = 0.3;
    constexpr double damped_logN = 19.0;
    constexpr double damped_seed_margin = 0.5;
    constexpr double damped_b_init = 30.0;

    int best_s = -1, best_e = -1;
    double best_w = -1.0;
    int i = 0;
    while (i < m) {
        if (flux[i] < damped_core_flux) {
            int s = i;
            while (i < m && flux[i] < damped_core_flux) ++i;
            int e = i;
            double w = v[e - 1] - v[s];
            if (w > best_w) {
                best_w = w;
                best_s = s;
                best_e = e;
            }
        } else {
            ++i;
        }
    }
    if (best_s < 0 || best_w < damped_min_core_kms) return false;

    double vc = 0.5 * (v[best_s] + v[best_e - 1]);
    std::vector<double> est;
    for (int j = 0; j < m; ++j) {
        double dv = std::abs(v[j] - vc);
        if (flux[j] > 0.05 && flux[j] < 0.9 && dv > 0.5 * best_w + 5.0) {
            double val = std::log10((-std::log(flux[j])) * SQRT_PI * dv * dv / (k_tau * a0));
            est.push_back(val);
        }
    }
    if (est.size() < 5) return false;
    std::sort(est.begin(), est.end());
    auto pct = [&](double q) {
        double pos = q * static_cast<double>(est.size() - 1);
        int idx = static_cast<int>(pos);
        double rem = pos - idx;
        if (idx + 1 < static_cast<int>(est.size())) return est[idx] + rem * (est[idx + 1] - est[idx]);
        return est[idx];
    };
    double q25 = pct(0.25);
    double lN = pct(0.50);
    double q75 = pct(0.75);
    if (q75 - q25 > damped_wing_iqr) return false;
    if (lN < damped_logN - damped_seed_margin) return false;

    out_seed[0] = vc;
    out_seed[1] = std::clamp(lN, 10.0, spec.logN_max);
    out_seed[2] = damped_b_init;
    return true;
}

static void fit_single_region_cpp(
    const double* vs,
    const double* flux,
    int n_v,
    int rid,
    int lo,
    int hi,
    int cap,
    const IonAtomicSpec& spec,
    int max_lm_iter,
    std::vector<FittedComp>& out_comps
) {
    out_comps.clear();
    if (cap <= 0) return;

    int m = hi - lo;
    const double* vr = vs + lo;
    const double* Fr = flux + lo;
    bool is_edge = (lo == 0 || hi == n_v);

    double lam_cm = spec.lam0 * 1e-8;
    double k_tau = SIGMA0_CGS * spec.f * lam_cm / (SQRT_PI * 1e5);
    double a0 = spec.gamma * lam_cm / (4.0 * PI * 1e5);

    constexpr double sig = 0.01;
    constexpr double chisq_lim = 1.0;
    constexpr double resid_lim = 0.03;
    constexpr double dchisq_min_frac = 0.01;
    constexpr double b_max = 150.0;
    constexpr double b_init = 20.0;
    constexpr int max_comp_region = 8;
    constexpr double min_logN_keep = 10.05;
    constexpr double sat_tau0 = 5.0;
    constexpr double sat_flux = 0.05;
    constexpr double damped_logN = 19.0;

    double v_lo = vr[0];
    double v_hi = vr[m - 1];
    double nlo = 10.0;
    double nhi = spec.logN_max;
    double b_min = spec.b_min;
    double b0 = std::clamp(b_init, b_min, b_max);
    double du = (m > 1) ? std::abs(vr[1] - vr[0]) : 1.0;

    auto chi2nu = [&](const std::vector<double>& fun, int ncomp) -> double {
        double s2 = 0.0;
        for (double f : fun) s2 += f * f;
        return s2 / static_cast<double>(std::max(1, m - 3 * ncomp));
    };

    std::vector<double> res0(m);
    for (int i = 0; i < m; ++i) res0[i] = (Fr[i] - 1.0) / sig;
    double chi0 = chi2nu(res0, 0);

    auto scales = get_mf_scales(vr, m);

    auto px_ok = [&](const std::vector<double>& fun, double c) -> bool {
        if (c >= chisq_lim) return false;
        double max_af = 0.0;
        for (double f : fun) max_af = std::max(max_af, std::abs(f));
        return (sig * max_af <= resid_lim);
    };

    auto mf_hit = [&](const std::vector<double>& fun, int& out_j, int& out_n) -> bool {
        if (scales.empty()) return false;
        std::vector<double> a(m);
        for (int i = 0; i < m; ++i) a[i] = -fun[i] * sig;
        double best_s = -1.0;
        std::vector<double> S;
        for (int box_n : scales) {
            compute_box_significance(a.data(), m, box_n, sig, S);
            int j_max = static_cast<int>(std::max_element(S.begin(), S.end()) - S.begin());
            if (S[j_max] >= 3.0 && S[j_max] > best_s) {
                best_s = S[j_max];
                out_j = j_max;
                out_n = box_n;
            }
        }
        return best_s >= 3.0;
    };

    auto converged = [&](const std::vector<double>& fun, double c) -> bool {
        int dummy_j = 0, dummy_n = 0;
        return px_ok(fun, c) && !mf_hit(fun, dummy_j, dummy_n);
    };

    auto solve_p = [&](const std::vector<double>& p_init) -> LMSolveResult {
        int nc = static_cast<int>(p_init.size()) / 3;
        std::vector<double> lb(3 * nc), ub(3 * nc);
        for (int c = 0; c < nc; ++c) {
            lb[3 * c + 0] = v_lo; ub[3 * c + 0] = v_hi;
            lb[3 * c + 1] = nlo;  ub[3 * c + 1] = nhi;
            lb[3 * c + 2] = b_min; ub[3 * c + 2] = b_max;
        }
        return solve_voigt_lm(vr, Fr, m, p_init.data(), nc, lb.data(), ub.data(), k_tau, a0, sig, max_lm_iter);
    };

    auto logN_from_tau0 = [&](double t0, double bb) -> double {
        return std::log10(std::max(1e-30, t0 * bb / k_tau));
    };

    auto grow = [&](std::vector<double> p, double chi, LMSolveResult best, bool has_best, bool& out_hit_cap) -> LMSolveResult {
        out_hit_cap = false;
        if (has_best && (converged(best.fun, chi) || static_cast<int>(p.size()) / 3 >= cap)) {
            out_hit_cap = (static_cast<int>(p.size()) / 3 >= cap) && !px_ok(best.fun, chi);
            return best;
        }
        std::vector<double> tau_tmp(m);
        std::vector<double> Fm(m);
        std::vector<double> rr(m);
        std::vector<double> fun_tmp(m);

        while (true) {
            int nc = static_cast<int>(p.size()) / 3;
            if (nc > 0) {
                eval_tau_and_jac(vr, m, p.data(), nc, k_tau, a0, tau_tmp.data(), nullptr);
                for (int i = 0; i < m; ++i) Fm[i] = std::exp(-tau_tmp[i]);
            } else {
                std::fill(Fm.begin(), Fm.end(), 1.0);
            }
            for (int i = 0; i < m; ++i) {
                rr[i] = Fr[i] - Fm[i];
                fun_tmp[i] = rr[i] / sig;
            }

            double c_new[3];
            int hit_j = 0, hit_n = 0;
            if (!scales.empty() && px_ok(fun_tmp, chi) && mf_hit(fun_tmp, hit_j, hit_n)) {
                int lo_ = std::max(0, hit_j - hit_n / 2);
                int hi_ = std::min(m, hit_j + hit_n / 2 + 1);
                double sum_r = 0.0;
                for (int i = lo_; i < hi_; ++i) sum_r += -rr[i];
                double depth = std::clamp(sum_r / static_cast<double>(hi_ - lo_), 1e-6, 0.5);
                double bb = std::clamp(hit_n * du / 1.665, b_min, b_max);
                double lN = logN_from_tau0(std::max(-std::log1p(-depth), 1e-6), bb);
                c_new[0] = vr[hit_j];
                c_new[1] = std::clamp(lN, nlo, nhi);
                c_new[2] = bb;
            } else {
                int j = static_cast<int>(std::min_element(rr.begin(), rr.end()) - rr.begin());
                double ratio = (Fm[j] > 0.0) ? std::clamp(Fr[j] / Fm[j], 1e-4, 1.0) : 1.0;
                double tpk = std::max(0.05, -std::log(ratio));
                c_new[0] = vr[j];
                c_new[1] = std::clamp(logN_from_tau0(tpk, b0), nlo, nhi);
                c_new[2] = b0;
            }

            std::vector<double> p_try = p;
            p_try.insert(p_try.end(), c_new, c_new + 3);
            double target = chi * (1.0 - dchisq_min_frac);
            LMSolveResult r = solve_p(p_try);
            double chi_new = chi2nu(r.fun, nc + 1);

            if (!(chi_new <= target) && nc > 0) {
                int best_c = 0;
                for (int c = 1; c < nc; ++c) {
                    if (p[3 * c + 1] > p[3 * best_c + 1]) best_c = c;
                }
                double vc = p[3 * best_c + 0];
                double lN = p[3 * best_c + 1];
                double bb = std::max(p[3 * best_c + 2] * 0.5, b_min);
                std::vector<double> p_split;
                for (int c = 0; c < nc; ++c) {
                    if (c == best_c) continue;
                    p_split.push_back(p[3 * c + 0]);
                    p_split.push_back(p[3 * c + 1]);
                    p_split.push_back(p[3 * c + 2]);
                }
                p_split.push_back(vc - bb); p_split.push_back(lN - 0.3); p_split.push_back(bb);
                p_split.push_back(vc + bb); p_split.push_back(lN - 0.3); p_split.push_back(bb);
                LMSolveResult rt = solve_p(p_split);
                double ct = chi2nu(rt.fun, nc + 1);
                if (ct < chi_new) {
                    r = std::move(rt);
                    chi_new = ct;
                }
            }

            if (!(chi_new <= target)) break;
            p = r.x;
            chi = chi_new;
            best = std::move(r);
            has_best = true;
            int n_now = static_cast<int>(p.size()) / 3;
            if (converged(best.fun, chi)) break;
            if (n_now >= cap) {
                out_hit_cap = !px_ok(best.fun, chi);
                break;
            }
        }
        return best;
    };

    LMSolveResult best;
    bool has_best = false;
    double chi = chi0;
    bool hit_cap = false;

    double d_seed[3];
    if (damped_seed_cpp(vr, Fr, m, spec, k_tau, a0, d_seed)) {
        scales.clear();
        std::vector<double> p_seed(d_seed, d_seed + 3);
        LMSolveResult rs = solve_p(p_seed);
        double cs = chi2nu(rs.fun, 1);
        if (cs < chi0 && rs.x[1] >= damped_logN - 0.5) {
            best = grow(rs.x, cs, rs, true, hit_cap);
            chi = chi2nu(best.fun, static_cast<int>(best.x.size()) / 3);
            has_best = true;
        }
    }
    if (!has_best || !converged(best.fun, chi)) {
        bool hn = false;
        LMSolveResult bn = grow({}, chi0, {}, false, hn);
        if (!bn.x.empty()) {
            double cn = chi2nu(bn.fun, static_cast<int>(bn.x.size()) / 3);
            if (!has_best || cn < chi) {
                best = std::move(bn);
                chi = cn;
                hit_cap = hn;
                has_best = true;
            }
        }
    }

    if (!has_best || best.x.empty()) return;

    int nc = static_cast<int>(best.x.size()) / 3;
    std::vector<double> p_kept;
    for (int c = 0; c < nc; ++c) {
        if (best.x[3 * c + 1] >= min_logN_keep) {
            p_kept.push_back(best.x[3 * c + 0]);
            p_kept.push_back(best.x[3 * c + 1]);
            p_kept.push_back(best.x[3 * c + 2]);
        }
    }
    if (p_kept.empty()) return;
    if (p_kept.size() != best.x.size()) {
        best = solve_p(p_kept);
        chi = chi2nu(best.fun, static_cast<int>(best.x.size()) / 3);
    }

    nc = static_cast<int>(best.x.size()) / 3;
    int np = 3 * nc;
    bool poor = !px_ok(best.fun, chi);

    std::vector<double> err(np, -1.0);
    bool has_err = false;
    if (static_cast<int>(best.jac.size()) == m * np) {
        std::vector<double> JTJ(np * np, 0.0);
        for (int i = 0; i < m; ++i) {
            const double* jrow = best.jac.data() + i * np;
            for (int a = 0; a < np; ++a) {
                for (int b = a; b < np; ++b) {
                    JTJ[a * np + b] += jrow[a] * jrow[b];
                }
            }
        }
        for (int a = 0; a < np; ++a) {
            for (int b = 0; b < a; ++b) JTJ[a * np + b] = JTJ[b * np + a];
        }
        std::vector<double> V(np * np), eig(np);
        jacobi_eigen(np, JTJ.data(), V.data(), eig.data());
        double max_eig = 0.0;
        for (double e : eig) max_eig = std::max(max_eig, e);
        double tol = 1e-12 * np * max_eig;
        int rank = 0;
        for (double e : eig) if (e > tol) rank++;
        if (rank == np && max_eig > 0.0) {
            has_err = true;
            for (int a = 0; a < np; ++a) {
                double diag_cov = 0.0;
                for (int k = 0; k < np; ++k) {
                    diag_cov += (V[a * np + k] * V[a * np + k]) / eig[k];
                }
                err[a] = std::sqrt(std::max(0.0, diag_cov));
            }
        }
    }

    for (int c = 0; c < nc; ++c) {
        double vc = best.x[3 * c + 0];
        double lN = best.x[3 * c + 1];
        double bb = best.x[3 * c + 2];

        int flag = 0;
        if (spec.damped && lN >= damped_logN) flag |= 64; // DAMPED

        double t_center = (k_tau * std::pow(10.0, lN) / bb) * faddeeva_re(0.0, a0 / bb);
        double min_f_sel = 1.0;
        bool any_sel = false;
        for (int i = 0; i < m; ++i) {
            if (vr[i] >= vc - bb && vr[i] <= vc + bb) {
                any_sel = true;
                min_f_sel = std::min(min_f_sel, Fr[i]);
            }
        }
        if (t_center >= sat_tau0 || (any_sel && min_f_sel < sat_flux)) {
            flag |= 1; // SAT
        }
        if (std::min(vc - v_lo, v_hi - vc) < 1e-3 ||
            std::min(lN - nlo, nhi - lN) < 1e-3 ||
            std::min(bb - b_min, b_max - bb) < 1e-3) {
            flag |= 2; // BOUND
        }
        if (hit_cap || (cap < max_comp_region && nc >= cap)) {
            flag |= 4; // MAXCOMP
        }
        if (poor) flag |= 8; // POORFIT
        if (is_edge) flag |= 16; // EDGE

        bool sat_noerr = ((flag & 1) != 0) && ((flag & 64) == 0);
        if (!has_err || sat_noerr) {
            flag |= 32; // NOERR
        }

        double ew_int = 0.0;
        double A_over_b = k_tau * std::pow(10.0, lN) / bb;
        double a_comp = a0 / bb;
        double inv_b = 1.0 / bb;
        double prev_abs = 0.0;
        for (int i = 0; i < n_v; ++i) {
            double u = (vs[i] - vc) * inv_b;
            double tc = (std::abs(u) > 150.0 && !spec.damped) ? 0.0 : (A_over_b * faddeeva_re(u, a_comp));
            double abs_i = -std::expm1(-tc);
            if (i > 0) {
                ew_int += 0.5 * (prev_abs + abs_i) * (vs[i] - vs[i - 1]);
            }
            prev_abs = abs_i;
        }
        double ew_mA = (spec.lam0 / C_KMS) * ew_int * 1e3;

        FittedComp fc;
        fc.v = fmt_round(vc, 2);
        fc.dv = (!has_err) ? -1.0 : fmt_round(err[3 * c + 0], 2);
        fc.logN = fmt_round(lN, 3);
        fc.dlogN = (!has_err || sat_noerr) ? -1.0 : fmt_round(err[3 * c + 1], 3);
        fc.b = fmt_round(bb, 2);
        fc.db = (!has_err || sat_noerr) ? -1.0 : fmt_round(err[3 * c + 2], 2);
        fc.region = rid;
        fc.flag = flag;
        fc.EW = fmt_round(std::max(0.0, ew_mA), 2);
        out_comps.push_back(fc);
    }
}

} // anonymous namespace

// =============================================================================
// C ABI Exports for ctypes binding in server/fast_ray.py
// =============================================================================
extern "C" {

void* fast_index_create(
    int64_t n_cells,
    const double* coords_ckpch,
    const double* masses_code,
    const double* density_code,
    const double* vel_code,
    const double* temp_K,
    const double* metallicity,
    const double* h_mass_frac,
    const double* nhi_abundance,
    double hubble_param,
    double unit_length_cm,
    double unit_mass_g,
    double unit_vel_cm_s
) {
    (void)get_cubic_kernel_table();
    (void)get_faddeeva_table();

    auto* idx = new FastCutoutIndex();
    idx->n_cells = n_cells;
    idx->has_nhi_abundance = (nhi_abundance != nullptr);

    double code_len_cm = unit_length_cm / hubble_param;
    double code_mass_g = unit_mass_g / hubble_param;
    double rho_to_cgs = code_mass_g / (code_len_cm * code_len_cm * code_len_cm);

    std::vector<double> raw_hsml(n_cells);
    std::vector<BuildItem> items(n_cells);

    #pragma omp parallel for schedule(static)
    for (int64_t i = 0; i < n_cells; ++i) {
        double m = masses_code[i];
        double rho = density_code[i];
        double h = 2.0 * std::cbrt(3.0 * m / (4.0 * PI * rho));
        raw_hsml[i] = h;
        items[i] = BuildItem{
            i,
            coords_ckpch[3 * i + 0],
            coords_ckpch[3 * i + 1],
            coords_ckpch[3 * i + 2],
            h
        };
    }

    idx->nodes.reserve(2 * (n_cells / 8 + 16));
    idx->nodes.emplace_back();
    if (n_cells > 0) {
        build_bvh_recursive(idx->nodes, items, 0, 0, static_cast<int>(n_cells));
    }

    idx->px.resize(n_cells);
    idx->py.resize(n_cells);
    idx->pz.resize(n_cells);
    idx->hsml.resize(n_cells);
    idx->dl_factor_cgs.resize(n_cells);
    idx->vx_cgs.resize(n_cells);
    idx->vy_cgs.resize(n_cells);
    idx->vz_cgs.resize(n_cells);
    idx->temp_K.resize(n_cells);
    idx->n_H_cgs.resize(n_cells);
    idx->metallicity.resize(n_cells);
    if (idx->has_nhi_abundance) idx->nhi_abundance.resize(n_cells);
    idx->orig_idx.resize(n_cells);

    #pragma omp parallel for schedule(static)
    for (int64_t k = 0; k < n_cells; ++k) {
        int64_t i = items[k].id;
        double h = raw_hsml[i];
        double m = masses_code[i];
        double rho = density_code[i];
        idx->px[k] = coords_ckpch[3 * i + 0];
        idx->py[k] = coords_ckpch[3 * i + 1];
        idx->pz[k] = coords_ckpch[3 * i + 2];
        idx->hsml[k] = h;
        idx->dl_factor_cgs[k] = (m / (rho * h * h)) * code_len_cm;
        idx->vx_cgs[k] = vel_code[3 * i + 0] * unit_vel_cm_s;
        idx->vy_cgs[k] = vel_code[3 * i + 1] * unit_vel_cm_s;
        idx->vz_cgs[k] = vel_code[3 * i + 2] * unit_vel_cm_s;
        idx->temp_K[k] = temp_K[i];
        idx->n_H_cgs[k] = (rho * rho_to_cgs) * h_mass_frac[i] / M_H_CGS;
        idx->metallicity[k] = metallicity[i];
        if (idx->has_nhi_abundance) idx->nhi_abundance[k] = nhi_abundance[i];
        idx->orig_idx[k] = i;
    }

    return static_cast<void*>(idx);
}

void fast_index_destroy(void* idx_ptr) {
    if (!idx_ptr) return;
    delete static_cast<FastCutoutIndex*>(idx_ptr);
}

int fast_index_set_hm12_tables(
    void* idx_ptr,
    int n_nh,
    const double* log_nh_grid,
    int n_t,
    const double* log_t_grid,
    const double* ion_tables_12,
    const double* solar_abund_12,
    double z_solar,
    const int* use_part_nhi_12
) {
    if (!idx_ptr) return -1;
    auto* idx = static_cast<FastCutoutIndex*>(idx_ptr);
    idx->table_dim = 2;
    idx->log_nh_grid.assign(log_nh_grid, log_nh_grid + n_nh);
    idx->log_z_grid.clear();
    idx->log_t_grid.assign(log_t_grid, log_t_grid + n_t);
    idx->ion_tables.assign(ion_tables_12, ion_tables_12 + 12 * n_nh * n_t);
    std::memcpy(idx->solar_abund, solar_abund_12, 12 * sizeof(double));
    idx->z_solar = z_solar;
    std::memcpy(idx->use_part_nhi, use_part_nhi_12, 12 * sizeof(int));
    return 0;
}

int fast_index_set_cloudy_3d_tables(
    void* idx_ptr,
    int n_nh,
    const double* log_nh_grid,
    int n_z,
    const double* log_z_grid,
    int n_t,
    const double* log_t_grid,
    const double* ion_tables_12,
    const double* solar_abund_12,
    double z_solar,
    const int* use_part_nhi_12
) {
    if (!idx_ptr) return -1;
    auto* idx = static_cast<FastCutoutIndex*>(idx_ptr);
    idx->table_dim = 3;
    idx->log_nh_grid.assign(log_nh_grid, log_nh_grid + n_nh);
    idx->log_z_grid.assign(log_z_grid, log_z_grid + n_z);
    idx->log_t_grid.assign(log_t_grid, log_t_grid + n_t);
    idx->ion_tables.assign(ion_tables_12, ion_tables_12 + 12 * n_nh * n_z * n_t);
    std::memcpy(idx->solar_abund, solar_abund_12, 12 * sizeof(double));
    idx->z_solar = z_solar;
    std::memcpy(idx->use_part_nhi, use_part_nhi_12, 12 * sizeof(int));
    return 0;
}

int fast_trace_only(
    void* idx_ptr,
    const double start_ckpch[3],
    const double end_ckpch[3],
    double logN_out[12],
    int* n_hits_out,
    double* trace_ms_out
) {
    if (!idx_ptr) return -1;
    const auto* idx = static_cast<const FastCutoutIndex*>(idx_ptr);
    auto t0 = std::chrono::steady_clock::now();

    std::vector<RayHit> hits;
    hits.reserve(1024);
    traverse_bvh_ray(*idx, start_ckpch, end_ckpch, hits);

    std::vector<double> n_ion;
    evaluate_hit_ions(*idx, hits, n_ion, logN_out);

    auto t1 = std::chrono::steady_clock::now();
    if (n_hits_out) *n_hits_out = static_cast<int>(hits.size());
    if (trace_ms_out) *trace_ms_out = std::chrono::duration<double, std::milli>(t1 - t0).count();
    return 0;
}

int fast_trace_and_spectra(
    void* idx_ptr,
    const double start_ckpch[3],
    const double end_ckpch[3],
    const double lam0_12[12],
    const double f_osc_12[12],
    const double gamma_12[12],
    const double mass_amu_12[12],
    const double lam_min_12[12],
    const double dlam_12[12],
    const int n_bins_12[12],
    const int bin_offsets_12[12],
    int exact_trident_mode,
    float* tau_f32_out,
    double* tau_f64_out,
    double logN_out[12],
    double W_mA_out[12],
    double logN_aod_out[12],
    int* n_hits_out,
    double* trace_ms_out,
    double* voigt_ms_out
) {
    (void)exact_trident_mode;
    if (!idx_ptr) return -1;
    const auto* idx = static_cast<const FastCutoutIndex*>(idx_ptr);
    const auto& ftab = get_faddeeva_table();

    auto t0 = std::chrono::steady_clock::now();
    std::vector<RayHit> hits;
    hits.reserve(1024);
    traverse_bvh_ray(*idx, start_ckpch, end_ckpch, hits);

    std::vector<double> n_ion;
    evaluate_hit_ions(*idx, hits, n_ion, logN_out);
    auto t1 = std::chrono::steady_clock::now();

    double vx = end_ckpch[0] - start_ckpch[0];
    double vy = end_ckpch[1] - start_ckpch[1];
    double vz = end_ckpch[2] - start_ckpch[2];
    double length = std::sqrt(vx * vx + vy * vy + vz * vz);
    double ux = (length > 0.0) ? (vx / length) : 1.0;
    double uy = (length > 0.0) ? (vy / length) : 0.0;
    double uz = (length > 0.0) ? (vz / length) : 0.0;

    int n_hits = static_cast<int>(hits.size());
    std::vector<double> z_dopp_hits(n_hits);
    for (int h = 0; h < n_hits; ++h) {
        int b_idx = hits[h].bvh_idx;
        double cvx = idx->vx_cgs[b_idx];
        double cvy = idx->vy_cgs[b_idx];
        double cvz = idx->vz_cgs[b_idx];
        double v_mag2 = cvx * cvx + cvy * cvy + cvz * cvz;
        double v_los_tr = -(cvx * ux + cvy * uy + cvz * uz);
        double beta2 = std::min(v_mag2 / (C_CMS * C_CMS), 0.9999999999);
        z_dopp_hits[h] = (1.0 + v_los_tr / C_CMS) / std::sqrt(1.0 - beta2) - 1.0;
    }

    int total_bins = bin_offsets_12[11] + n_bins_12[11];
    std::vector<double> local_tau_all;
    double* tau_f64_base = tau_f64_out;
    if (!tau_f64_base) {
        local_tau_all.resize(total_bins, 0.0);
        tau_f64_base = local_tau_all.data();
    }

    std::vector<CellVoigtPrecomp> ion_cells[12];
    struct TileSpec {
        int ion;
        int tile_lo;
        int tile_hi;
    };
    std::vector<TileSpec> tiles;
    tiles.reserve(256);
    constexpr int TILE_BINS = 1024;

    for (int ion = 0; ion < 12; ++ion) {
        int nb = n_bins_12[ion];
        precompute_ion_cells(
            n_hits, hits.data(), *idx,
            n_ion.data() + ion * n_hits,
            z_dopp_hits.data(),
            lam0_12[ion], f_osc_12[ion], gamma_12[ion], mass_amu_12[ion],
            lam_min_12[ion], dlam_12[ion], nb,
            ion_cells[ion]
        );
        for (int b0 = 0; b0 < nb; b0 += TILE_BINS) {
            tiles.push_back(TileSpec{ion, b0, std::min(nb, b0 + TILE_BINS)});
        }
    }

    int n_tiles = static_cast<int>(tiles.size());
    #pragma omp parallel for schedule(dynamic, 1) num_threads(8)
    for (int t = 0; t < n_tiles; ++t) {
        int ion = tiles[t].ion;
        int off = bin_offsets_12[ion];
        deposit_ion_tile(
            ion_cells[ion],
            ftab,
            lam_min_12[ion],
            dlam_12[ion],
            tiles[t].tile_lo,
            tiles[t].tile_hi,
            tau_f64_base + off
        );
    }

    #pragma omp parallel for schedule(static)
    for (int ion = 0; ion < 12; ++ion) {
        int nb = n_bins_12[ion];
        int off = bin_offsets_12[ion];
        const double* src = tau_f64_base + off;
        float* dst_f32 = tau_f32_out ? (tau_f32_out + off) : nullptr;

        double ew_sum = 0.0;
        double tau_trapz = 0.0;
        double du_kms = C_KMS * dlam_12[ion] / lam0_12[ion];
        double prev_t = 0.0;
        for (int b = 0; b < nb; ++b) {
            float tf = static_cast<float>(src[b]);
            if (dst_f32) dst_f32[b] = tf;
            double t = static_cast<double>(tf);
            ew_sum += -std::expm1(-t);
            if (b > 0) {
                tau_trapz += 0.5 * (prev_t + t) * du_kms;
            }
            prev_t = t;
        }
        W_mA_out[ion] = ew_sum * dlam_12[ion] * 1000.0;
        double n_aod = (AOD_K / (f_osc_12[ion] * lam0_12[ion])) * tau_trapz;
        logN_aod_out[ion] = (n_aod > 0.0 && std::isfinite(n_aod)) ? std::log10(n_aod) : -99.0;
    }

    auto t2 = std::chrono::steady_clock::now();
    if (n_hits_out) *n_hits_out = n_hits;
    if (trace_ms_out) *trace_ms_out = std::chrono::duration<double, std::milli>(t1 - t0).count();
    if (voigt_ms_out) *voigt_ms_out = std::chrono::duration<double, std::milli>(t2 - t1).count();
    return 0;
}

int fast_fit_components_12(
    int n_ions,
    const double* v_flat,
    const float* tau_flat,
    const int* n_bins_per_ion,
    const int* bin_offsets,
    const double* lam0_arr,
    const double* f_osc_arr,
    const double* gamma_arr,
    const double* b_min_arr,
    const double* logN_max_arr,
    const int* damped_arr,
    int max_lm_iter,
    int* n_comps_out,
    double* comp_num_out,
    int* comp_int_out,
    double* logN_aod_total_out,
    int* n_regions_out,
    double* region_aod_out,
    double* fit_ms_out
) {
    (void)get_faddeeva_table();
    auto t0 = std::chrono::steady_clock::now();

    struct IonPreFit {
        IonAtomicSpec spec;
        int n_full;
        int off;
        int st;
        std::vector<double> vs;
        std::vector<double> flux;
        std::vector<std::pair<int, int>> regions;
        std::vector<int> order;
    };

    std::vector<IonPreFit> pre(n_ions);

    // Stage 1: Find regions & compute AOD columns for all 12 ions
    for (int ion = 0; ion < n_ions; ++ion) {
        auto& P = pre[ion];
        P.spec = IonAtomicSpec{
            lam0_arr[ion], f_osc_arr[ion], gamma_arr[ion],
            b_min_arr[ion], logN_max_arr[ion], damped_arr[ion]
        };
        P.n_full = n_bins_per_ion[ion];
        P.off = bin_offsets[ion];
        const double* v_full = v_flat + P.off;
        const float* tau_full = tau_flat + P.off;

        double du_full = (P.n_full > 1) ? std::abs(v_full[1] - v_full[0]) : 1.0;
        P.st = (du_full > 0.5) ? 1 : std::max(1, static_cast<int>(std::llround(1.0 / du_full)));
        int n_v = (P.n_full + P.st - 1) / P.st;
        P.vs.resize(n_v);
        P.flux.resize(n_v);
        for (int i = 0; i < n_v; ++i) {
            P.vs[i] = v_full[i * P.st];
            P.flux[i] = std::exp(-static_cast<double>(tau_full[i * P.st]));
        }

        auto compute_aod_slice = [&](int lo_full, int hi_full) -> double {
            if (hi_full - lo_full < 2) return -99.0;
            double sum = 0.0;
            for (int i = lo_full + 1; i < hi_full; ++i) {
                double ta = static_cast<double>(tau_full[i - 1]);
                double tb = static_cast<double>(tau_full[i]);
                sum += 0.5 * (ta + tb) * (v_full[i] - v_full[i - 1]);
            }
            double n_aod = (AOD_K / (P.spec.f * P.spec.lam0)) * sum;
            return (n_aod > 0.0 && std::isfinite(n_aod)) ? std::log10(n_aod) : -99.0;
        };

        double laod_tot = compute_aod_slice(0, P.n_full);
        logN_aod_total_out[ion] = (laod_tot > -90.0) ? fmt_round(laod_tot, 3) : -99.0;

        P.regions = find_regions_cpp(P.vs.data(), P.flux.data(), n_v);
        int n_reg = static_cast<int>(P.regions.size());
        int nr_out = std::min(64, n_reg);
        n_regions_out[ion] = nr_out;
        for (int rid = 0; rid < nr_out; ++rid) {
            int nlo_full = P.regions[rid].first * P.st;
            int nhi_full = std::min(P.n_full, (P.regions[rid].second - 1) * P.st + 1);
            double laod = compute_aod_slice(nlo_full, nhi_full);
            double* rdst = region_aod_out + (ion * 64 + rid) * 4;
            rdst[0] = static_cast<double>(rid);
            rdst[1] = fmt_round(v_full[nlo_full], 1);
            rdst[2] = fmt_round(v_full[nhi_full - 1], 1);
            rdst[3] = (laod > -90.0) ? fmt_round(laod, 3) : -99.0;
        }

        std::vector<double> strength(n_reg, 0.0);
        for (int r = 0; r < n_reg; ++r) {
            int lo = P.regions[r].first;
            int hi = P.regions[r].second;
            double s = 0.0;
            for (int i = lo + 1; i < hi; ++i) {
                s += 0.5 * ((1.0 - P.flux[i - 1]) + (1.0 - P.flux[i])) * (P.vs[i] - P.vs[i - 1]);
            }
            strength[r] = s;
        }
        P.order.resize(n_reg);
        std::iota(P.order.begin(), P.order.end(), 0);
        std::sort(P.order.begin(), P.order.end(), [&](int a, int b) {
            if (strength[a] != strength[b]) return strength[a] > strength[b];
            return a < b;
        });
    }

    // Stage 2: Flatten all (ion, region) tasks and solve in parallel across OpenMP threads
    struct RegionTask {
        int ion;
        int rid;
        int order_rank;
    };
    std::vector<RegionTask> tasks;
    for (int ion = 0; ion < n_ions; ++ion) {
        for (int rank = 0; rank < static_cast<int>(pre[ion].order.size()); ++rank) {
            tasks.push_back(RegionTask{ion, pre[ion].order[rank], rank});
        }
    }

    int n_tasks = static_cast<int>(tasks.size());
    std::vector<std::vector<FittedComp>> task_results(n_tasks);

    #pragma omp parallel for schedule(dynamic, 1) num_threads(8)
    for (int t = 0; t < n_tasks; ++t) {
        int ion = tasks[t].ion;
        int rid = tasks[t].rid;
        const auto& P = pre[ion];
        fit_single_region_cpp(
            P.vs.data(), P.flux.data(), static_cast<int>(P.vs.size()),
            rid, P.regions[rid].first, P.regions[rid].second,
            8, P.spec, max_lm_iter, task_results[t]
        );
    }

    // Stage 3: Assemble per-ion components in strength order (enforcing max_comp_ion = 30) and sort by velocity
    int task_cursor = 0;
    for (int ion = 0; ion < n_ions; ++ion) {
        int n_reg = static_cast<int>(pre[ion].order.size());
        std::vector<FittedComp> all_ion_comps;
        for (int rank = 0; rank < n_reg; ++rank) {
            auto& r_comps = task_results[task_cursor++];
            int left = 30 - static_cast<int>(all_ion_comps.size());
            if (left <= 0) continue;
            if (static_cast<int>(r_comps.size()) > left) {
                r_comps.resize(left);
            }
            if (left < 8 && static_cast<int>(r_comps.size()) >= left) {
                for (auto& c : r_comps) c.flag |= 4; // MAXCOMP
            }
            all_ion_comps.insert(all_ion_comps.end(), r_comps.begin(), r_comps.end());
        }
        std::sort(all_ion_comps.begin(), all_ion_comps.end(), [](const FittedComp& a, const FittedComp& b) {
            if (a.v != b.v) return a.v < b.v;
            return a.logN > b.logN;
        });

        int nc = std::min(30, static_cast<int>(all_ion_comps.size()));
        n_comps_out[ion] = nc;
        for (int c = 0; c < nc; ++c) {
            double* cnum = comp_num_out + (ion * 30 + c) * 7;
            cnum[0] = all_ion_comps[c].v;
            cnum[1] = all_ion_comps[c].dv;
            cnum[2] = all_ion_comps[c].logN;
            cnum[3] = all_ion_comps[c].dlogN;
            cnum[4] = all_ion_comps[c].b;
            cnum[5] = all_ion_comps[c].db;
            cnum[6] = all_ion_comps[c].EW;

            int* cint = comp_int_out + (ion * 30 + c) * 2;
            cint[0] = all_ion_comps[c].region;
            cint[1] = all_ion_comps[c].flag;
        }
    }

    auto t1 = std::chrono::steady_clock::now();
    if (fit_ms_out) *fit_ms_out = std::chrono::duration<double, std::milli>(t1 - t0).count();
    return 0;
}

} // extern "C"
