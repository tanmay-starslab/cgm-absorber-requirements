#!/bin/bash
# galpipe stage `import_sbi`: SBI_CGM spectra of the selected subset -> library npz v2 + TNGS v2 bins (SBI galaxies).
# Submitted by deploy/hpc/launch.py as an array (one task per galaxy) with the GP_* variables of sbatch/task.sh;
# the launcher passes the same resources on the command line (deploy/hpc/hpclib.py STAGES), these are the defaults.
#SBATCH -p public
#SBATCH -q public
#SBATCH -N 1
#SBATCH -c 2
#SBATCH --mem=8G
#SBATCH -t 03:00:00
#SBATCH -J gp-import_sbi
# parallel preads per task (sbi.IO_THREADS); with the %16 throttle at most 192 in flight on BeeGFS
export TNG_SBI_IO_THREADS=${TNG_SBI_IO_THREADS:-12}
source "${GP_REPO:?GP_REPO not set (submit through deploy/hpc/launch.py)}/deploy/hpc/sbatch/task.sh"
