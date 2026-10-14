"""Pull-based remote worker: lease jobs from a coordinator (e.g. the HF Space) over HTTPS, compute
them with a local Generator, upload the npz. No inbound port or tunnel needed.

    python -m server.remote_worker --coordinator https://<space>.hf.space --token $WORKER_TOKEN [--name laptop]

The worker announces caps ["endpoints", "fit"] (custom rays + fitted components); a Phase-1
coordinator that rejects the field gets a capability-less lease instead.

Needs the same data as the server (TNG_CUTOUT, TNG_ION_TABLE_DIR, TNG_INDEX_FILE) and cwd with
config.tri if the Generator imports trident there.
"""
from __future__ import annotations
import argparse
import logging
import os
import signal
import sys

from .workers import NAME_RE, FatalLeaseError, RemoteWorker


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m server.remote_worker", description=__doc__.split("\n\n")[0])
    ap.add_argument("--coordinator", required=True, help="base URL of the coordinator (no /api)")
    ap.add_argument("--token", default=os.environ.get("WORKER_TOKEN"), help="WORKER_TOKEN (default: env)")
    ap.add_argument("--name", default=os.environ.get("NODE_NAME"), help="worker name shown in /api/health")
    ap.add_argument("--generator", default=os.environ.get("TNG_GENERATOR", "tngsight.generate:Generator"),
                    help="'module:attr' Generator factory")
    ap.add_argument("--poll", type=float, default=25.0, help="long-poll seconds per lease request")
    ap.add_argument("--max-jobs", type=int, default=None, help="exit after N jobs")
    ap.add_argument("--workdir", default=os.environ.get("TNG_WORKDIR"), help="temp dir for npz staging")
    ap.add_argument("-v", "--verbose", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    if not a.token:
        ap.error("--token or WORKER_TOKEN is required")
    if a.name and not NAME_RE.match(a.name):
        ap.error(f"--name {a.name!r} must match {NAME_RE.pattern} (letters, digits, '.', '_', '-')")
    kw = {k: v for k, v in (("cutout", os.environ.get("TNG_CUTOUT")),
                            ("ion_table_dir", os.environ.get("TNG_ION_TABLE_DIR")),
                            ("index_filename", os.environ.get("TNG_INDEX_FILE"))) if v}
    w = RemoteWorker(a.coordinator, a.token, name=a.name, poll_s=a.poll, workdir=a.workdir,
                     gen_spec=a.generator, gen_kwargs=kw)
    signal.signal(signal.SIGTERM, lambda *_: w.stop())
    try:
        n = w.run(max_jobs=a.max_jobs)
    except KeyboardInterrupt:
        w.stop()
        n = w.done
    except (PermissionError, FatalLeaseError) as e:
        logging.error("%s", e)
        return 2
    logging.info("worker %s exiting: %d jobs (%d ok, %d failed)", w.name, n, w.done, w.failed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
