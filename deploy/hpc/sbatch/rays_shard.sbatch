#!/bin/bash
# galpipe stage `rays` (sharded): one shard i/n of the 683-ray library (12 lines, npz v2); one array per shard.
# Submitted by deploy/hpc/launch.py as an array (one task per galaxy) with the GP_* variables of sbatch/task.sh;
# the launcher passes the same resources on the command line (deploy/hpc/hpclib.py STAGES), these are the defaults.
#SBATCH -p public
#SBATCH -q public
#SBATCH -N 1
#SBATCH -c 8
#SBATCH --mem=16G
#SBATCH -t 03:00:00
#SBATCH -J gp-rays_shard
source "${GP_REPO:?GP_REPO not set (submit through deploy/hpc/launch.py)}/deploy/hpc/sbatch/task.sh"
