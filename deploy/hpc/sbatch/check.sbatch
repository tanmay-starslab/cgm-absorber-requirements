#!/bin/bash
# galpipe stage `check`: gates (counts, column conservation, HI <= nH, frame sanity, finite values) -> check.json.
# Submitted by deploy/hpc/launch.py as an array (one task per galaxy) with the GP_* variables of sbatch/task.sh;
# the launcher passes the same resources on the command line (deploy/hpc/hpclib.py STAGES), these are the defaults.
#SBATCH -p public
#SBATCH -q public
#SBATCH -N 1
#SBATCH -c 2
#SBATCH --mem=16G
#SBATCH -t 02:30:00
#SBATCH -J gp-check
source "${GP_REPO:?GP_REPO not set (submit through deploy/hpc/launch.py)}/deploy/hpc/sbatch/task.sh"
