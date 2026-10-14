# TNG50 explorer backend on Oracle Cloud (Always Free A1)

An always-on copy of the sightline server, as an alternative to the HF Space. The VM runs two
containers with `docker compose`:

- **app**: the same image as the HF Space (`deploy/hf_space/Dockerfile`), built on the VM itself.
  At start it downloads the private dataset into the named volume `tngdata`.
- **caddy**: serves HTTPS for `https://<ip-dashes>.sslip.io`, with an automatic Let's Encrypt
  certificate. Example: IP `1.2.3.4` gives `1-2-3-4.sslip.io`.

Files: `docker-compose.yml`, `Caddyfile`, `vm_setup.sh` (one-time VM bootstrap; safe to re-run)
and `push_oci.sh` (assemble, copy, start).

## One-time setup in the Oracle console

1. **Create the instance.** Go to *Compute → Instances → Create*.
   - Image: **Canonical Ubuntu 24.04** (aarch64).
   - Shape: *Change shape → Ampere* → **VM.Standard.A1.Flex**; expand the row and set **2 OCPU / 12 GB**
     (the Always Free A1 allowance as of 2026; it was 4 OCPU / 24 GB before). 1 OCPU / 6 GB also works.
   - "Out of capacity for shape VM.Standard.A1.Flex": go back to *Placement* and try another
     availability domain (AD 1 worked in Phoenix when AD 3 was full), or retry later.
   - Networking: *Create new virtual cloud network* + *Create new public subnet*. The "Automatically
     assign public IPv4 address" switch stays greyed out while the subnet is still to be created; create
     the instance anyway, then attach one: *Instance → Networking → Attached VNICs → (VNIC) → IP
     administration → ⋮ Edit → Ephemeral public IP*. An ephemeral IP survives stop/start but not
     termination, and the hostname is derived from the IP.
   - The cost estimate lists the boot volume at list price; it is inside the 200 GB Always Free storage.
   - SSH key: upload the public half of `~/.ssh/tng50_oci`. Create the pair first with
     `ssh-keygen -t ed25519 -f ~/.ssh/tng50_oci`.
2. **Open ports 80 and 443.** From the instance: *Networking → (subnet link) → Security → Default
   Security List → Security rules → Add Ingress Rules*. Add two rules, both with source `0.0.0.0/0`, protocol TCP,
   destination ports `80` and `443`. By default only port 22 is open. Without these two rules the
   certificate challenge fails, and changing the VM's iptables does not help.

## Deploy

```bash
deploy/oci/push_oci.sh <public-ip>          # optional 2nd arg: ssh key (default ~/.ssh/tng50_oci)
```

The script does four things:

- Runs `vm_setup.sh` on the VM. This waits for cloud-init, opens 80/443 in the instance firewall
  and persists only those rules, then installs Docker.
- Copies the build context to `~/tng50`.
- Writes `~/tng50/.env` on the first run only. It takes `HF_TOKEN` and `WORKER_TOKEN` from
  `/Volumes/cgm_work/cache/hf/{token,worker_token}` without printing them, and the file is mode 600.
- Runs `docker compose up -d --build`.

The first build takes roughly 10 to 20 minutes, because on arm64 yt, ewah_bool_utils and
yt_astro_analysis are compiled from source. Later builds use the layer cache. The first start then
downloads the dataset.

Check the deploy:

```bash
curl -s https://<ip-dashes>.sslip.io/api/health
```

Then point the published page at the VM and re-export it:

```bash
/Volumes/cgm_work/envs/trident/bin/python scripts/export_tng50_web.py --prune --chat \
    --space-url https://<ip-dashes>.sslip.io
```

Keep `--chat`: without it the exporter writes `chat.enabled = false` and the page hides its Ask button.
The exporter also copies `components.json` and `vol/` from the library (`--components`, `--vol-dir`;
defaults `<library>/components.json` and `<library>/vol`).

### Chat (Claude backend, optional)

The Claude backend of the Ask panel needs an Anthropic key on the VM. It is not written by
`push_oci.sh` (that writes `.env` once, with the HF and worker tokens only). On the VM:

```bash
cd ~/tng50
umask 077
read -rs KEY && printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" >> .env && unset KEY   # paste the key; not echoed
chmod 600 .env
# optional: CHAT_DAILY_BUDGET=500, CHAT_CLIENT_DAILY_BUDGET=50, CHAT_DAILY_TOKENS=4000000, CHAT_CLAUDE=0
docker compose up -d
curl -s https://<ip-dashes>.sslip.io/api/health      # "chat": {"claude": true}
```

Never commit, print or paste the key into a shell history (`read -s` keeps it out of both).

`CORS_ORIGINS` in `.env` already allows `https://tanmay-starslab.github.io` and the local preview
on port 8000.

## Operating it (on the VM: `ssh -i ~/.ssh/tng50_oci ubuntu@<ip>`, then `cd ~/tng50`)

| Task | Command |
|---|---|
| Follow the app log | `docker compose logs -f app` (Caddy/ACME: `logs -f caddy`) |
| Status and health | `docker compose ps` (the app shows `healthy` once `/api/health` answers) |
| Pull dataset updates | `docker compose restart app` (start.sh re-syncs the dataset at every start) |
| Change tokens or CORS | edit `~/tng50/.env`, then `docker compose up -d` |
| Stop / start | `docker compose down` / `docker compose up -d` (data stays in volume `tngdata`) |

- **Updating code.** Run `deploy/oci/push_oci.sh <ip>` again from the laptop. It rebuilds and
  restarts, and it keeps `.env` (only the `HOST=` line is rewritten).
- **Reboots.** Containers restart by themselves.
- **Logs.** Logs rotate at 5 × 20 MB per container.

## Laptop worker pointed at the VM

The pull-worker leases jobs over HTTPS, so the laptop needs no inbound port.

```bash
deploy/laptop/worker.sh https://<ip-dashes>.sslip.io     # or: export TNG_SPACE_URL=https://<ip-dashes>.sslip.io
```

- **Token.** The worker reads `WORKER_TOKEN` from the environment. If it is not set, it falls back
  to the macOS keychain item `tng50-worker-token`. That value must equal `WORKER_TOKEN` in the VM's
  `.env`, which is the same `worker_token` file the deploy used.
- **Requirements.** `/Volumes/cgm_work` must be mounted, because the worker reads the cutout from
  there.
- **Overrides.** `NODE_NAME`, `TNG_CUTOUT`, `TNG_ION_TABLE_DIR`, `TNG_INDEX_FILE` and
  `TNG_WORKDIR` override the defaults.

## Secrets: what can see them

- **Where they live.** `HF_TOKEN`, `WORKER_TOKEN` and (if set) `ANTHROPIC_API_KEY` exist only in
  `~/tng50/.env` on the VM. They are not in the image: `.dockerignore` keeps `.env` out of the build
  context.
- **Who can print them.** `docker compose config` and `docker inspect tng50-app-1` print them in
  clear. Anyone in the VM's `docker` group (or root) can run those, so keep the VM single-user.
