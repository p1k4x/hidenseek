# Hide & Seek

A small 3D browser hide-and-seek prototype built with [Babylon.js](https://www.babylonjs.com/) and Vite, plus an ASP.NET Core lobby server for online rooms.

## Play

### Docker (client + lobby)

Requires [Docker](https://docs.docker.com/get-docker/) with Compose.

```bash
docker compose up --build
```

Open `http://localhost:8080`. The container serves the game UI and the WebSocket lobby at `/ws` on the same port.

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

Mobile touch controls are [HS-5](https://pikachurro.atlassian.net/browse/HS-5). Reconnect after phone sleep is [HS-6](https://pikachurro.atlassian.net/browse/HS-6).

### Modes

- **One Player** — you are the hider; an AI seeker hunts you
- **Online** — two devices; host picks a role, guest gets the other

## Stack

- Babylon.js (`@babylonjs/core`) + TypeScript + Vite
- ASP.NET Core (.NET 10) WebSocket lobby server

Tracked on the [HS Jira board](https://pikachurro.atlassian.net/jira/software/projects/HS/boards/67).
