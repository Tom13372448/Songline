# 🎵 SONGLINE – The Music Timeline Quiz

A self-hosted party game for your home network: a song plays, and you place it on your timeline by release year.
Runs on a Raspberry Pi (or any Docker host) and is played in the browser on phones, tablets and laptops.

> **Note:** The game's user interface is in German.
> Inspired by the card game HITSTER – this is an unofficial fan project and not affiliated with its publisher.

---

## Features

- **Classic mode** following the original rules (start card, tokens, SONGLINE! challenge, buying cards) in three variants:
  **Original**, **Pro** (title + artist required) and **Expert** (additionally the exact year)
- **Guess modes**: Easy (title only) and Hard (title + artist), typo-tolerant with suggestions while typing
- **Team mode** with 2–4 teams – any team member may play for their team
- **Only the host needs Spotify Premium** – everyone else joins without a Spotify account
- **Playback device selection**: play in the host's browser or on any Spotify Connect device (phone, PC, smart speaker, TV)
- **Volume control** with gentle fade-out on reveal
- **TV view** for a TV/projector: all timelines, countdown, reveal and a QR code to join.
  Bring it to the TV via **TV code** (open `https://<Your_IP_Address>/tv` in the TV's browser and enter the code in the game),
  **casting** (Chrome cast dialog) or screen mirroring
- **QR code & invite link**, **joining running games**, **"Play again!"** with the same players and settings
- **Back to lobby** during a round without losing your score – rejoin any time
- **Reconnect** after a reload or Wi-Fi drop; if the host disconnects, the game pauses until they return
- Running games **survive a server restart** (stored in `./data/`)
- Release years: instead of remaster/best-of years, the earliest release of the song is used
- Host can **close the lobby** for everyone

---

## Requirements

- Docker with Docker Compose
- A Spotify account with **Premium** for the host
- A Spotify app from the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) (Client ID & Secret)

---

## Quick start (recommended)

```bash
git clone <your-repository-url> songline
cd songline
./setup.sh
```

The script automatically:
- detects the server's IP address
- asks for your Spotify credentials
- creates the `.env` file
- generates a self-signed SSL certificate (valid for 365 days)
- builds and starts the Docker containers

---

## Manual setup

### 1. Find your IP address
```bash
hostname -I
# e.g. <Your_IP_Address>
```

### 2. Create the SSL certificate
```bash
mkdir -p certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/key.pem \
  -out certs/cert.pem \
  -subj "/CN=<Your_IP_Address>" \
  -addext "subjectAltName=IP:<Your_IP_Address>"
```

### 3. Create the `.env` file
```bash
cp .env.example .env
nano .env
```
Fill in:
```
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
REDIRECT_URI=https://<Your_IP_Address>/api/callback
```

### 4. Configure the Spotify app
- Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
- Your app → **Settings** → **Redirect URIs**
- Add: `https://<Your_IP_Address>/api/callback`
- Save
- While the app is in development mode, add the Spotify accounts of your hosts under **User Management**

### 5. Start
```bash
docker compose up --build -d
```

### 6. Open in the browser
```
https://<Your_IP_Address>
```
→ Accept the security warning once (**Advanced** → **Accept the risk**), since the certificate is self-signed.

---

## How to play

1. The host enters their name, taps **Spiel hosten** (host game) and logs in with Spotify.
2. Everyone else opens `https://<Your_IP_Address>`, enters a name and the 4-letter lobby code – or scans the QR code.
3. The host picks a mode, a music source (preset packs, own playlist or manual search) and the playback device, then starts the game.

The rules are also explained in the game's start menu (**Spielregeln**).

---

## Architecture

```
Home network
       │
       ▼ Port 443 (HTTPS)
  ┌─────────┐
  │  nginx  │  ← SSL termination
  └────┬────┘
       │ internal HTTP
       ▼
  ┌──────────────┐
  │ hitster-app  │  ← Express.js + Socket.IO + Spotify Web API
  └──────────────┘
```

### Project structure

```
backend/
  server.js         Express + Socket.IO server, lobby and game flow
  game-logic.js     Pure game logic (answer matching, placement, year correction)
  persistence.js    Saves lobbies to ./data so games survive restarts
  test/             Unit and integration tests
frontend/public/
  index.html        Markup of all screens
  app.js            Client logic
  tv.js             TV/projector view
  effects.js        Sounds and confetti
  styles.css        Styles
nginx/default.conf  HTTPS reverse proxy
setup.sh            Interactive setup
renew-cert.sh       Renews the self-signed certificate
```

Preset play packs are configured in `PRESET_PACKS` at the top of `backend/server.js`.

---

## Tests

```bash
docker run --rm -v "$PWD/backend":/app -w /app node:20-alpine sh -c "npm install && npm test"
```

---

## Maintenance

### Renew the certificate (after 365 days)
```bash
./renew-cert.sh
```

### View logs
```bash
docker compose logs -f
docker compose logs nginx
docker compose logs hitster-app
```

### Restart
```bash
docker compose restart
```

### Update (after code changes)
```bash
docker compose up --build -d
```

> After changing `.env`, use `docker compose up -d` – a plain `restart` does not reload environment variables.

---

## Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 80   | HTTP     | Redirect to HTTPS |
| 443  | HTTPS    | Songline app |

The app port 3001 is not exposed – everything goes through nginx.

---

## Security notes

- **Never commit `.env` or `certs/`** – they contain your Spotify secret and private key (both are in `.gitignore`).
- If your Spotify client secret was ever published, rotate it in the Spotify dashboard.
