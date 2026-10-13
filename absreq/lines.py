r"""Atomic data for the CGM absorption lines used here.

Oscillator strengths, wavelengths and damping constants come from the Trident line list
(trident-project/trident, ``trident/data/line_lists/lines.txt``; BSD-3 licence, see
``data/TRIDENT_LICENSE.txt``).  Transitions absent from that list (Mg II 2796/2803,
Si IV 1393, O VII 21.6) are taken from ``data/supplement_lines.txt``, which records the
literature source of each value.

Each ion also carries a fiducial Doppler parameter, b_fid = sqrt(b_th^2 + b_turb^2) with
b_th = sqrt(2 k T / m) at a representative temperature for the ion and b_turb = 5 km/s.
"""
from dataclasses import dataclass, field
from pathlib import Path
import numpy as np

DATA = Path(__file__).parent / "data"
B_TURB = 5.0
MASS = {"H": 1.008, "C": 12.011, "N": 14.007, "O": 15.999, "Ne": 20.180, "Mg": 24.305, "Si": 28.085, "S": 32.06}

# (ion, wavelength [A] to match, label wavelength, representative T [K], phase)
CGM_IONS = [
    ("H I", 1215.67, "1216", 1e4, "neutral"),
    ("Mg II", 2796.35, "2796", 1e4, "low"),
    ("Si II", 1260.42, "1260", 1e4, "low"),
    ("S II", 1259.52, "1260", 1e4, "low"),
    ("C II", 1334.53, "1335", 1e4, "low"),
    ("Si III", 1206.50, "1206", 3e4, "intermediate"),
    ("Si IV", 1402.77, "1403", 6e4, "intermediate"),
    ("C IV", 1548.19, "1548", 1e5, "intermediate"),
    ("N V", 1238.82, "1239", 2e5, "high"),
    ("O VI", 1031.91, "1032", 3e5, "high"),
    ("Ne VIII", 770.41, "770", 6e5, "high"),
    ("O VII", 21.602, "21.6", 1e6, "X-ray"),
]


@dataclass
class Line:
    ion: str
    lam: float          # Angstrom
    f: float
    gamma: float        # s^-1
    source: str
    label_lam: str = ""
    T: float = 1e4
    phase: str = ""
    b_fid: float = field(init=False)

    def __post_init__(self):
        el = self.ion.split()[0]
        bth = 0.12895 * np.sqrt(self.T / MASS[el])          # km/s
        self.b_fid = float(np.sqrt(bth**2 + B_TURB**2))

    @property
    def key(self):
        return self.ion.replace(" ", "") + self.label_lam.replace(".", "p")

    @property
    def tex(self):
        el, st = self.ion.split()
        return rf"{el}\,\textsc{{{st.lower()}}}\,$\lambda{self.label_lam}$"

    def tau0(self, logN, b):
        """Line-centre optical depth of a Doppler profile."""
        return 1.4975e-15 * 10**np.asarray(logN) * self.f * self.lam / b

    def logN_tau1(self, b=None):
        """Column density at which tau0 = 1."""
        b = self.b_fid if b is None else b
        return float(np.log10(b / (1.4975e-15 * self.f * self.lam)))


def _read(path, source_col):
    rows = []
    for ln in Path(path).read_text().splitlines():
        if not ln.strip() or ln.startswith("#"):
            continue
        p = ln.split()
        ion = f"{p[0]} {p[1]}"
        src = " ".join(p[5:]) if source_col and len(p) > 5 else "Trident"
        rows.append((ion, float(p[2]), float(p[4]), float(p[3]), src))
    return rows


def load_lines():
    """All transitions: Trident list plus supplement. Returns list of (ion, lam, f, gamma, source)."""
    return _read(DATA / "trident_lines.txt", False) + _read(DATA / "supplement_lines.txt", True)


def get_line(ion, lam, label_lam="", T=1e4, phase=""):
    """Closest transition of `ion` to wavelength `lam` (Trident first, supplement second)."""
    cands = [r for r in load_lines() if r[0] == ion]
    if not cands:
        raise KeyError(ion)
    r = min(cands, key=lambda r: abs(r[1] - lam))
    if abs(r[1] - lam) > 0.05 * lam:
        raise KeyError(f"{ion} {lam}: nearest is {r[1]}")
    return Line(r[0], r[1], r[2], r[3], r[4], label_lam, T, phase)


def cgm_lines():
    return [get_line(i, l, lab, T, ph) for i, l, lab, T, ph in CGM_IONS]


if __name__ == "__main__":
    for L in cgm_lines():
        print(f"{L.ion:8s} {L.lam:10.4f}  f={L.f:.4g}  gamma={L.gamma:.3g}  b_fid={L.b_fid:5.1f}  "
              f"logN(tau0=1)={L.logN_tau1():5.2f}  [{L.source}]")
