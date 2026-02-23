#!/bin/bash
# deploy.sh — Auto-deploy script for game-incontrolable
# This runs on the VPS whenever you push to the main branch

set -e

APP_DIR="/var/www/game-incontrolable"
BRANCH="main"

echo "=== 🚀 Deploying game-incontrolable ==="
echo "$(date)"

cd "$APP_DIR"

# Pull latest code
echo "📥 Pulling latest from $BRANCH..."
git fetch origin
git reset --hard "origin/$BRANCH"

# Install dependencies
echo "📦 Installing dependencies..."
npm ci --production=false

# Build client
echo "🔨 Building client..."
npm run build

# Restart server
echo "♻️  Restarting PM2 process..."
pm2 restart ecosystem.config.cjs --update-env

echo "✅ Deploy complete!"
