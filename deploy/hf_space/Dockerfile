# TNG50 sightline explorer: Hugging Face Space (sdk: docker, app_port 7860).
# Build context = the folder assembled by deploy/hf_space/push_space.sh:
#   Dockerfile README.md requirements-tng.txt trident_doppler_only.patch start.sh tngsight/ server/
# Data (slim cutout, slim ion table, library) is NOT in the image: start.sh downloads the private
# dataset with the HF_TOKEN secret at container start.
# Debian release pinned (glibc 2.36: the scipy/h5py/yt pins only ship manylinux_2_27/2_28 wheels).
# For byte-reproducible rebuilds pin the multi-arch index digest (not a single-platform one, so the
# same file builds on the x86_64 Space and the arm64 OCI VM): FROM python:3.11-slim-bookworm@sha256:<digest>.
# Needs BuildKit (RUN --mount): HF Spaces and docker compose v2 both build with it.

# 0) wheel builder. On linux/amd64 every pin is a manylinux wheel and this stage only downloads them.
#    On linux/arm64 (OCI A1) yt, ewah_bool_utils and yt_astro_analysis have no aarch64 wheel on PyPI
#    and build from sdist (Cython C/C++, OpenMP), so the builder gets gcc/g++; the final image does not.
#    yt cimports ewah_bool_utils, so its isolated build env is held to the runtime pin with
#    --build-constraint (pip >= 25.3) and served the wheel built first, not a newer sdist from PyPI.
#    Other build deps (setuptools, Cython, numpy>=2) float; numpy-2-built extensions import on 1.26.4.
FROM python:3.11-slim-bookworm AS wheels
ARG TARGETARCH
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN if [ "$TARGETARCH" != amd64 ]; then \
      apt-get update && apt-get install -y --no-install-recommends gcc g++ && rm -rf /var/lib/apt/lists/*; fi
COPY requirements-tng.txt /w/
RUN set -eux; cd /w; pip install pip==26.2.1; \
    grep -E '^ewah_bool_utils==' requirements-tng.txt > build-constraints.txt; \
    pip wheel --wheel-dir /w/wheels -r build-constraints.txt; \
    pip wheel --wheel-dir /w/wheels --find-links /w/wheels --build-constraint build-constraints.txt \
        -r requirements-tng.txt yt_astro_analysis==1.1.4

FROM python:3.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HDF5_USE_FILE_LOCKING=FALSE MPLBACKEND=Agg

# `patch` applies the trident fork diff. libgomp1: on arm64 yt/ewah_bool_utils/yt_astro_analysis are
# built from sdist in stage 0 and link the system OpenMP runtime (the x86_64 manylinux wheels bundle
# their own, so there it is unused but harmless). No compilers in this image.
RUN apt-get update && apt-get install -y --no-install-recommends patch libgomp1 && rm -rf /var/lib/apt/lists/*

# HF Spaces run the container as uid 1000; own everything we write.
RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH \
    MPLCONFIGDIR=/home/user/.cache/matplotlib XDG_CACHE_HOME=/home/user/.cache
WORKDIR /home/user/app

# 1) pinned deps (same versions as the working laptop env). yt_astro_analysis: trident imports it at
#    import time; the PyPI 1.1.4 wheel replaces the laptop's editable 1.2.dev2 (no diff vs upstream).
#    Installed offline from the stage-0 wheel set (bind-mounted, so the wheels add no layer).
COPY --chown=user requirements-tng.txt .
RUN --mount=type=bind,from=wheels,source=/w/wheels,target=/tmp/wheels \
    pip install --user --no-index --find-links /tmp/wheels -r requirements-tng.txt yt_astro_analysis==1.1.4

# 2) trident = upstream @ the fork's base commit + the doppler-only patch (pure Python, 3 files).
#    The patched files are checked against the sha256 of the fork as installed on the laptop.
ARG TRIDENT_COMMIT=3f69ad7e1927aae8101caa587869d3d68a31c544
COPY --chown=user trident_doppler_only.patch /tmp/trident.patch
RUN set -eux; cd /tmp; \
    python -c "import urllib.request,sys; urllib.request.urlretrieve(sys.argv[1], 'trident.tgz')" \
        "https://github.com/trident-project/trident/archive/${TRIDENT_COMMIT}.tar.gz"; \
    tar xzf trident.tgz; cd "trident-${TRIDENT_COMMIT}"; patch -p1 < /tmp/trident.patch; \
    printf '%s  %s\n' \
      a0a94e27699049d2e2b61df7c4c1879017b523fba66b483841a1cea5d5ec897f trident/absorption_spectrum/absorption_spectrum.py \
      b14e7216e223767d788236512c80fb4a093e7512fb7f4c927ae0417805e3f882 trident/spectrum_generator.py \
      de6c076f3187b119bd446048adf56b7ddad4e0f3346bd739683cb97ab059f307 trident/data/line_lists/lines.txt \
      | sha256sum -c -; \
    pip install --user --no-deps .; cd /tmp; rm -rf trident.tgz "trident-${TRIDENT_COMMIT}" trident.patch

# 3) smoke test + bake caches: matplotlib font cache, and an import of trident against a dummy
#    config/table (import only parses config.tri; a missing table would trigger an input() prompt).
RUN set -eux; mkdir -p /tmp/tri && touch /tmp/tri/hm2012_ss_hr.h5; cd /tmp/tri; \
    printf '[Trident]\nion_table_dir = /tmp/tri\nion_table_file = hm2012_ss_hr.h5\n' > config.tri; \
    python -c "import inspect, matplotlib.pyplot as plt, yt, yt_astro_analysis, trident; \
from trident import SpectrumGenerator as S; \
assert 'use_doppler_redshift_only' in inspect.signature(S.make_spectrum).parameters; \
plt.figure(); plt.text(0.5, 0.5, r'\$\\lambda\$ O VI'); plt.savefig('/tmp/tri/x.png'); \
print('ok', yt.__version__, trident.__version__)"; \
    rm -rf /tmp/tri

# 4) app code. config.tri is (re)written by start.sh for the runtime data dir; this default matches
#    DATA_DIR=$HOME/data.
COPY --chown=user tngsight ./tngsight
COPY --chown=user server ./server
COPY --chown=user start.sh ./start.sh
RUN printf '[Trident]\nion_table_dir = /home/user/data/trident\nion_table_file = hm2012_ss_hr.h5\n' > config.tri

EXPOSE 7860
CMD ["bash", "start.sh"]
