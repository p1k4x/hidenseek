import type { GameMode, Phase, Role } from "./types";
import type { RoomState } from "./net/protocol";

export type MenuScreen =
  | "mode"
  | "online"
  | "createRole"
  | "join"
  | "lobby"
  | "result";

let currentScreen: MenuScreen = "mode";

export function setPhaseUi(phase: Phase, secondsLeft: number, role: Role = "hider"): void {
  const title = document.getElementById("phaseTitle");
  const detail = document.getElementById("phaseDetail");
  if (!title || !detail) return;

  const asSeeker = role === "seeker";

  switch (phase) {
    case "idle":
      title.textContent = "Ready";
      detail.textContent = "Choose a mode to start.";
      break;
    case "hiding":
      title.textContent = asSeeker ? `Wait… ${secondsLeft}s` : `Hide! ${secondsLeft}s`;
      detail.textContent = asSeeker
        ? "Hider is finding cover. You unlock when the hunt starts."
        : "Get behind cover before the seeker wakes up.";
      break;
    case "seeking":
      title.textContent = asSeeker ? `Hunt ${secondsLeft}s` : `Survive ${secondsLeft}s`;
      detail.textContent = asSeeker
        ? "Find the hider before time runs out."
        : "Stay out of the seeker's line of sight.";
      break;
    case "won":
      title.textContent = asSeeker ? "Caught them!" : "You hid!";
      detail.textContent = asSeeker
        ? "You found the hider in time."
        : "The seeker never caught you.";
      break;
    case "lost":
      title.textContent = asSeeker ? "They escaped!" : "Found!";
      detail.textContent = asSeeker
        ? "The hider survived the hunt."
        : "The seeker spotted you.";
      break;
  }
}

export function showModeMenu(): void {
  currentScreen = "mode";
  setOverlay(
    "Hide & Seek",
    "One player vs AI, or Online with a friend on another phone or browser.",
    [
      { id: "btnSolo", label: "One Player" },
      { id: "btnOnline", label: "Online" },
    ],
  );
}

export function showOnlineMenu(error = ""): void {
  currentScreen = "online";
  const body = error
    ? error
    : "Host creates a room and picks a role. Guest joins with the code and gets the other role.";
  setOverlay("Online", body, [
    { id: "btnCreateRoom", label: "Create room" },
    { id: "btnJoinRoom", label: "Join room" },
    { id: "btnBack", label: "Back", secondary: true },
  ]);
}

export function showCreateRoleMenu(): void {
  currentScreen = "createRole";
  setOverlay(
    "Your role",
    "You host the room. The guest is assigned the opposite role.",
    [
      { id: "btnHider", label: "Host as Hider" },
      { id: "btnSeeker", label: "Host as Seeker" },
      { id: "btnBack", label: "Back", secondary: true },
    ],
  );
}

export function showJoinMenu(error = ""): void {
  currentScreen = "join";
  setOverlayHtml(
    "Join room",
    error || "Enter the 4-letter code from the host.",
    `
      <label class="field">
        <span>Room code</span>
        <input id="joinCode" type="text" maxlength="6" autocomplete="off" spellcheck="false" placeholder="ABCD" />
      </label>
      <div id="overlayActions" class="actions">
        <button type="button" id="btnDoJoin">Join</button>
        <button type="button" id="btnBack" class="secondary">Back</button>
      </div>
    `,
  );
  const input = document.getElementById("joinCode") as HTMLInputElement | null;
  input?.focus();
}

export function showLobby(room: RoomState, statusNote = ""): void {
  currentScreen = "lobby";
  const roleLabel = room.role === "hider" ? "Hider" : "Seeker";
  const wait = room.guestConnected
    ? room.isHost
      ? "Opponent joined. Start when ready."
      : "Waiting for host to start…"
    : "Waiting for opponent to join…";
  const note = statusNote || wait;
  const buttons: Array<{ id: string; label: string; secondary?: boolean }> = [];
  if (room.isHost && room.guestConnected) {
    buttons.push({ id: "btnStartMatch", label: "Start" });
  }
  buttons.push({ id: "btnLeaveLobby", label: "Leave", secondary: true });

  setOverlay(
    `Room ${room.code}`,
    `You are the ${roleLabel}. ${note}`,
    buttons,
  );
}

export function showResult(message: string, mode: GameMode): void {
  currentScreen = "result";
  const actions =
    mode === "online"
      ? [
          { id: "btnMenu", label: "Main menu" },
        ]
      : [
          { id: "btnAgain", label: "Play again" },
          { id: "btnMenu", label: "Main menu", secondary: true },
        ];
  setOverlay("Round over", message, actions);
}

export function hideOverlay(): void {
  document.getElementById("overlay")?.classList.add("hidden");
}

export function getMenuScreen(): MenuScreen {
  return currentScreen;
}

export function getJoinCode(): string {
  const input = document.getElementById("joinCode") as HTMLInputElement | null;
  return input?.value.trim().toUpperCase() ?? "";
}

export function setHintForSetup(mode: GameMode, role: Role): void {
  const hint = document.getElementById("hint");
  if (!hint) return;

  if (mode === "solo") {
    hint.innerHTML = "WASD move · mouse look · Shift sprint<br />Esc releases the mouse";
    return;
  }

  const who = role === "hider" ? "Hider" : "Seeker";
  hint.innerHTML = `${who}: WASD + mouse · Shift sprint<br />Esc releases the mouse · Online sync on`;
}

function setOverlay(
  title: string,
  body: string,
  buttons: Array<{ id: string; label: string; secondary?: boolean }>,
): void {
  const actionsHtml = buttons
    .map((button) => {
      const cls = button.secondary ? ' class="secondary"' : "";
      return `<button type="button" id="${button.id}"${cls}>${button.label}</button>`;
    })
    .join("");

  setOverlayHtml(
    title,
    body,
    `<div id="overlayActions" class="actions">${actionsHtml}</div>`,
  );
}

function setOverlayHtml(title: string, body: string, actionsInnerHtml: string): void {
  const overlay = document.getElementById("overlay");
  const titleEl = document.getElementById("overlayTitle");
  const text = document.getElementById("overlayText");
  const panel = overlay?.querySelector(".panel");
  if (!overlay || !titleEl || !text || !panel) return;

  titleEl.textContent = title;
  text.textContent = body;

  let actionsHost = document.getElementById("overlayExtra");
  if (!actionsHost) {
    actionsHost = document.createElement("div");
    actionsHost.id = "overlayExtra";
    panel.appendChild(actionsHost);
  }
  actionsHost.innerHTML = actionsInnerHtml;
  overlay.classList.remove("hidden");
}

export type MenuHandlers = {
  onSolo: () => void;
  onOnline: () => void;
  onCreateRoom: () => void;
  onJoinRoom: () => void;
  onHostRole: (role: Role) => void;
  onDoJoin: () => void;
  onStartMatch: () => void;
  onLeaveLobby: () => void;
  onBack: () => void;
  onAgain: () => void;
  onMenu: () => void;
};

export function bindMenuClicks(handlers: MenuHandlers): void {
  document.getElementById("overlay")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.tagName !== "BUTTON") return;

    switch (target.id) {
      case "btnSolo":
        handlers.onSolo();
        break;
      case "btnOnline":
        handlers.onOnline();
        break;
      case "btnCreateRoom":
        handlers.onCreateRoom();
        break;
      case "btnJoinRoom":
        handlers.onJoinRoom();
        break;
      case "btnHider":
        handlers.onHostRole("hider");
        break;
      case "btnSeeker":
        handlers.onHostRole("seeker");
        break;
      case "btnDoJoin":
        handlers.onDoJoin();
        break;
      case "btnStartMatch":
        handlers.onStartMatch();
        break;
      case "btnLeaveLobby":
        handlers.onLeaveLobby();
        break;
      case "btnBack":
        handlers.onBack();
        break;
      case "btnAgain":
        handlers.onAgain();
        break;
      case "btnMenu":
        handlers.onMenu();
        break;
    }
  });

  document.getElementById("overlay")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || currentScreen !== "join") return;
    handlers.onDoJoin();
  });
}
