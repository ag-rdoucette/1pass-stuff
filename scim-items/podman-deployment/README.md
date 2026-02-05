# 1Password SCIM Bridge - Manual Deployment Guide
## Complete Setup from Blank VM

This guide walks through deploying 1Password SCIM Bridge using Podman on a fresh VM.

## Prerequisites

You'll need:
- A fresh Linux VM (RHEL/Rocky/AlmaLinux/Fedora/CentOS/Ubuntu/Debian)
- Root or sudo access
- Your 1Password `scimsession` credentials file
- (Optional) TLS certificates or a domain for Let's Encrypt

---

## Step 1: Install Podman

### RHEL / Rocky / AlmaLinux / Fedora / CentOS

```bash
sudo dnf update -y
sudo dnf install -y podman podman-compose
```

### Ubuntu / Debian

```bash
sudo apt update
sudo apt upgrade -y
sudo apt install -y podman podman-compose
```

### Verify Installation

```bash
podman --version
podman-compose --version
```

---

## Step 2: Create Deployment Directory

```bash
mkdir -p ~/op-scim-bridge
cd ~/op-scim-bridge
```

---

## Step 3: Download Deployment Files

Place the following files in `~/op-scim-bridge/`:
- `compose.yaml` - Main service definitions
- `compose.tls.yaml` - TLS certificate overlay (optional)
- `scim.env` - Configuration file

You can download them, copy them via `scp`, or create them manually.

**Example using scp from your local machine:**
```bash
scp compose.yaml user@your-vm:~/op-scim-bridge/
scp compose.tls.yaml user@your-vm:~/op-scim-bridge/
scp scim.env user@your-vm:~/op-scim-bridge/
```

---

## Step 4: Add Your scimsession File

### Get the scimsession from 1Password

1. Log into your 1Password account
2. Navigate to: **Integrations → Directory → SCIM Bridge**
3. Follow the setup wizard to generate credentials
4. Download the `scimsession` file

### Transfer to Your VM

**Option A: Using scp**
```bash
# From your local machine
scp /path/to/scimsession user@your-vm:~/op-scim-bridge/
```

**Option B: Copy/paste contents**
```bash
# On the VM
cd ~/op-scim-bridge
nano scimsession
# Paste the contents, then save with Ctrl+X, Y, Enter
```

### Set Correct Permissions

```bash
cd ~/op-scim-bridge
sudo chown 999:999 scimsession
sudo chmod 440 scimsession
```

**Verify permissions:**
```bash
ls -la scimsession
# Should show: -r--r----- 1 999 999 [size] [date] scimsession
```

---

## Step 5: Configure Settings (Optional)

Edit `scim.env` to customize your deployment:

```bash
nano scim.env
```

### Common Configuration Options

**For Let's Encrypt automatic TLS:**
```bash
OP_TLS_DOMAIN=scim.yourdomain.com
OP_LETSENCRYPT_EMAIL=admin@yourdomain.com
```

**For custom TLS certificates (requires compose.tls.yaml):**
- Leave `OP_TLS_DOMAIN` empty
- Place your certificates in the deployment directory (see Step 6)

**For debugging:**
```bash
OP_DEBUG=1
OP_PRETTY_LOGS=1
```

**For JSON logs:**
```bash
OP_JSON_LOGS=1
```

---

## Step 6: Add TLS Certificates (If Using Custom Certificates)

If you have your own TLS certificates instead of using Let's Encrypt:

### Copy Certificates to Deployment Directory

```bash
cd ~/op-scim-bridge
cp /path/to/your-certificate.pem ./certificate.pem
cp /path/to/your-key.pem ./key.pem
```

### Set Permissions

```bash
sudo chown 999:999 certificate.pem key.pem
sudo chmod 440 certificate.pem key.pem
```

### Verify Permissions

```bash
ls -la *.pem
# Should show: -r--r----- 1 999 999 [size] [date] certificate.pem
# Should show: -r--r----- 1 999 999 [size] [date] key.pem
```

---

## Step 7: Configure Firewall

Allow HTTPS traffic through your firewall:

### firewalld (RHEL/Fedora/CentOS/Rocky/AlmaLinux)

```bash
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --reload
sudo firewall-cmd --list-ports
```

### UFW (Ubuntu/Debian)

```bash
sudo ufw allow 443/tcp
sudo ufw status
```

### iptables

```bash
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

---

## Step 8: Configure Rootless Port Binding (If Running as Non-Root)

If you're running as a regular user (recommended) and want to bind to port 443:

```bash
echo "net.ipv4.ip_unprivileged_port_start=443" | sudo tee /etc/sysctl.d/99-podman.conf
sudo sysctl -p /etc/sysctl.d/99-podman.conf
```

**Alternative:** Change the port mapping in `compose.yaml` to use 8443:
```yaml
ports:
  - "8443:8443"
```

---

## Step 9: Deploy the SCIM Bridge

### Basic Deployment (HTTP or Let's Encrypt)

```bash
cd ~/op-scim-bridge
podman-compose up -d
```

### Deployment with Custom TLS Certificates

```bash
cd ~/op-scim-bridge
podman-compose -f compose.yaml -f compose.tls.yaml up -d
```

---

## Step 10: Verify Deployment

### Check Container Status

```bash
podman-compose ps
```

Expected output:
```
NAME              IMAGE                        STATUS      PORTS
op-scim-bridge    1password/scim:v2.9.13      Up          0.0.0.0:443->8443/tcp
op-scim-redis     redis:latest                Up
```

### View Logs

```bash
# Follow all logs
podman-compose logs -f

# View SCIM bridge logs only
podman-compose logs scim

# View Redis logs only
podman-compose logs redis
```

### Test Redis Connection

```bash
podman exec op-scim-redis redis-cli ping
# Should return: PONG
```

### Test SCIM Bridge Health

```bash
curl -k https://localhost:443/health
# or if using port 8443:
curl -k https://localhost:8443/health
```

---

## Step 11: Enable Auto-Start with Systemd (Optional but Recommended)

### For Rootless Podman (Recommended)

```bash
cd ~/op-scim-bridge

# Ensure containers are running
podman-compose up -d

# Generate systemd service files
podman generate systemd --new --files --name op-scim-bridge
podman generate systemd --new --files --name op-scim-redis

# Create user systemd directory if it doesn't exist
mkdir -p ~/.config/systemd/user

# Move service files
mv container-*.service ~/.config/systemd/user/

# Reload systemd
systemctl --user daemon-reload

# Enable services to start on boot
systemctl --user enable container-op-scim-bridge.service
systemctl --user enable container-op-scim-redis.service

# Enable lingering (keeps services running after logout)
loginctl enable-linger $USER

# Check status
systemctl --user status container-op-scim-bridge.service
systemctl --user status container-op-scim-redis.service
```

### For Rootful Podman

```bash
cd ~/op-scim-bridge

# Ensure containers are running
sudo podman-compose up -d

# Generate systemd service files
sudo podman generate systemd --new --files --name op-scim-bridge
sudo podman generate systemd --new --files --name op-scim-redis

# Move service files to system directory
sudo mv container-*.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable services
sudo systemctl enable container-op-scim-bridge.service
sudo systemctl enable container-op-scim-redis.service

# Check status
sudo systemctl status container-op-scim-bridge.service
sudo systemctl status container-op-scim-redis.service
```

---

## Step 12: Connect 1Password to Your SCIM Bridge

1. Log into your 1Password account at https://start.1password.com/
2. Navigate to: **Settings → Provisioning → SCIM Bridge**
3. Enter your SCIM bridge URL:
   - `https://your-server-ip` or
   - `https://scim.yourdomain.com`
4. Enter the bearer token from your `scimsession` file
5. Click **Test Connection**
6. If successful, click **Save**

---

## Daily Operations

### View Logs

```bash
cd ~/op-scim-bridge
podman-compose logs -f
```

### Restart Services

```bash
cd ~/op-scim-bridge
podman-compose restart
```

### Stop Services

```bash
cd ~/op-scim-bridge
podman-compose down
```

### Start Services

```bash
cd ~/op-scim-bridge
podman-compose up -d
```

### Check Resource Usage

```bash
podman stats
```

### Update to New Version

```bash
cd ~/op-scim-bridge

# Pull latest images
podman-compose pull

# Recreate containers with new images
podman-compose up -d
```

---

## Backup

### Files to Backup Regularly

Create a backup of critical files:

```bash
# Create backup directory
mkdir -p ~/op-scim-backup

# Backup essential files
cd ~/op-scim-bridge
cp scimsession ~/op-scim-backup/
cp scim.env ~/op-scim-backup/
cp compose.yaml ~/op-scim-backup/
cp compose.tls.yaml ~/op-scim-backup/

# If using custom certificates
cp *.pem ~/op-scim-backup/ 2>/dev/null || true

# Create dated archive
tar -czf ~/op-scim-backup-$(date +%Y%m%d).tar.gz -C ~ op-scim-bridge/
```

### Automate Backups with Cron

```bash
# Edit crontab
crontab -e

# Add daily backup at 2 AM
0 2 * * * tar -czf ~/op-scim-backup-$(date +\%Y\%m\%d).tar.gz -C ~ op-scim-bridge/
```

---

## Troubleshooting

### Containers Won't Start

**Check logs for errors:**
```bash
podman-compose logs
```

**Common issues:**
- Missing or incorrect `scimsession` file
- Wrong file permissions (must be 999:999 with mode 440)
- Port 443 already in use
- SELinux blocking access

### Permission Denied Errors

**Verify file ownership and permissions:**
```bash
cd ~/op-scim-bridge
ls -la scimsession
```

**Fix if needed:**
```bash
sudo chown 999:999 scimsession
sudo chmod 440 scimsession
```

### SELinux Issues (RHEL/Fedora/CentOS/Rocky/AlmaLinux)

**Check SELinux denials:**
```bash
sudo ausearch -m avc -ts recent
```

**Temporarily disable SELinux to test (NOT for production):**
```bash
sudo setenforce 0
# Test if issue resolves
sudo setenforce 1
```

**The `:Z` flag in compose.yaml should handle SELinux automatically.**

If issues persist:
```bash
sudo chcon -Rt svirt_sandbox_file_t ~/op-scim-bridge/
```

### Port 443 Already in Use

**Find what's using the port:**
```bash
sudo lsof -i :443
# or
sudo ss -tlnp | grep 443
```

**Options:**
1. Stop the conflicting service
2. Change the port in `compose.yaml` to 8443 or another port
3. Use a reverse proxy (Nginx/Apache) to forward traffic

### Redis Connection Issues

**Test Redis separately:**
```bash
podman exec op-scim-redis redis-cli ping
```

**Check if Redis container is running:**
```bash
podman ps | grep redis
```

**Restart Redis:**
```bash
podman-compose restart redis
```

### Can't Access SCIM Bridge from Outside

**Verify firewall rules:**
```bash
# firewalld
sudo firewall-cmd --list-ports

# UFW
sudo ufw status

# iptables
sudo iptables -L -n | grep 443
```

**Check if service is listening:**
```bash
sudo ss -tlnp | grep 443
```

**Verify from another machine:**
```bash
curl -k https://your-server-ip:443/health
```

### Let's Encrypt Certificate Issues

**Enable trace logging in scim.env:**
```bash
OP_TRACE=1
OP_DEBUG=1
```

**Restart and check logs:**
```bash
podman-compose restart scim
podman-compose logs -f scim
```

**Common Let's Encrypt issues:**
- Domain doesn't resolve to your server's IP
- Port 443 not accessible from internet
- Rate limits (5 certificates per domain per week)

---

## Monitoring

### Check Service Health

```bash
# Container status
podman-compose ps

# Resource usage
podman stats --no-stream

# Logs
podman-compose logs --tail=50

# Specific time range
podman-compose logs --since 1h
```

### Set Up Log Rotation

Podman logs can grow large. Configure log rotation:

```bash
# Create/edit podman config
mkdir -p ~/.config/containers
nano ~/.config/containers/containers.conf
```

Add:
```
[containers]
log_size_max = 10485760
```

This limits logs to 10MB per container.

---

## Uninstall

### Complete Removal

```bash
# Stop and remove containers
cd ~/op-scim-bridge
podman-compose down

# Remove systemd services (if configured)
systemctl --user disable container-op-scim-bridge.service 2>/dev/null || true
systemctl --user disable container-op-scim-redis.service 2>/dev/null || true
rm ~/.config/systemd/user/container-op-scim*.service 2>/dev/null || true
systemctl --user daemon-reload

# Or for rootful:
sudo systemctl disable container-op-scim-bridge.service 2>/dev/null || true
sudo systemctl disable container-op-scim-redis.service 2>/dev/null || true
sudo rm /etc/systemd/system/container-op-scim*.service 2>/dev/null || true
sudo systemctl daemon-reload

# Remove images
podman rmi 1password/scim:v2.9.13 redis:latest

# Remove deployment directory
rm -rf ~/op-scim-bridge

# Remove sysctl config
sudo rm /etc/sysctl.d/99-podman.conf
sudo sysctl -p
```

---

## Security Best Practices

1. **Use rootless Podman** - Run as a regular user instead of root
2. **Keep scimsession secure** - Only readable by UID/GID 999 (mode 440)
3. **Enable firewall** - Only allow necessary ports (443)
4. **Regular updates** - Keep Podman and SCIM bridge images updated
5. **Monitor logs** - Regularly check for unusual activity
6. **Use strong TLS** - Either Let's Encrypt or properly signed certificates
7. **Backup credentials** - Keep encrypted backups of scimsession
8. **Network isolation** - Use Podman's default bridge network isolation
9. **Regular backups** - Automate backups of configuration files

---

## Getting Help

- **1Password Support**: https://support.1password.com/
- **SCIM Bridge Documentation**: https://support.1password.com/scim/
- **Podman Documentation**: https://docs.podman.io/
- **Check logs first**: `podman-compose logs -f`

---

## Summary of File Locations

After deployment, your directory structure should look like:

```
~/op-scim-bridge/
├── compose.yaml          # Main service definitions
├── compose.tls.yaml      # TLS overlay (optional)
├── scim.env              # Environment configuration
├── scimsession           # 1Password credentials (secret!)
├── certificate.pem       # TLS cert (if using custom certs)
└── key.pem              # TLS key (if using custom certs)
```

All files should be owned by you, except `scimsession` and `*.pem` files which should be owned by 999:999.

---

## Quick Reference Commands

```bash
# Deploy
podman-compose up -d

# Deploy with custom TLS
podman-compose -f compose.yaml -f compose.tls.yaml up -d

# Check status
podman-compose ps

# View logs
podman-compose logs -f

# Restart
podman-compose restart

# Stop
podman-compose down

# Update
podman-compose pull && podman-compose up -d

```