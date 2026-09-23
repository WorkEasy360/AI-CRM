#!/bin/bash
# One-time bootstrap for the Keel CRM host (EC2 user data, Amazon Linux 2023, arm64 or x86_64).
# Installs Docker + the Compose plugin (checksum-pinned), adds swap, clones the public repository and
# installs the host scripts and timers. It does NOT deploy: the first deploy is `keel-update <sha>`,
# sent through SSM once the images for that commit exist.
set -euo pipefail
exec > >(tee -a /var/log/keel-bootstrap.log) 2>&1

COMPOSE_VERSION=v5.5.1
declare -A COMPOSE_SHA256=(
  [aarch64]=732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7
  [x86_64]=db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576
)
REPO=https://github.com/WorkEasy360/AI-CRM.git

# 2 GiB swap: the whole stack fits in 2 GiB RAM, swap absorbs build/import spikes instead of the OOM killer.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi
cat >/etc/sysctl.d/90-keel.conf <<'EOF'
vm.swappiness = 10
vm.overcommit_memory = 1
EOF
sysctl --system >/dev/null

dnf -y -q install docker git
systemctl enable --now docker

arch="$(uname -m)"
plugin=/usr/local/lib/docker/cli-plugins/docker-compose
install -d /usr/local/lib/docker/cli-plugins
curl -fsSL -o "$plugin" "https://github.com/docker/compose/releases/download/$COMPOSE_VERSION/docker-compose-linux-$arch"
echo "${COMPOSE_SHA256[$arch]}  $plugin" | sha256sum -c --quiet -
chmod 0755 "$plugin"

[ -d /opt/keel/src/.git ] || git clone --quiet "$REPO" /opt/keel/src
install -m 0755 /opt/keel/src/deploy/ec2/bin/keel-update /usr/local/bin/keel-update
install -m 0644 /opt/keel/src/deploy/ec2/systemd/keel.service /etc/systemd/system/keel.service
install -m 0644 /opt/keel/src/deploy/ec2/systemd/keel-backup.service /etc/systemd/system/keel-backup.service
install -m 0644 /opt/keel/src/deploy/ec2/systemd/keel-backup.timer /etc/systemd/system/keel-backup.timer
systemctl daemon-reload
systemctl enable keel.service keel-backup.timer
systemctl start keel-backup.timer

echo "keel bootstrap complete: $(docker --version); $(docker compose version)"
