#!/bin/bash
set -e

# ─────────────────────────────────────────────
# SONGLINE setup script
# Creates .env and a self-signed certificate, then starts Docker
# ─────────────────────────────────────────────

cd "$(dirname "$0")"

echo ""
echo "🎵  SONGLINE – setup"
echo "─────────────────────────────────────────"

# 1. Detect IP (Linux: hostname -I, macOS: ipconfig)
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$SERVER_IP" ] && SERVER_IP=$(ipconfig getifaddr en0 2>/dev/null || true)
echo "📡  Detected IP address: ${SERVER_IP:-unknown}"
echo ""
read -p "    Correct? (Enter = yes, otherwise type the IP): " INPUT_IP
if [ -n "$INPUT_IP" ]; then
  SERVER_IP=$INPUT_IP
fi
if [ -z "$SERVER_IP" ]; then
  echo "❌  No IP address given."; exit 1
fi

# 2. Ask for Spotify credentials
echo ""
read -p "🔑  Spotify Client ID: " CLIENT_ID
read -p "🔑  Spotify Client Secret: " CLIENT_SECRET

# 3. Write .env
cat > .env <<EOF
SPOTIFY_CLIENT_ID=${CLIENT_ID}
SPOTIFY_CLIENT_SECRET=${CLIENT_SECRET}
REDIRECT_URI=https://${SERVER_IP}/api/callback
EOF
chmod 600 .env
echo ""
echo "✅  .env created"

# 4. Generate certificate
echo ""
echo "🔐  Creating a self-signed SSL certificate (valid for 365 days)..."
mkdir -p certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -subj "/CN=${SERVER_IP}" \
  -addext "subjectAltName=IP:${SERVER_IP}" \
  2>/dev/null
echo "✅  Certificate created in ./certs/"

# 5. Spotify dashboard reminder
echo ""
echo "─────────────────────────────────────────"
echo "⚠️   IMPORTANT: update your Spotify app!"
echo ""
echo "    1. Go to: https://developer.spotify.com/dashboard"
echo "    2. Your app → Settings → Redirect URIs"
echo "    3. Add: https://${SERVER_IP}/api/callback"
echo "    4. Save"
echo "─────────────────────────────────────────"
echo ""
read -p "    Done? Press Enter to start..."

# 6. Start Docker
echo ""
echo "🐳  Starting Docker containers..."
docker compose down --remove-orphans 2>/dev/null || true
docker compose up --build -d

echo ""
echo "─────────────────────────────────────────"
echo "🎉  SONGLINE is running!"
echo ""
echo "    Open in your browser: https://${SERVER_IP}"
echo ""
echo "    First visit shows a security warning (self-signed certificate):"
echo "    → 'Advanced' → 'Accept the risk / Proceed'"
echo "─────────────────────────────────────────"
echo ""
