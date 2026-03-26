# Naval Command — Battleship

A Cold War-era tactical radar-themed multiplayer Battleship game. Two players face off in real time, placing fleets on a sonar grid and trading missile strikes and nuclear warheads until one fleet is destroyed. Built with Node.js, Express, and Socket.io.

The entire UI is styled as an 80s CRT radar console — scanline overlays, a rotating radar sweep, isometric grid perspective, animated ocean waves beneath the ships, and hull silhouettes with tapered bows and sterns. Hits trigger screen-shake, particle explosions, and synthesized impact sounds. Nuclear strikes play a 3-second siren countdown before detonating with a full-screen white flash.

## Deployment on Ubuntu 24.04

### Prerequisites

```bash
# Install Node.js 20.x (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node -v   # v20.x
npm -v    # 10.x
```

### Clone and install

```bash
git clone <your-repo-url> ~/battleship
cd ~/battleship
npm install --production
```

### Run directly

```bash
# Foreground
PORT=3000 node server.js

# Background with nohup
PORT=3000 nohup node server.js > battleship.log 2>&1 &
```

### Run as a systemd service (recommended)

Create the service file:

```bash
sudo tee /etc/systemd/system/battleship.service > /dev/null << 'EOF'
[Unit]
Description=Naval Command Battleship
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/home/YOUR_USERNAME/battleship
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
Environment=PORT=3000
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

Replace `YOUR_USERNAME` with your Linux user, then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable battleship
sudo systemctl start battleship

# Check status
sudo systemctl status battleship

# View logs
journalctl -u battleship -f
```

### Firewall

```bash
# Allow the port through ufw (if active)
sudo ufw allow 3000/tcp
```

### Reverse proxy with nginx (optional)

If you want to serve on port 80/443 behind nginx:

```bash
sudo apt-get install -y nginx
```

```nginx
# /etc/nginx/sites-available/battleship
server {
    listen 80;
    server_name your-domain-or-ip;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/battleship /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

The `Upgrade` and `Connection` headers are required for Socket.io WebSocket connections.

### HTTPS with Let's Encrypt (optional)

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## Local development (macOS)

```bash
brew install node
cd ~/hogwarts/battleship
npm install
npm start
```

The server starts at **http://localhost:3000**.

To play with someone on another network, use [ngrok](https://ngrok.com/):

```bash
brew install ngrok
ngrok http 3000
```

## How to Play

1. Open http://localhost:3000 and click **Create New Room**
2. Share the invite link with a second player (or open it in another tab)
3. Both players place 5 ships on the radar grid — click to place, press **R** to rotate
4. Take turns firing at the opponent's grid:
   - **Standard Missile** — hits a single cell (1x1)
   - **Nuclear Strike** — hits a 3x3 area, preceded by a 3-second siren countdown (configurable per room, default 2)
5. Sink all enemy ships to win
6. After the game, both players can vote for a **Rematch** to replay with fresh boards

## Ships

| Ship       | Size |
|------------|------|
| Carrier    | 5    |
| Battleship | 4    |
| Cruiser    | 3    |
| Submarine  | 3    |
| Destroyer  | 2    |

## Project Structure

```
server.js          Express + Socket.io server (game logic, room management, turn
                   enforcement, structured logging, client error reporting endpoint)
public/
  index.html       Single-page UI: lobby, placement, battle, game-over screens
  style.css        CRT radar theme, isometric grids, ship silhouettes, animations
  game.js          Client state machine, Socket.io events, Web Audio sound engine,
                   visual effects, client-side logging
.gitignore         Excludes node_modules, .env, logs
package.json       Dependencies: express, socket.io
```

## Features

**Gameplay**
- Server-authoritative turn logic — no client-side cheating
- Ship placement validation (bounds, overlap, contiguity)
- Nuclear strike with 3x3 hover preview and siren countdown
- Configurable nuke count per room (0-10)
- Room-based multiplayer with shareable invite links
- Rematch system — both players vote, board resets in-place
- Reconnection-aware (holds player slot on disconnect)

**Visuals**
- CRT scanline overlay with subtle flicker
- Rotating radar sweep on the attack grid
- Isometric 3D grid tilt with animated ocean waves (auto-disabled on mobile)
- Ship silhouettes: tapered bows, squared sterns, deck lines
- Particle explosions on hits, sonar ripple rings on misses
- Screen shake (light for missiles, heavy for nukes)
- Full-screen white flash on nuclear detonation
- Attack grid glow pulse on your turn, dimmed on opponent's turn

**Audio (Web Audio API, no external files)**
- Explosion impact on hit, missile whistle + water splash on miss
- Wailing siren + doom pulse countdown before nuclear strike
- Explosion rumble with sub-bass on detonation
- Descending tone on ship sunk
- Victory fanfare (ascending major chord) / defeat dirge (descending minor + rumble)

**Mobile**
- Touch-optimized: ship placement preview via drag, nuke radius preview on touch
- Responsive breakpoints for phones (480px) and tablets (850px)
- Safe area support for notch/Dynamic Island devices
- 3D effects and heavy animations auto-disabled on touch devices for battery

**Observability**
- Structured server logs (timestamped, tagged by event type)
- Client errors forwarded to server via POST /client-log
- Global uncaught error and unhandled rejection capture
- Active game stats logged every 30 seconds

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server listen port |
| `NODE_ENV` | —     | Set to `production` on your server |

Nuke count is configured per-room in the lobby UI (0-10).
