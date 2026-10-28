#!/bin/bash
# Renew the certificate (run after 365 days)

cd "$(dirname "$0")"
RASPI_IP=$(grep REDIRECT_URI .env | grep -oP '(?<=://)[\d.]+')
if [ -z "$RASPI_IP" ]; then echo "❌ Keine IP in REDIRECT_URI (.env) gefunden"; exit 1; fi
mkdir -p certs

echo "🔐 Erneuere Zertifikat für IP: $RASPI_IP"

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -subj "/CN=${RASPI_IP}" \
  -addext "subjectAltName=IP:${RASPI_IP}" \
  2>/dev/null

docker compose restart nginx
echo "✅ Fertig! Zertifikat ist wieder 365 Tage gültig."
