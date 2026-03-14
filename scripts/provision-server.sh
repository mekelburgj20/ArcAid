#!/bin/bash
# =============================================================================
# ArcAid — Hetzner VPS Provisioning Script
# Run this as root on a fresh Ubuntu 24.04 (or 22.04) Hetzner CPX11
# Usage: ssh -i ~/.ssh/id_arcaid root@YOUR_IP 'bash -s' < scripts/provision-server.sh
# =============================================================================

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "=== ArcAid Server Provisioning ==="

# --- 1. System updates ---
echo ">> Updating system packages..."
apt-get update && apt-get upgrade -y

# --- 2. Install Docker (before creating user, so docker group exists) ---
echo ">> Installing Docker..."
if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi

# --- 3. Create deploy user ---
echo ">> Creating deploy user..."
if ! id -u deploy &>/dev/null; then
    useradd -m -s /bin/bash deploy
fi
usermod -aG docker deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
echo "deploy ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker\ compose" > /etc/sudoers.d/deploy

# --- 4. Firewall (ufw) ---
echo ">> Configuring firewall..."
apt-get install -y ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (Caddy redirect)
ufw allow 443/tcp   # HTTPS (Caddy)
ufw --force enable

# --- 5. Fail2ban for SSH protection ---
echo ">> Installing fail2ban..."
apt-get install -y fail2ban
systemctl enable fail2ban
systemctl start fail2ban

# --- 6. Create app directory ---
echo ">> Setting up /opt/arcaid..."
mkdir -p /opt/arcaid
chown deploy:deploy /opt/arcaid

# --- 7. Swap file (2GB — helps with Playwright on 2GB RAM) ---
echo ">> Creating 2GB swap file..."
if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# --- 8. Automatic security updates ---
echo ">> Enabling automatic security updates..."
apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

echo ""
echo "=== Provisioning Complete ==="
echo ""
echo "Next steps:"
echo "  1. SSH in as deploy user:  ssh -i ~/.ssh/id_arcaid deploy@$(hostname -I | awk '{print $1}')"
echo "  2. Copy files to /opt/arcaid:"
echo "     - docker-compose.prod.yml  (rename to docker-compose.yml)"
echo "     - Caddyfile"
echo "     - .env"
echo "  3. Log in to GitHub Container Registry:"
echo "     echo YOUR_GITHUB_PAT | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin"
echo "  4. Start the stack:  cd /opt/arcaid && docker compose up -d"
echo "  5. Set up GitHub Actions secrets (HETZNER_HOST, HETZNER_SSH_KEY)"
echo ""
