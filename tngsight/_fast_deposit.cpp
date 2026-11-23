#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <immintrin.h>
#include <omp.h>
#include <vector>

namespace {

inline double w_scalar(double q) noexcept {
    if (q <= 0.5) {
        volatile double six_q2 = 6.0 * q * q;
        volatile double six_q3 = six_q2 * q;
        return (1.0 - six_q2) + six_q3;
    }
    if (q < 1.0) {
        double t = 1.0 - q;
        return 2.0 * t * t * t;
    }
    return 0.0;
}

#if defined(__AVX2__)
inline __m256d w_vec4(__m256d q) noexcept {
    const __m256d zero = _mm256_setzero_pd();
    const __m256d half = _mm256_set1_pd(0.5);
    const __m256d one  = _mm256_set1_pd(1.0);
    const __m256d two  = _mm256_set1_pd(2.0);
    const __m256d six  = _mm256_set1_pd(6.0);

    // t = max(1.0 - q, 0.0)
    __m256d t = _mm256_max_pd(_mm256_sub_pd(one, q), zero);
    __m256d t2 = _mm256_mul_pd(t, t);
    __m256d outer = _mm256_mul_pd(two, _mm256_mul_pd(t2, t));

    // inner = 1.0 - 6*q^2 + 6*q^3 (matching NumPy: 1.0 - 6.0*q*q + 6.0*q*q*q)
    __m256d six_q = _mm256_mul_pd(six, q);
    volatile __m256d six_q2 = _mm256_mul_pd(six_q, q);
    __m256d six_q2_v = six_q2;
    volatile __m256d six_q3 = _mm256_mul_pd(six_q2_v, q);
    __m256d inner = _mm256_add_pd(_mm256_sub_pd(one, six_q2_v), six_q3);

    __m256d mask_le_half = _mm256_cmp_pd(q, half, _CMP_LE_OQ);
    return _mm256_blendv_pd(outer, inner, mask_le_half);
}
#endif

struct StencilTable {
    struct Offset {
        int32_t ox, oy, oz;
    };
    std::vector<Offset> table[65];
    int32_t center_idx[65];

    StencilTable() {
        center_idx[0] = 0;
        for (int k = 1; k <= 64; ++k) {
            int lim = (k + 1) * (k + 1);
            int32_t c_idx = 0;
            int32_t idx = 0;
            for (int ox = -k; ox <= k; ++ox) {
                for (int oy = -k; oy <= k; ++oy) {
                    for (int oz = -k; oz <= k; ++oz) {
                        if (ox * ox + oy * oy + oz * oz <= lim) {
                            if (ox == 0 && oy == 0 && oz == 0) {
                                c_idx = idx;
                            }
                            table[k].push_back({ox, oy, oz});
                            ++idx;
                        }
                    }
                }
            }
            center_idx[k] = c_idx;
        }
    }
};

static const StencilTable STENCILS;

inline void build_offsets_dynamic(int k, std::vector<StencilTable::Offset>& out, int32_t& c_idx) {
    int lim = (k + 1) * (k + 1);
    c_idx = 0;
    int32_t idx = 0;
    out.clear();
    for (int ox = -k; ox <= k; ++ox) {
        for (int oy = -k; oy <= k; ++oy) {
            for (int oz = -k; oz <= k; ++oz) {
                if (ox * ox + oy * oy + oz * oz <= lim) {
                    if (ox == 0 && oy == 0 && oz == 0) {
                        c_idx = idx;
                    }
                    out.push_back({ox, oy, oz});
                    ++idx;
                }
            }
        }
    }
}

}  // namespace

extern "C" {

/**
 * Compute number of stencil offsets for a given k: o in [-k, k]^3 with |o|^2 <= (k+1)^2.
 */
int64_t fast_n_offsets(int32_t k) {
    if (k >= 1 && k <= 64) {
        return static_cast<int64_t>(STENCILS.table[k].size());
    }
    int lim = (k + 1) * (k + 1);
    int64_t count = 0;
    for (int ox = -k; ox <= k; ++ox) {
        for (int oy = -k; oy <= k; ++oy) {
            for (int oz = -k; oz <= k; ++oz) {
                if (ox * ox + oy * oy + oz * oz <= lim) {
                    ++count;
                }
            }
        }
    }
    return count;
}

/**
 * Multi-threaded OpenMP + AVX2 3D SPH cubic-spline multi-level scatter accumulation.
 *
 * Uses active-level lazy allocation (only allocating thread-local buffers for lattice levels m
 * actually populated in a thread's slice, with voxel-major (n_m^3, nq) layout for single-cache-line
 * multi-field updates).
 */
void fast_sph_accumulate(
    const double* __restrict__ pos,
    const double* __restrict__ heff,
    const int64_t* __restrict__ m_arr,
    const int64_t* __restrict__ k_arr,
    const double* __restrict__ dxm_arr,
    const double* __restrict__ qarr,
    int64_t N,
    int64_t nq,
    int32_t n,
    double half_kpc,
    int32_t m_max,
    int32_t n_threads,
    double* __restrict__ acc_buf,
    double* __restrict__ f_out
) {
    if (N <= 0 || nq <= 0) return;

    std::vector<int64_t> level_offsets(m_max + 2, 0);
    std::vector<int64_t> level_cells(m_max + 1, 0);
    int64_t total_cells_all_levels = 0;
    for (int32_t mm = 0; mm <= m_max; ++mm) {
        int64_t nm = static_cast<int64_t>(n >> mm);
        int64_t sz = nm * nm * nm;
        level_cells[mm] = sz;
        level_offsets[mm] = total_cells_all_levels * nq;
        total_cells_all_levels += sz;
    }

    int num_workers = (n_threads > 1 && N >= 2) ? n_threads : 1;
    std::vector<int64_t> bounds(num_workers + 1, 0);
    if (num_workers == 1) {
        bounds[0] = 0;
        bounds[1] = N;
    } else {
        std::vector<int64_t> cum_pairs(N);
        int64_t running = 0;
        for (int64_t i = 0; i < N; ++i) {
            running += fast_n_offsets(static_cast<int32_t>(k_arr[i]));
            cum_pairs[i] = running;
        }
        int64_t total_pairs = running;
        bounds[0] = 0;
        for (int w = 1; w < num_workers; ++w) {
            double target = static_cast<double>(total_pairs) * static_cast<double>(w) / static_cast<double>(num_workers);
            int64_t lo = 0, hi = N;
            while (lo < hi) {
                int64_t mid = lo + (hi - lo) / 2;
                if (static_cast<double>(cum_pairs[mid]) < target) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            bounds[w] = lo;
        }
        bounds[num_workers] = N;
        for (int w = 1; w <= num_workers; ++w) {
            if (bounds[w] < bounds[w - 1]) bounds[w] = bounds[w - 1];
            if (bounds[w] > N) bounds[w] = N;
        }
    }

    auto compute_particle_weights = [&](
        int64_t i,
        std::vector<double>& w_buf,
        std::vector<int64_t>& flat_buf,
        std::vector<StencilTable::Offset>& dyn_offsets,
        int32_t& mm_out,
        int32_t& n_keep_out
    ) {
        const int32_t mm = static_cast<int32_t>(m_arr[i]);
        const int32_t kk = static_cast<int32_t>(k_arr[i]);
        const double dxm = dxm_arr[i];
        const double he = heff[i];
        const int32_t nm = n >> mm;
        mm_out = mm;

        const double px = pos[3 * i + 0];
        const double py = pos[3 * i + 1];
        const double pz = pos[3 * i + 2];

        const double gx = (px + half_kpc) / dxm - 0.5;
        const double gy = (py + half_kpc) / dxm - 0.5;
        const double gz = (pz + half_kpc) / dxm - 0.5;

        const int32_t cx = static_cast<int32_t>(std::nearbyint(gx));
        const int32_t cy = static_cast<int32_t>(std::nearbyint(gy));
        const int32_t cz = static_cast<int32_t>(std::nearbyint(gz));

        const StencilTable::Offset* offsets_ptr = nullptr;
        int32_t n_off = 0;
        int32_t c_idx = 0;
        if (kk >= 1 && kk <= 64) {
            offsets_ptr = STENCILS.table[kk].data();
            n_off = static_cast<int32_t>(STENCILS.table[kk].size());
            c_idx = STENCILS.center_idx[kk];
        } else {
            build_offsets_dynamic(kk, dyn_offsets, c_idx);
            offsets_ptr = dyn_offsets.data();
            n_off = static_cast<int32_t>(dyn_offsets.size());
        }

        if (static_cast<int32_t>(w_buf.size()) < n_off) {
            w_buf.resize(n_off);
            flat_buf.resize(n_off);
        }

        double S = 0.0;
        int32_t s = 0;

#if defined(__AVX2__)
        const __m256d v_gx = _mm256_set1_pd(gx);
        const __m256d v_gy = _mm256_set1_pd(gy);
        const __m256d v_gz = _mm256_set1_pd(gz);
        const __m256d v_dxm = _mm256_set1_pd(dxm);
        const __m256d v_he = _mm256_set1_pd(he);

        for (; s + 4 <= n_off; s += 4) {
            __m256d v_ix = _mm256_set_pd(
                static_cast<double>(cx + offsets_ptr[s + 3].ox),
                static_cast<double>(cx + offsets_ptr[s + 2].ox),
                static_cast<double>(cx + offsets_ptr[s + 1].ox),
                static_cast<double>(cx + offsets_ptr[s + 0].ox)
            );
            __m256d v_iy = _mm256_set_pd(
                static_cast<double>(cy + offsets_ptr[s + 3].oy),
                static_cast<double>(cy + offsets_ptr[s + 2].oy),
                static_cast<double>(cy + offsets_ptr[s + 1].oy),
                static_cast<double>(cy + offsets_ptr[s + 0].oy)
            );
            __m256d v_iz = _mm256_set_pd(
                static_cast<double>(cz + offsets_ptr[s + 3].oz),
                static_cast<double>(cz + offsets_ptr[s + 2].oz),
                static_cast<double>(cz + offsets_ptr[s + 1].oz),
                static_cast<double>(cz + offsets_ptr[s + 0].oz)
            );

            __m256d ddx = _mm256_mul_pd(_mm256_sub_pd(v_ix, v_gx), v_dxm);
            __m256d ddy = _mm256_mul_pd(_mm256_sub_pd(v_iy, v_gy), v_dxm);
            __m256d ddz = _mm256_mul_pd(_mm256_sub_pd(v_iz, v_gz), v_dxm);

            volatile __m256d dx2_v = _mm256_mul_pd(ddx, ddx);
            volatile __m256d dy2_v = _mm256_mul_pd(ddy, ddy);
            volatile __m256d dz2_v = _mm256_mul_pd(ddz, ddz);
            __m256d r2 = _mm256_add_pd(_mm256_add_pd(dx2_v, dy2_v), dz2_v);
            __m256d q = _mm256_div_pd(_mm256_sqrt_pd(r2), v_he);
            __m256d wv = w_vec4(q);
            _mm256_storeu_pd(&w_buf[s], wv);
            S += (w_buf[s] + w_buf[s + 1]) + (w_buf[s + 2] + w_buf[s + 3]);
        }
#endif
        for (; s < n_off; ++s) {
            int32_t ix = cx + offsets_ptr[s].ox;
            int32_t iy = cy + offsets_ptr[s].oy;
            int32_t iz = cz + offsets_ptr[s].oz;
            double ddx = (static_cast<double>(ix) - gx) * dxm;
            double ddy = (static_cast<double>(iy) - gy) * dxm;
            double ddz = (static_cast<double>(iz) - gz) * dxm;
            volatile double dx2 = ddx * ddx;
            volatile double dy2 = ddy * ddy;
            volatile double dz2 = ddz * ddz;
            double r2 = (dx2 + dy2) + dz2;
            double r = std::sqrt(r2);
            double w = w_scalar(r / he);
            w_buf[s] = w;
            S += w;
        }

        if (S <= 0.0) {
            w_buf[c_idx] = 1.0;
            S = 1.0;
        }

        double f_in = 0.0;
        int32_t n_keep = 0;
        for (int32_t idx = 0; idx < n_off; ++idx) {
            int32_t ix = cx + offsets_ptr[idx].ox;
            int32_t iy = cy + offsets_ptr[idx].oy;
            int32_t iz = cz + offsets_ptr[idx].oz;
            if (static_cast<uint32_t>(ix) < static_cast<uint32_t>(nm) &&
                static_cast<uint32_t>(iy) < static_cast<uint32_t>(nm) &&
                static_cast<uint32_t>(iz) < static_cast<uint32_t>(nm)) {
                double wn = w_buf[idx] / S;
                f_in += wn;
                if (wn > 0.0) {
                    w_buf[n_keep] = wn;
                    flat_buf[n_keep] = (static_cast<int64_t>(ix) * nm + iy) * nm + iz;
                    ++n_keep;
                }
            }
        }
        f_out[i] = f_in;
        n_keep_out = n_keep;
    };

    if (num_workers == 1) {
        std::vector<double> w_buf;
        std::vector<int64_t> flat_buf;
        std::vector<StencilTable::Offset> dyn_offsets;
        for (int64_t i = 0; i < N; ++i) {
            int32_t mm = 0, n_keep = 0;
            compute_particle_weights(i, w_buf, flat_buf, dyn_offsets, mm, n_keep);
            if (n_keep > 0) {
                double* __restrict__ level_base = acc_buf + level_offsets[mm];
                const int64_t level_stride = level_cells[mm];
                const double* __restrict__ qi = qarr + i * nq;
                for (int64_t j = 0; j < nq; ++j) {
                    const double qval = qi[j];
                    if (qval == 0.0) continue;
                    double* __restrict__ grid_j = level_base + j * level_stride;
                    for (int32_t idx = 0; idx < n_keep; ++idx) {
                        grid_j[flat_buf[idx]] += w_buf[idx] * qval;
                    }
                }
            }
        }
    } else {
        // Field-parallel accumulation: each thread owns a disjoint subset of fields j in [0, nq),
        // writing directly into acc_buf with zero thread-local grid buffers and zero merge overhead!
        int64_t total_runs = 0;
        for (int64_t a = 0; a < N; ) {
            int64_t b = a + 1;
            while (b < N && m_arr[b] == m_arr[a] && k_arr[b] == k_arr[a]) ++b;
            int32_t n_off = static_cast<int32_t>(fast_n_offsets(static_cast<int32_t>(k_arr[a])));
            int64_t step = std::max<int64_t>(1, (1 << 19) / std::max<int32_t>(1, n_off));
            total_runs += ((b - a) + step - 1) / step;
            a = b;
        }

        struct BlockRange {
            int64_t c0, c1;
            int32_t mm, kk, n_off;
        };
        std::vector<BlockRange> blocks;
        blocks.reserve(total_runs);
        for (int64_t a = 0; a < N; ) {
            int64_t b = a + 1;
            while (b < N && m_arr[b] == m_arr[a] && k_arr[b] == k_arr[a]) ++b;
            int32_t mm = static_cast<int32_t>(m_arr[a]);
            int32_t kk = static_cast<int32_t>(k_arr[a]);
            int32_t n_off = static_cast<int32_t>(fast_n_offsets(kk));
            int64_t step = std::max<int64_t>(1, (1 << 19) / std::max<int32_t>(1, n_off));
            for (int64_t c0 = a; c0 < b; c0 += step) {
                blocks.push_back({c0, std::min(b, c0 + step), mm, kk, n_off});
            }
            a = b;
        }

        // Process blocks: compute weights in parallel across particles, then accumulate in parallel across fields
        std::vector<double> blk_w;
        std::vector<int32_t> blk_flat;
        std::vector<int32_t> blk_nkeep;
        std::vector<int64_t> part_offsets;

        for (const auto& blk : blocks) {
            const int64_t P = blk.c1 - blk.c0;
            const int32_t n_off = blk.n_off;
            const int32_t mm = blk.mm;
            if (static_cast<int64_t>(blk_w.size()) < P * n_off) {
                blk_w.resize(P * n_off);
                blk_flat.resize(P * n_off);
            }
            if (static_cast<int64_t>(blk_nkeep.size()) < P) {
                blk_nkeep.resize(P);
            }

            // 1. Parallel AVX2 kernel weight evaluation across all P particles in the block
            #pragma omp parallel num_threads(num_workers)
            {
                std::vector<double> w_local(n_off);
                std::vector<int64_t> flat_local(n_off);
                std::vector<StencilTable::Offset> dyn_offsets;

                #pragma omp for schedule(static)
                for (int64_t p = 0; p < P; ++p) {
                    int64_t i = blk.c0 + p;
                    int32_t mm_dummy = 0, n_keep = 0;
                    compute_particle_weights(i, w_local, flat_local, dyn_offsets, mm_dummy, n_keep);
                    blk_nkeep[p] = n_keep;
                    double* __restrict__ w_dst = &blk_w[p * n_off];
                    int32_t* __restrict__ f_dst = &blk_flat[p * n_off];
                    for (int32_t idx = 0; idx < n_keep; ++idx) {
                        w_dst[idx] = w_local[idx];
                        f_dst[idx] = static_cast<int32_t>(flat_local[idx]);
                    }
                }
            }

            // 2. Parallel field accumulation: each field j is owned by a single thread -> zero thread-local grid overhead!
            double* __restrict__ level_base = acc_buf + level_offsets[mm];
            const int64_t level_stride = level_cells[mm];

            if (nq >= num_workers) {
                #pragma omp parallel for schedule(dynamic, 1) num_threads(num_workers)
                for (int64_t j = 0; j < nq; ++j) {
                    double* __restrict__ grid_j = level_base + j * level_stride;
                    for (int64_t p = 0; p < P; ++p) {
                        const int32_t n_keep = blk_nkeep[p];
                        if (n_keep == 0) continue;
                        const double qval = qarr[(blk.c0 + p) * nq + j];
                        if (qval == 0.0) continue;
                        const double* __restrict__ w_src = &blk_w[p * n_off];
                        const int32_t* __restrict__ f_src = &blk_flat[p * n_off];
                        for (int32_t idx = 0; idx < n_keep; ++idx) {
                            grid_j[f_src[idx]] += w_src[idx] * qval;
                        }
                    }
                }
            } else {
                // When nq < num_workers, still parallelize across the nq fields
                #pragma omp parallel for schedule(static, 1) num_threads(static_cast<int>(nq))
                for (int64_t j = 0; j < nq; ++j) {
                    double* __restrict__ grid_j = level_base + j * level_stride;
                    for (int64_t p = 0; p < P; ++p) {
                        const int32_t n_keep = blk_nkeep[p];
                        if (n_keep == 0) continue;
                        const double qval = qarr[(blk.c0 + p) * nq + j];
                        if (qval == 0.0) continue;
                        const double* __restrict__ w_src = &blk_w[p * n_off];
                        const int32_t* __restrict__ f_src = &blk_flat[p * n_off];
                        for (int32_t idx = 0; idx < n_keep; ++idx) {
                            grid_j[f_src[idx]] += w_src[idx] * qval;
                        }
                    }
                }
            }
        }
    }
}

/**
 * Multi-threaded OpenMP + AVX2 3D Cloud-in-Cell (CIC) trilinear deposition across (N_particles, N_fields)
 * in a single pass over particle coordinates.
 */
void fast_cic_deposit_batch(
    const double* __restrict__ rel_pos_kpc,
    const double* const* __restrict__ q_ptrs,
    double* const* __restrict__ grid_ptrs,
    double* __restrict__ q_sums_out,
    int64_t N,
    int64_t nq,
    int32_t n,
    double half_kpc,
    int32_t periodic_wrap,
    int32_t n_threads
) {
    if (N <= 0 || nq <= 0) {
        for (int64_t j = 0; j < nq; ++j) q_sums_out[j] = 0.0;
        return;
    }

    const double dx = 2.0 * half_kpc / static_cast<double>(n);
    const int32_t mask = n - 1;
    const int32_t max_i0 = n - 2;
    const int64_t grid_size = static_cast<int64_t>(n) * n * n;

    std::vector<int32_t> flats(8 * N);
    std::vector<float> weights(8 * N);

    int num_workers = (n_threads > 1) ? n_threads : 1;

    #pragma omp parallel for schedule(static) num_threads(num_workers)
    for (int64_t i = 0; i < N; ++i) {
        double gx = (rel_pos_kpc[3 * i + 0] + half_kpc) / dx - 0.5;
        double gy = (rel_pos_kpc[3 * i + 1] + half_kpc) / dx - 0.5;
        double gz = (rel_pos_kpc[3 * i + 2] + half_kpc) / dx - 0.5;

        int32_t ix0 = static_cast<int32_t>(std::floor(gx));
        int32_t iy0 = static_cast<int32_t>(std::floor(gy));
        int32_t iz0 = static_cast<int32_t>(std::floor(gz));

        float fx = static_cast<float>(gx - static_cast<double>(ix0));
        float fy = static_cast<float>(gy - static_cast<double>(iy0));
        float fz = static_cast<float>(gz - static_cast<double>(iz0));

        int32_t ix1, iy1, iz1;
        if (periodic_wrap) {
            ix0 &= mask;
            iy0 &= mask;
            iz0 &= mask;
            ix1 = (ix0 + 1) & mask;
            iy1 = (iy0 + 1) & mask;
            iz1 = (iz0 + 1) & mask;
        } else {
            ix0 = std::min(std::max(ix0, 0), max_i0);
            iy0 = std::min(std::max(iy0, 0), max_i0);
            iz0 = std::min(std::max(iz0, 0), max_i0);
            ix1 = ix0 + 1;
            iy1 = iy0 + 1;
            iz1 = iz0 + 1;
        }

        float wx0 = 1.0f - fx, wx1 = fx;
        float wy0 = 1.0f - fy, wy1 = fy;
        float wz0 = 1.0f - fz, wz1 = fz;

        float w00 = wx0 * wy0;
        float w01 = wx0 * wy1;
        float w10 = wx1 * wy0;
        float w11 = wx1 * wy1;

        int32_t* __restrict__ f_out = &flats[8 * i];
        float* __restrict__ w_out = &weights[8 * i];

        int32_t x0_shift = ix0 * n * n;
        int32_t x1_shift = ix1 * n * n;
        int32_t y0_shift = iy0 * n;
        int32_t y1_shift = iy1 * n;

        w_out[0] = w00 * wz0; f_out[0] = x0_shift + y0_shift + iz0;
        w_out[1] = w00 * wz1; f_out[1] = x0_shift + y0_shift + iz1;
        w_out[2] = w01 * wz0; f_out[2] = x0_shift + y1_shift + iz0;
        w_out[3] = w01 * wz1; f_out[3] = x0_shift + y1_shift + iz1;
        w_out[4] = w10 * wz0; f_out[4] = x1_shift + y0_shift + iz0;
        w_out[5] = w10 * wz1; f_out[5] = x1_shift + y0_shift + iz1;
        w_out[6] = w11 * wz0; f_out[6] = x1_shift + y1_shift + iz0;
        w_out[7] = w11 * wz1; f_out[7] = x1_shift + y1_shift + iz1;
    }

    if (nq >= num_workers || num_workers == 1) {
        #pragma omp parallel for schedule(dynamic, 1) num_threads(num_workers)
        for (int64_t j = 0; j < nq; ++j) {
            const double* __restrict__ q_arr = q_ptrs[j];
            double* __restrict__ grid = grid_ptrs[j];
            double q_sum = 0.0;
            for (int64_t i = 0; i < N; ++i) {
                const double qv = q_arr[i];
                q_sum += qv;
                const int32_t* __restrict__ f_in = &flats[8 * i];
                const float* __restrict__ w_in = &weights[8 * i];
                grid[f_in[0]] += static_cast<double>(w_in[0]) * qv;
                grid[f_in[1]] += static_cast<double>(w_in[1]) * qv;
                grid[f_in[2]] += static_cast<double>(w_in[2]) * qv;
                grid[f_in[3]] += static_cast<double>(w_in[3]) * qv;
                grid[f_in[4]] += static_cast<double>(w_in[4]) * qv;
                grid[f_in[5]] += static_cast<double>(w_in[5]) * qv;
                grid[f_in[6]] += static_cast<double>(w_in[6]) * qv;
                grid[f_in[7]] += static_cast<double>(w_in[7]) * qv;
            }
            q_sums_out[j] = q_sum;
        }
    } else {
        int threads_per_field = std::max(1, std::min(8, num_workers / static_cast<int>(nq)));
        int total_tasks = static_cast<int>(nq) * threads_per_field;
        std::vector<std::vector<double>> partial_grids(total_tasks);
        std::vector<double> partial_sums(total_tasks, 0.0);

        #pragma omp parallel for schedule(static, 1) num_threads(total_tasks)
        for (int task = 0; task < total_tasks; ++task) {
            int64_t j = task / threads_per_field;
            int sub_tid = task % threads_per_field;
            int64_t s_idx = (N * sub_tid) / threads_per_field;
            int64_t e_idx = (N * (sub_tid + 1)) / threads_per_field;

            const double* __restrict__ q_arr = q_ptrs[j];
            double* __restrict__ target_grid = nullptr;
            if (sub_tid == 0) {
                target_grid = grid_ptrs[j];
            } else {
                partial_grids[task].assign(grid_size, 0.0);
                target_grid = partial_grids[task].data();
            }

            double q_sum = 0.0;
            for (int64_t i = s_idx; i < e_idx; ++i) {
                const double qv = q_arr[i];
                q_sum += qv;
                const int32_t* __restrict__ f_in = &flats[8 * i];
                const float* __restrict__ w_in = &weights[8 * i];
                target_grid[f_in[0]] += static_cast<double>(w_in[0]) * qv;
                target_grid[f_in[1]] += static_cast<double>(w_in[1]) * qv;
                target_grid[f_in[2]] += static_cast<double>(w_in[2]) * qv;
                target_grid[f_in[3]] += static_cast<double>(w_in[3]) * qv;
                target_grid[f_in[4]] += static_cast<double>(w_in[4]) * qv;
                target_grid[f_in[5]] += static_cast<double>(w_in[5]) * qv;
                target_grid[f_in[6]] += static_cast<double>(w_in[6]) * qv;
                target_grid[f_in[7]] += static_cast<double>(w_in[7]) * qv;
            }
            partial_sums[task] = q_sum;
        }

        for (int64_t j = 0; j < nq; ++j) {
            double total_q = partial_sums[j * threads_per_field];
            double* __restrict__ dst = grid_ptrs[j];
            for (int sub_tid = 1; sub_tid < threads_per_field; ++sub_tid) {
                int task = static_cast<int>(j) * threads_per_field + sub_tid;
                total_q += partial_sums[task];
                const double* __restrict__ src = partial_grids[task].data();
                #pragma omp parallel for schedule(static) num_threads(num_workers)
                for (int64_t idx = 0; idx < grid_size; ++idx) {
                    dst[idx] += src[idx];
                }
            }
            q_sums_out[j] = total_q;
        }
    }
}

}  // extern "C"
