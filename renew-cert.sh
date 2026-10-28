#!/bin/bash
# Renew the self-signed certificate (run after 365 days)

cd "$(dirname "$0")"
SERVER_IP=$(sed -nE 's|^REDIRECT_URI=https?://([0-9.]+).*|\1|p' .env)
if [ -z "$SERVER_IP" ]; then echo "❌ No IP address found in REDIRECT_URI (.env)"; exit 1; fi
mkdir -p certs

echo "🔐 Renewing certificate for IP: $SERVER_IP"

openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -subj "/CN=${SERVER_IP}" \
  -addext "subjectAltName=IP:${SERVER_IP}" \
  2>/dev/null

docker compose restart nginx
echo "✅ Done! The certificate is valid for another 365 days."
