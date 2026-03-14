# ArcAid — Hetzner Deployment Guide

Production deployment on Hetzner CPX11 (2 vCPU, 2GB RAM, 40GB SSD) with
Cloudflare DNS, Caddy reverse proxy, and GitHub Actions CI/CD.

## Architecture

```
[Cloudflare DNS] → arcaid.app → [Hetzner VPS]
                                    ├─ Caddy (443→3001, auto TLS origin cert)
                                    └─ ArcAid container (port 3001)
                                        ├─ Express API + Admin UI
                                        ├─ Discord bot
                                        ├─ Playwright (iScored automation)
                                        └─ SQLite (Docker volume: arcaid-data)
```

---

## Step 1: Create the Hetzner Server

1. Go to [Hetzner Cloud Console](https://console.hetzner.cloud/)
2. Create a new project (or use existing)
3. **Add Server:**
   - Location: **Ashburn** (closest US East) or **Hillsboro** (US West)
   - Image: **Ubuntu 24.04**
   - Type: **CPX11** (2 vCPU / 2GB RAM / 40GB SSD)
   - SSH Key: Add your public key (generate one if needed: `ssh-keygen -t ed25519`)
   - Name: `arcaid-prod`
4. Note the server's **IPv4 address**

## Step 2: Point Domain to Server

In **Cloudflare Dashboard** → DNS for `arcaid.app`:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| A | `@` | `YOUR_HETZNER_IP` | DNS only (gray cloud) |

**Important:** Set proxy to **DNS only** (gray cloud icon). Caddy handles TLS directly.
If you want Cloudflare's proxy (orange cloud), set SSL mode to **Full (Strict)** and
Caddy will still auto-provision a Let's Encrypt cert that Cloudflare trusts.

## Step 3: Provision the Server

Run the provisioning script from your local machine:

```bash
ssh root@YOUR_HETZNER_IP 'bash -s' < scripts/provision-server.sh
```

This installs Docker, creates a `deploy` user, sets up the firewall (SSH + HTTP + HTTPS),
adds 2GB swap (helps Playwright), and creates `/opt/arcaid`.

## Step 4: Deploy Configuration Files

From your local machine, copy the production files to the server:

```bash
# Copy docker-compose and Caddyfile
scp docker-compose.prod.yml deploy@YOUR_HETZNER_IP:/opt/arcaid/docker-compose.yml
scp Caddyfile deploy@YOUR_HETZNER_IP:/opt/arcaid/Caddyfile

# Create .env on the server (copy from your local .env and edit as needed)
scp .env deploy@YOUR_HETZNER_IP:/opt/arcaid/.env
```

## Step 5: Initial Container Pull & Start

SSH into the server and start the stack:

```bash
ssh deploy@YOUR_HETZNER_IP

# Log in to GitHub Container Registry
# Create a GitHub PAT at: https://github.com/settings/tokens
# Scope needed: read:packages
echo "YOUR_GITHUB_PAT" | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin

# Start everything
cd /opt/arcaid
docker compose up -d

# Check logs
docker compose logs -f arcaid
```

**First run:** The container will create the SQLite database, seed default settings,
and start the Discord bot. Visit `https://arcaid.app` to see the login page.

## Step 6: GitHub Actions CI/CD Setup

### Generate a deploy SSH key

```bash
# On your local machine — generate a key pair for GitHub Actions
ssh-keygen -t ed25519 -f ~/.ssh/arcaid-deploy -N "" -C "github-actions-deploy"

# Copy the PUBLIC key to the server
ssh-copy-id -i ~/.ssh/arcaid-deploy.pub deploy@YOUR_HETZNER_IP

# The PRIVATE key goes into GitHub Secrets (next step)
cat ~/.ssh/arcaid-deploy
```

### Add GitHub Secrets

Go to your repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret Name | Value |
|-------------|-------|
| `HETZNER_HOST` | Your server's IPv4 address |
| `HETZNER_SSH_KEY` | Contents of `~/.ssh/arcaid-deploy` (the PRIVATE key) |

### Test the pipeline

Push to `main` or trigger manually via Actions → Deploy to Hetzner → Run workflow.

The pipeline will:
1. Build the Docker image
2. Push to GitHub Container Registry (ghcr.io)
3. SSH into the server and run `docker compose pull && docker compose up -d`

---

## Operations

### View logs
```bash
ssh deploy@YOUR_HETZNER_IP
cd /opt/arcaid
docker compose logs -f arcaid      # App logs
docker compose logs -f caddy       # Reverse proxy logs
```

### Restart
```bash
docker compose restart arcaid
```

### Manual deploy (without CI/CD)
```bash
cd /opt/arcaid
docker compose pull
docker compose up -d
```

### Backup the database
```bash
# Copy the SQLite DB from the Docker volume to the server filesystem
docker cp arcaid:/app/data/arcaid.db ./arcaid-backup-$(date +%Y%m%d).db

# Or download to your local machine
scp deploy@YOUR_HETZNER_IP:~/arcaid-backup-*.db ./
```

### Update environment variables
```bash
ssh deploy@YOUR_HETZNER_IP
cd /opt/arcaid
nano .env                           # Edit variables
docker compose restart arcaid       # Restart to pick up changes
```

### Restore from backup
```bash
# Stop the container
docker compose stop arcaid

# Copy backup into the volume
docker cp ./arcaid-backup.db arcaid:/app/data/arcaid.db

# Restart
docker compose start arcaid
```

---

## Cost Summary

| Resource | Monthly |
|----------|---------|
| Hetzner CPX11 | $4.99 |
| Cloudflare DNS | Free |
| GitHub Container Registry | Free (public repos) / included with Pro |
| Let's Encrypt TLS (via Caddy) | Free |
| **Total** | **~$5/mo** |
