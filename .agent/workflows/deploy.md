---
description: How to deploy game-incontrolable to a Linux VPS with auto-deploy via Git
---

# Deploy to Linux VPS

## Prerequisites
- A Linux VPS (Ubuntu 22.04+ / Debian 12+ recommended)
- SSH access to the VPS (`ssh root@YOUR_VPS_IP`)
- A GitHub repository for the project
- (Optional) A domain pointing to your VPS IP

## Step 1: Push code to GitHub

From your local machine (PowerShell):

```powershell
cd c:\laragon\www\game_incontrolable
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USER/game_incontrolable.git
git push -u origin main
```

## Step 2: Run the VPS setup script

SSH into your VPS and run:

```bash
# Download and run the setup script (one-liner)
curl -sL https://raw.githubusercontent.com/YOUR_USER/game_incontrolable/main/deploy/setup-vps.sh -o /tmp/setup-vps.sh

# Without a domain (access via IP):
bash /tmp/setup-vps.sh https://github.com/YOUR_USER/game_incontrolable.git

# With a domain:
bash /tmp/setup-vps.sh https://github.com/YOUR_USER/game_incontrolable.git game.yourdomain.com
```

This will install everything, build the project, and start the server.

**IMPORTANT:** Save the webhook secret printed at the end!

## Step 3: Configure GitHub Webhook

1. Go to your GitHub repo → **Settings** → **Webhooks** → **Add webhook**
2. Set:
   - **Payload URL**: `http://YOUR_VPS_IP:9000/webhook`
   - **Content type**: `application/json`
   - **Secret**: (paste the webhook secret from setup)
   - **Events**: Just the **push** event
3. Click **Add webhook**

## Step 4: Deploy!

Now just push to `main` and it auto-deploys:

```powershell
git add .
git commit -m "My changes"
git push origin main
```

The webhook will trigger → pull → build → restart PM2. Takes ~15-30 seconds.

---

## Useful VPS Commands

```bash
# View running processes
pm2 status

# View game server logs (live)
pm2 logs game-incontrolable

# View deploy webhook logs
pm2 logs deploy-webhook

# Restart game server
pm2 restart game-incontrolable

# Restart everything
pm2 restart all

# Manual deploy (if webhook fails)
cd /var/www/game-incontrolable
bash deploy/deploy.sh

# Check nginx status
sudo systemctl status nginx

# Reload nginx config
sudo nginx -t && sudo systemctl reload nginx
```

## File Structure (deploy-related)

```
deploy/
  setup-vps.sh          # One-time VPS setup (run on server)
  deploy.sh             # Auto-deploy script (called by webhook)
  webhook-server.js     # GitHub webhook listener (port 9000)
  nginx.conf            # Nginx reverse proxy template
ecosystem.config.cjs    # PM2 process manager config
.gitignore              # Git ignore rules
```

## Setting up SSL later

If you didn't provide a domain during setup but want HTTPS later:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d YOUR_DOMAIN
```

## Troubleshooting

- **Game not loading**: Check `pm2 logs game-incontrolable` for errors
- **502 Bad Gateway**: Game server crashed — `pm2 restart game-incontrolable`
- **Webhook not triggering**: Check `pm2 logs deploy-webhook` and verify firewall allows port 9000
- **WebSocket errors**: Make sure nginx config has the Upgrade headers (should be there by default)
