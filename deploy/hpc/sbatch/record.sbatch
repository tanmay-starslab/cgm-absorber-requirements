#!/bin/bash
# galpipe stage `record`: galaxy.json from the host catalogue and the cutout (centre, velocity, R200c, M200c, M*, SFR, disk frame).
# Submitted by deploy/hpc/launch.py as an array (one task per galaxy) with the GP_* variables of sbatch/task.sh;
# the launcher passes the same resources on the command line (deploy/hpc/hpclib.py STAGES), these are the defaults.
#SBATCH -p public
#SBATCH -q public
#SBATCH -N 1
#SBATCH -c 1
#SBATCH --mem=8G
#SBATCH -t 00:30:00
#SBATCH -J gp-record
source "${GP_REPO:?GP_REPO not set (submit through deploy/hpc/launch.py)}/deploy/hpc/sbatch/task.sh"
