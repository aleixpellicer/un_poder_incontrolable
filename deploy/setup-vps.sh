#!/bin/bash
# ============================================================
# VPS Initial Setup Script for game-incontrolable
# Run this ONCE on a fresh Linux VPS (Ubuntu/Debian)
#
# Usage:  bash setup-vps.sh YOUR_GITHUB_REPO_URL [YOUR_DOMAIN]
# Example: bash setup-vps.sh https://github.com/youruser/game_incontrolable.git game.example.com
# ============================================================

set -e

REPO_URL="${1:?Usage: bash setup-vps.sh REPO_URL [DOMAIN]}"
DOMAIN="${2:-}"
APP_DIR="/var/www/game-incontrolable"
WEBHOOK_SECRET=$(openssl rand -hex 20)

echo "============================================"
echo "  🎮 game-incontrolable VPS Setup"
echo "============================================"
echo ""

# ── 1. System updates ──────────────────────────
echo "📦 Updating system packages..."
apt update && apt upgrade -y

# ── 2. Install Node.js (LTS via NodeSource) ────
echo "📦 Installing Node.js 20 LTS..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi
echo "   Node: $(node -v)"
echo "   npm: $(npm -v)"

# ── 3. Install PM2 globally ────────────────────
echo "📦 Installing PM2..."
npm install -g pm2

# ── 4. Install Nginx ───────────────────────────
echo "📦 Installing Nginx..."
apt install -y nginx

# ── 5. Install Git ──────────────────────────────
echo "📦 Installing Git..."
apt install -y git

# ── 6. Clone the repository ────────────────────
echo "📥 Cloning repository..."
if [ -d "$APP_DIR" ]; then
    echo "   Directory exists, pulling latest..."
    cd "$APP_DIR"
    git pull origin main
else
    git clone "$REPO_URL" "$APP_DIR"
    cd "$APP_DIR"
fi

# ── 7. Install dependencies & build ────────────
echo "📦 Installing dependencies..."
npm ci --production=false

echo "🔨 Building client..."
npm run build

# ── 8. Configure Nginx ─────────────────────────
echo "🔧 Configuring Nginx..."
if [ -n "$DOMAIN" ]; then
    sed "s/YOUR_DOMAIN/$DOMAIN/g" "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/game-incontrolable
else
    # Use default server (IP-based access)
    sed '/server_name/d' "$APP_DIR/deploy/nginx.conf" > /etc/nginx/sites-available/game-incontrolable
fi

ln -sf /etc/nginx/sites-available/game-incontrolable /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t && systemctl restart nginx

# ── 9. Setup firewall ──────────────────────────
echo "🔒 Configuring firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw allow 9000/tcp  # Webhook server port 
ufw --force enable

# ── 10. Start the game server with PM2 ─────────
echo "🚀 Starting game server with PM2..."
cd "$APP_DIR"
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash

# ── 11. Start webhook server with PM2 ──────────
echo "🪝 Starting webhook server..."
WEBHOOK_SECRET="$WEBHOOK_SECRET" pm2 start deploy/webhook-server.js --name "deploy-webhook" --node-args="--env-file=/dev/null"
pm2 save

# ── 12. SSL (optional, if domain provided) ─────
if [ -n "$DOMAIN" ]; then
    echo "🔐 Setting up SSL with Let's Encrypt..."
    apt install -y certbot python3-certbot-nginx
    certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@"$DOMAIN" || {
        echo "   ⚠️  SSL setup failed. You can run it manually later:"
        echo "   sudo certbot --nginx -d $DOMAIN"
    }
fi

# ── Done! ───────────────────────────────────────
echo ""
echo "============================================"
echo "  ✅ Setup Complete!"
echo "============================================"
echo ""
echo "  🎮 Game server:   http://${DOMAIN:-YOUR_VPS_IP}"
echo "  🪝 Webhook URL:   http://${DOMAIN:-YOUR_VPS_IP}:9000/webhook"
echo "  🔑 Webhook secret: $WEBHOOK_SECRET"
echo ""
echo "  Save the webhook secret! You'll need it for GitHub."
echo ""
echo "  📋 Next steps:"
echo "  1. Create a GitHub repo and push your code"
echo "  2. Go to GitHub repo → Settings → Webhooks → Add webhook"
echo "     - Payload URL: http://${DOMAIN:-YOUR_VPS_IP}:9000/webhook"
echo "     - Content type: application/json"
echo "     - Secret: $WEBHOOK_SECRET"
echo "     - Events: Just the push event"
echo "  3. Push to 'main' branch and it will auto-deploy!"
echo ""
echo "  🔧 Useful PM2 commands:"
echo "  pm2 status        — View running processes"
echo "  pm2 logs           — View all logs"
echo "  pm2 logs game-incontrolable — Game server logs"
echo "  pm2 restart all    — Restart everything"
echo ""
