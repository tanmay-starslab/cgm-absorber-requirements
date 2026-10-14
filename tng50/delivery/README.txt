CGM Mock-QSO Spectra Explorer  —  TNG50-1 galaxy sub-488530
============================================================

An interactive viewer for mock quasar absorption-line spectra through the
circumgalactic medium (CGM) of a Milky-Way-mass galaxy from the TNG50
cosmological simulation. It shows three UV lines — O VI, H I Lybeta, and
C III — for 672 sightlines, and lets you vary the spectrograph settings live.


HOW TO OPEN  (macOS)
--------------------
Double-click  CGM_Explorer.html  — it opens in your web browser.

  * Nothing to install.
  * The FIRST time you open it, keep an internet connection: it downloads the
    plotting engine (a few seconds). After that it runs locally on your computer.
  * A short "Starting the viewer..." screen appears while it gets ready
    (about 10-15 seconds the first time). Then the spectra show up.
  * Each time you change a setting, the figure takes about a second to redraw.
  * If double-clicking shows raw code or downloads instead of opening, then
    right-click the file -> Open With -> Safari (or Chrome / Firefox).


WHAT YOU'RE LOOKING AT
----------------------
A grid of 3 rows x 4 columns:
  * Rows    = the three ions:  O VI 1032 (pink),  H I Lybeta (blue),  C III 977 (green).
  * Columns = four spectrograph setups (spectral resolution R and signal-to-noise S/N).
  * x-axis  = velocity relative to the galaxy (V_LOS - V_sys, in km/s); 0 = the galaxy.
              (Copies built before October 2026 had this axis offset by up to ~250 km/s
              and a slightly wrong line blur; rebuild with build_delivery_wasm.py.)
  * y-axis  = normalized flux (1 = no absorption; dips = gas absorbing the quasar light).

In each panel: the thick colored curve is the true (noiseless) line at that resolution,
and the faint jagged curve is a realistic noisy "observation" at that S/N.


CONTROLS (left panel — everything updates instantly)
----------------------------------------------------
  * Sightline gallery : pick which line of sight to view. Sorted best-first.
        A star (*) marks the best demonstrators — sightlines with several distinct,
        un-saturated velocity components, where the effect of R and S/N is clearest.
        Tick "showcase only" to list just those.  Use prev / next to step through.
  * R  (two menus)     : spectral resolution. Higher R = sharper lines, splits blended
        components apart.
  * S/N (two sliders)  : signal-to-noise. Higher = cleaner; lower = noisier, weak lines
        get buried.
  * velocity window    : zoom the x-axis in or out.
  * show intrinsic     : overlay the underlying "true" spectrum (grey) before the
        instrument blurs it — shows how much resolution is lost.
  * new noise          : redraw the random noise.
  * PNG                : save the current figure as an image.

A good place to start: tick "showcase only" and look at the top few, or try
"edge b=100 kpc, phi=330" — all three ions are clearly detected and un-saturated,
so you can directly see how R and S/N reshape the spectra.


Questions -> Tanmay.
