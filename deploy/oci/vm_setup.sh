#!/usr/bin/env bash
# One-time, idempotent VM bootstrap (run on the VM as the ubuntu user; push_oci.sh pipes it over ssh,
# so stdin is this script: every command that might read stdin gets </dev/null).
# Opens 80/443 in the instance firewall (Oracle's Ubuntu images ship iptables INPUT rules that reject
# everything but 22), persists ONLY those rules, then installs Docker. Order matters: saving after
# Docker is running would capture Docker's own chains/DNAT rules, which go stale on reboot.
# Note: traffic to Docker-published ports is DNATed and goes through FORWARD (accepted by Docker's
# own rules), so the INPUT rules are defence in depth; the OCI security list must also allow 80/443.
set -euo pipefail

# first boot: cloud-init / unattended-upgrades hold the dpkg lock for a while
sudo cloud-init status --wait >/dev/null 2>&1 || true
while sudo fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock >/dev/null 2>&1; do sleep 5; done

if ! dpkg -s iptables-persistent >/dev/null 2>&1; then
  echo iptables-persistent iptables-persistent/autosave_v4 boolean false | sudo debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean false | sudo debconf-set-selections
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q iptables-persistent </dev/null >/dev/null
fi

# live rules: insert before Oracle's REJECT (or at the top if there is none)
for p in 443 80; do
  if ! sudo iptables -C INPUT -p tcp -m state --state NEW --dport $p -j ACCEPT 2>/dev/null; then
    pos=$(sudo iptables -L INPUT -n --line-numbers | awk '$2=="REJECT"{print $1; exit}')
    sudo iptables -I INPUT "${pos:-1}" -p tcp -m state --state NEW --dport $p -j ACCEPT
  fi
done
# persisted rules: edit rules.v4 in place rather than saving the live table, so this stays correct
# when re-run on a VM where Docker is already installed.
R=/etc/iptables/rules.v4
if ! sudo test -f $R; then
  if command -v docker >/dev/null; then
    echo "WARNING: $R missing and Docker already running; not saving the live table (it holds Docker's rules)."
  else
    sudo netfilter-persistent save
  fi
elif ! sudo grep -q -- '--dport 443 -j ACCEPT' $R && sudo grep -q -- '^-A INPUT -j REJECT' $R; then
  # (no INPUT REJECT persisted = nothing blocks 80/443 at boot, nothing to add)
  sudo sed -i '0,/^-A INPUT -j REJECT/s//-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT\n-A INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT\n&/' $R
fi

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh </dev/null      # docker-ce + compose plugin, enables docker.service
  sudo usermod -aG docker "$USER"
fi
mkdir -p ~/tng50
echo "vm ready"
