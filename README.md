# Hide & Seek

A small 3D browser hide-and-seek prototype built with [Babylon.js](https://www.babylonjs.com/) and Vite, plus an ASP.NET Core lobby server for online rooms.

## Play

### Docker (client + lobby)

Requires [Docker](https://docs.docker.com/get-docker/) with Compose.

```bash
docker compose up --build
```

Open `http://localhost:8082`. The container process listens on **8080 inside the image**; Compose maps that to host **8082** (`HIDENSEEK_PORT` to override). The game UI and WebSocket lobby (`/ws`) share that port.

### Unraid

Copy this repo to `/mnt/user/appdata/hidenseek` (or `git clone https://github.com/p1k4x/hidenseek.git .` once). To refresh from GitHub and rebuild:

```bash
cd /mnt/user/appdata/hidenseek
git fetch origin
git pull
docker build -t hidenseek .
docker rm -f hidenseek 2>/dev/null
docker run -d \
  --name hidenseek \
  -p 8082:8080 \
  --restart unless-stopped \
  hidenseek
```

- Direct: `http://192.168.1.168:8082/`
- Via the home portal: `http://192.168.1.168:8080/hide/` (no portal rebuild needed when updating this container; only set `HIDE_UPSTREAM=http://192.168.1.168:8082` if the portal is not already pointing here)

### Client (local)

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). Vite binds `0.0.0.0` and allows LAN hosts.

On WSL2, Windows only forwards **localhost:5173** — a phone cannot use `http://<LAN-IP>:5173`. Forward that port on Windows (or a small TCP proxy) and open **`http://<LAN-IP>:3000/`** (this machine: `http://192.168.1.100:3000/`). Docker on `:8082` is already reachable on the LAN IP.

### Online lobby server (.NET 10, local)

Requires the [.NET 10 SDK](https://dotnet.microsoft.com/download).

```bash
dotnet run --project server/HideAndSeek.Server
```

Listens on `http://0.0.0.0:5080` (WebSocket path `/ws`). Use this together with `npm run dev` for local development.

Then in the game: **Online** → create a room (pick Hider or Seeker) → share the code → guest joins → host taps **Start**. Both clients share the hide timer, see each other (~15 Hz poses), and catch / escape is decided on the server.

On phones: left stick to move, drag the right side to look, hold **Sprint**, tap **Crouch** (stays crouched until you tap again). Crouch sits with Sprint on the right (portrait stacked, landscape A/B). No pointer lock required. Keyboard: WASD, Shift sprint, hold C to crouch. If a phone sleeps and the WebSocket drops, Online seats stay reserved for ~45s — the other player sees “reconnecting…”, then the match resumes when the phone wakes.

### Modes

- **One Player** — you are the hider; an AI seeker hunts you
- **Online** — two devices; host picks a role, guest gets the other

## Stack

- Babylon.js (`@babylonjs/core`) + TypeScript + Vite
- ASP.NET Core (.NET 10) WebSocket lobby server

Tracked on the [HS Jira board](https://pikachurro.atlassian.net/jira/software/projects/HS/boards/67).
