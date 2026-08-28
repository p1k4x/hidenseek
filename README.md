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

Copy this repo to `/mnt/user/appdata/hidenseek`, then:

```bash
cd /mnt/user/appdata/hidenseek
docker build -t hidenseek .
docker rm -f hidenseek 2>/dev/null
docker run -d \
  --name hidenseek \
  -p 8082:8080 \
  --restart unless-stopped \
  hidenseek
```

- Direct: `http://192.168.1.168:8082/`
- Via the home portal: rebuild **portal** with `HIDE_UPSTREAM=http://192.168.1.168:8082`, then `http://192.168.1.168:8080/hide/`

### Client (local)

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`). On a phone on the same LAN, use your machine’s LAN IP (Vite is bound with `host: true`).

### Online lobby server (.NET 10, local)

Requires the [.NET 10 SDK](https://dotnet.microsoft.com/download).

```bash
dotnet run --project server/HideAndSeek.Server
```

Listens on `http://0.0.0.0:5080` (WebSocket path `/ws`). Use this together with `npm run dev` for local development.

Then in the game: **Online** → create a room (pick Hider or Seeker) → share the code → guest joins → host taps **Start**. Both clients share the hide timer, see each other (~15 Hz poses), and catch / escape is decided on the server.

On phones: left stick to move, drag the right side to look, hold **Sprint**, tap **Crouch** (stays crouched until you tap again). In landscape, Crouch sits next to the stick so you can duck and steer with the same thumb. No pointer lock required. Keyboard: WASD, Shift sprint, hold C to crouch. If a phone sleeps and the WebSocket drops, Online seats stay reserved for ~45s — the other player sees “reconnecting…”, then the match resumes when the phone wakes.

### Modes

- **One Player** — you are the hider; an AI seeker hunts you
- **Online** — two devices; host picks a role, guest gets the other

## Stack

- Babylon.js (`@babylonjs/core`) + TypeScript + Vite
- ASP.NET Core (.NET 10) WebSocket lobby server

Tracked on the [HS Jira board](https://pikachurro.atlassian.net/jira/software/projects/HS/boards/67).
