# 🎵 SONGLINE – The Music Timeline Party Game

**Listen. Guess the year. Build your timeline.**

Songline is a self-hosted party game for your home network. A song plays, and you place it on your timeline by release year – before, between or after the cards you already have. First to fill their timeline wins.

Everyone plays in the browser on their phone, tablet or laptop. Only the host needs Spotify Premium; all other players join by scanning a QR code – no account, no app.

> 🇩🇪 🇬🇧 The game is available in German and English – every player picks their own language.
>
> Inspired by the card game HITSTER. Songline is an unofficial fan project and not affiliated with or endorsed by its publisher or by Spotify.

---

## ✨ Features

**Game modes**
- **Classic** – place songs on your timeline, following the original rules: start card, tokens, the **SONGLINE!** challenge (steal a card from someone who placed it wrong) and buying cards. Three variants: **Original**, **Pro** (title + artist required) and **Expert** (exact year too).
- **Guess – Easy / Hard** – guess the title (and artist). Typo-tolerant, with suggestions while typing.
- **Teams** – 2–4 teams with a shared timeline; any team member may play for their team.
- **Song Battle (solo)** – 16, 32 or 64 songs (random from Spotify, a play pack or your own playlist) in a knockout bracket: listen to every duel and pick the winner until one song is left.

**Party features**
- **TV view** for a TV or projector: whose turn it is, the active timeline, SONGLINE! countdown, reveal with cover art, leaderboard and podium.
- **Join via QR code** or invite link – also into running games.
- **Play on any speaker**: the host's browser or any Spotify Connect device (phone, PC, smart speaker, TV), with volume control and fade-out.
- **"Play again!"** with the same players, teams and settings – without repeating songs.
- **Phone-friendly**: dedicated mobile layout with large tap targets and a thumb action bar.

**Robust**
- Reconnects after reloads or Wi-Fi drops; players can step out to the lobby and rejoin without losing their score.
- If the host disconnects, the game pauses until they're back. Running games even survive a server restart.
- Uses the **earliest release year** of a song instead of the year of a remaster or best-of album.

---

## 📋 Requirements

- A computer in your home network that stays on while you play – e.g. a **Raspberry Pi**, a home server or a laptop (Linux, macOS or Windows with WSL)
- **Docker** with **Docker Compose** ([install Docker](https://docs.docker.com/get-docker/))
- A **Spotify Premium** account for the host
- A free **Spotify developer app** (for the Client ID and Client Secret) – see below

---

## 🚀 Quick start

### 1. Create a Spotify app
1. Open the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in.
2. **Create app** – any name/description; tick **Web API** and **Web Playback SDK**.
3. Note the **Client ID** and **Client Secret** (Settings).
4. The Redirect URI is added in step 3 below.

### 2. Get the code and run the setup
```bash
git clone https://github.com/Tom13372448/Songline.git
cd Songline
./setup.sh
```
The script detects your IP address, asks for the Spotify credentials, creates the `.env` file and a self-signed HTTPS certificate, and starts the containers.

### 3. Add the Redirect URI
In your Spotify app → **Settings** → **Redirect URIs** add exactly:
```
https://<Your_IP_Address>/api/callback
```
(the setup script shows the exact address)

### 4. Play
Open `https://<Your_IP_Address>` on any device in your network.
The first visit shows a security warning because the certificate is self-signed → **Advanced** → **Proceed / Accept the risk** (once per device).

---

## 🎮 How to play

1. **Host:** enter your name and tap **Host a game** – you'll log in with Spotify once.
2. **Players:** scan the QR code (or open the address and enter the 4-letter code).
3. **Host:** choose mode, music (preset play pack, your own Spotify playlist or manual search) and the playback device – then **Start game**.
4. Optional: open **Show on TV** to put the TV view on a big screen.

The full rules are in the game under **How to play**.

---

## 🛠 Manual setup (without the script)

```bash
# 1. Certificate (replace <Your_IP_Address>)
mkdir -p certs
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=<Your_IP_Address>" -addext "subjectAltName=IP:<Your_IP_Address>"

# 2. Configuration
cp .env.example .env
#   then edit .env:
#   SPOTIFY_CLIENT_ID=your_client_id
#   SPOTIFY_CLIENT_SECRET=your_client_secret
#   REDIRECT_URI=https://<Your_IP_Address>/api/callback

# 3. Start
docker compose up --build -d
```

---

## ⚙️ Customizing

- **Preset play packs:** edit `PRESET_PACKS` at the top of [`backend/server.js`](backend/server.js). Each entry is a Spotify playlist ID (from the share link `https://open.spotify.com/playlist/<ID>`); name, cover and song count are loaded from Spotify.
- **Game rules:** start tokens, max tokens, card price and SONGLINE! countdown are constants at the top of `backend/server.js`.
- **Translations:** all texts live in [`frontend/public/i18n.js`](frontend/public/i18n.js) – add another language by adding a block.
- **Colours:** design tokens are at the top of [`frontend/public/styles.css`](frontend/public/styles.css).

---

## 🧰 Maintenance

| Task | Command |
|------|---------|
| Update after code changes | `docker compose up --build -d` |
| Apply changes to `.env` | `docker compose up -d` (a plain `restart` does not reload it) |
| View logs | `docker compose logs -f` |
| Renew the certificate (after 365 days) | `./renew-cert.sh` |
| Stop | `docker compose down` |
| Run the tests | `docker run --rm -v "$PWD/backend":/app -w /app node:20-alpine sh -c "npm install && npm test"` |

---

## ❓ Troubleshooting

**Spotify login fails with `INVALID_CLIENT` / "Invalid redirect URI"**
The Redirect URI in your Spotify app must match `REDIRECT_URI` in `.env` exactly – including `https://` and `/api/callback`.

**Spotify login fails with "Invalid client secret"**
The secret in `.env` is outdated (e.g. after rotating it in the dashboard). Update `.env` and run `docker compose up -d`.

**Only my own account can log in as host**
New Spotify apps run in *development mode*: add the Spotify accounts of your hosts under **User Management** in the dashboard.

**No sound / "Spotify Premium required"**
The host needs Spotify Premium. If you play on a Spotify Connect device, open Spotify on that device first so it shows up in the device list.

**Colours look wrong on a phone**
Turn off the browser's forced dark mode for the site (e.g. Samsung Internet → dark mode).

---

## 🏗 Architecture

```
Home network ──▶ :443 HTTPS ──▶ nginx (TLS) ──▶ songline-app (Node.js: Express + Socket.IO)
                                                     │
                                                     └──▶ Spotify Web API
```

```
backend/
  server.js         Express + Socket.IO server, lobby and game flow
  game-logic.js     Pure game logic (answer matching, placement, year correction)
  persistence.js    Saves lobbies to ./data so games survive restarts
  test/             Unit and integration tests
frontend/public/
  index.html        Markup of all screens
  i18n.js           German/English translations
  app.js            Client logic
  tv.js             TV view
  battle.js         Song Battle (solo knockout tournament)
  effects.js        Sounds and confetti
  styles.css        Styles (desktop, mobile, TV)
nginx/default.conf  HTTPS reverse proxy
setup.sh            Interactive setup
renew-cert.sh       Renews the self-signed certificate
```

---

## 🔒 Security notes

- **Never commit `.env` or `certs/`** – they contain your Spotify secret and private key (both are in `.gitignore`).
- Songline is meant for your **home network**. Don't expose it to the internet without proper authentication and a real certificate.

---

## 📄 License

[MIT](LICENSE) © 2026 Tom13372448

Spotify is a trademark of Spotify AB. HITSTER is a trademark of its respective owner. This project is not affiliated with either.
