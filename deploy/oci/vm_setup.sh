#!/usr/bin/env bash
# One-time VM bootstrap (run on the VM as the ubuntu user via ssh). Installs Docker, opens 80/443 in
# the instance firewall (Oracle's Ubuntu images ship iptables rules that reject everything but 22).
set -euo pipefail
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
for p in 80 443; do
  sudo iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp --dport $p -j ACCEPT
done
sudo apt-get install -y iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save || true
mkdir -p ~/tng50
echo "vm ready"
