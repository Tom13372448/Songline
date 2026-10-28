#!/bin/bash
set -e

# ─────────────────────────────────────────────
# SONGLINE HTTPS Setup Script
# Runs on the Raspberry Pi
# ─────────────────────────────────────────────

echo ""
echo "🎵  SONGLINE – HTTPS Setup"
echo "─────────────────────────────────────────"

# 1. Detect IP
RASPI_IP=$(hostname -I | awk '{print $1}')
echo "📡  Erkannte Raspi-IP: $RASPI_IP"
echo ""
read -p "    IP korrekt? (Enter = ja, sonst neue IP eingeben): " INPUT_IP
if [ -n "$INPUT_IP" ]; then
  RASPI_IP=$INPUT_IP
fi

# 2. Ask for Spotify credentials
echo ""
read -p "🔑  Spotify Client ID: " CLIENT_ID
read -p "🔑  Spotify Client Secret: " CLIENT_SECRET

# 3. Write .env
cat > .env <<EOF
SPOTIFY_CLIENT_ID=${CLIENT_ID}
SPOTIFY_CLIENT_SECRET=${CLIENT_SECRET}
REDIRECT_URI=https://${RASPI_IP}/api/callback
EOF
echo ""
echo "✅  .env erstellt"

# 4. Generate certificate
echo ""
echo "🔐  Erstelle selbst-signiertes SSL-Zertifikat (gültig 365 Tage)..."
mkdir -p certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -subj "/CN=${RASPI_IP}" \
  -addext "subjectAltName=IP:${RASPI_IP}" \
  2>/dev/null
echo "✅  Zertifikat erstellt in ./certs/"

# 5. Spotify dashboard reminder
echo ""
echo "─────────────────────────────────────────"
echo "⚠️   WICHTIG: Spotify Dashboard aktualisieren!"
echo ""
echo "    1. Gehe zu: https://developer.spotify.com/dashboard"
echo "    2. Deine App → Settings → Redirect URIs"
echo "    3. Füge hinzu: https://${RASPI_IP}/api/callback"
echo "    4. Speichern"
echo "─────────────────────────────────────────"
echo ""
read -p "    Fertig eingetragen? Dann Enter drücken um zu starten..."

# 6. Start Docker
echo ""
echo "🐳  Starte Docker Container..."
docker compose down 2>/dev/null || true
docker compose up --build -d

echo ""
echo "─────────────────────────────────────────"
echo "🎉  SONGLINE läuft!"
echo ""
echo "    Browser öffnen: https://${RASPI_IP}"
echo ""
echo "    Beim ersten Aufruf: Sicherheitswarnung"
echo "    → 'Erweitert' → 'Risiko akzeptieren'"
echo "─────────────────────────────────────────"
echo ""
