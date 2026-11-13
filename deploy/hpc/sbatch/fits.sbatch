#!/bin/bash
# galpipe stage `fits`: vpfit components + catalogue (scoring, showcase flags).
# Submitted by deploy/hpc/launch.py as an array (one task per galaxy) with the GP_* variables of sbatch/task.sh;
# the launcher passes the same resources on the command line (deploy/hpc/hpclib.py STAGES), these are the defaults.
#SBATCH -p public
#SBATCH -q public
#SBATCH -N 1
#SBATCH -c 16
#SBATCH --mem=8G
#SBATCH -t 06:00:00
#SBATCH -J gp-fits
source "${GP_REPO:?GP_REPO not set (submit through deploy/hpc/launch.py)}/deploy/hpc/sbatch/task.sh"
