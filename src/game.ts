import { Engine } from "@babylonjs/core/Engines/engine";
import { Scene } from "@babylonjs/core/scene";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/core/Collisions/collisionCoordinator";
import "@babylonjs/core/Culling/ray";

import { buildArena } from "./arena";
import { NetClient } from "./net/client";
import type { RoomState } from "./net/protocol";
import { Player } from "./player";
import { Seeker } from "./seeker";
import type { GameMode, Phase, Role } from "./types";
import {
  bindMenuClicks,
  getJoinCode,
  getMenuScreen,
  hideOverlay,
  setHintForSetup,
  setPhaseUi,
  showCreateRoleMenu,
  showJoinMenu,
  showLobby,
  showModeMenu,
  showOnlineMenu,
  showResult,
} from "./ui";

const HIDE_SECONDS = 12;
const SEEK_SECONDS = 45;

export class Game {
  private readonly scene: Scene;
  private readonly player: Player;
  private readonly seeker: Seeker;
  private readonly hiderSpawn: Vector3;
  private readonly seekerSpawn: Vector3;
  private readonly net = new NetClient();
  private mode: GameMode = "solo";
  private role: Role = "hider";
  private phase: Phase = "idle";
  private phaseEndsAt = 0;
  private lastSecond = -1;
  private room: RoomState | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly canvas: HTMLCanvasElement,
  ) {
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.05, 0.08, 0.14, 1);

    const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), this.scene);
    hemi.intensity = 0.7;
    hemi.groundColor = new Color3(0.1, 0.12, 0.16);

    const sun = new DirectionalLight("sun", new Vector3(-0.4, -1, 0.35), this.scene);
    sun.position = new Vector3(12, 22, -8);
    sun.intensity = 0.85;

    const arena = buildArena(this.scene);
    this.hiderSpawn = arena.spawn;
    this.seekerSpawn = arena.seekerSpawn;

    this.player = new Player(this.scene, this.canvas, arena.spawn);
    const obstacles = [...arena.walls, ...arena.cover];
    this.seeker = new Seeker(this.scene, this.canvas, arena.seekerSpawn, obstacles);

    this.bindNet();
    this.bindUi();
    showModeMenu();
  }

  start(): void {
    this.engine.runRenderLoop(() => {
      this.update();
      this.scene.render();
    });
  }

  private bindNet(): void {
    this.net.setHandlers({
      onRoom: (room) => {
        this.room = room;
        this.role = room.role;
        showLobby(room);
      },
      onMatchStart: (hideEndsAt) => {
        if (!this.room) return;
        this.startOnlineMatch(this.room.role, hideEndsAt);
      },
      onPeerLeft: () => {
        if (this.phase === "hiding" || this.phase === "seeking") {
          this.phase = "idle";
          document.exitPointerLock();
          this.net.disconnect();
          this.room = null;
          showOnlineMenu("Opponent left. Create or join a new room.");
          return;
        }
        if (this.room?.isHost) {
          this.room = { ...this.room, guestConnected: false };
          showLobby(this.room, "Opponent left. Waiting for someone new…");
        } else {
          this.room = null;
          this.net.disconnect();
          showOnlineMenu("Host left the room.");
        }
      },
      onError: (message) => {
        const screen = getMenuScreen();
        if (screen === "join") {
          showJoinMenu(message);
        } else if (screen === "lobby" && this.room) {
          showLobby(this.room, message);
        } else {
          showOnlineMenu(message);
        }
      },
    });
  }

  private bindUi(): void {
    bindMenuClicks({
      onSolo: () => this.startConfigured("solo", "hider"),
      onOnline: () => showOnlineMenu(),
      onCreateRoom: () => showCreateRoleMenu(),
      onJoinRoom: () => showJoinMenu(),
      onHostRole: (role) => {
        void this.hostRoom(role);
      },
      onDoJoin: () => {
        void this.joinRoom(getJoinCode());
      },
      onStartMatch: () => this.net.start(),
      onLeaveLobby: () => {
        this.net.disconnect();
        this.room = null;
        showOnlineMenu();
      },
      onBack: () => {
        const screen = getMenuScreen();
        if (screen === "createRole" || screen === "join") {
          showOnlineMenu();
        } else if (screen === "online") {
          showModeMenu();
        } else {
          showModeMenu();
        }
      },
      onAgain: () => this.beginRound(),
      onMenu: () => {
        this.phase = "idle";
        this.net.disconnect();
        this.room = null;
        showModeMenu();
      },
    });

    this.canvas.addEventListener("click", () => {
      if (this.phase === "hiding" || this.phase === "seeking") {
        void this.canvas.requestPointerLock();
      }
    });
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.net.connected) return true;
    try {
      await this.net.connect();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection failed.";
      showOnlineMenu(message);
      return false;
    }
  }

  private async hostRoom(role: Role): Promise<void> {
    if (!(await this.ensureConnected())) return;
    this.net.create(role);
  }

  private async joinRoom(code: string): Promise<void> {
    if (!code) {
      showJoinMenu("Enter a room code.");
      return;
    }
    if (!(await this.ensureConnected())) return;
    this.net.join(code);
  }

  private startOnlineMatch(role: Role, hideEndsAtUnixMs: number): void {
    this.mode = "online";
    this.role = role;

    if (role === "hider") {
      this.player.configure("primary", true);
      this.seeker.configure(false, "secondary", false);
    } else {
      this.player.configure("primary", false);
      this.seeker.configure(true, "primary", true);
    }

    setHintForSetup("online", role);
    this.beginRound(hideEndsAtUnixMs);
  }

  private startConfigured(mode: GameMode, role: Role): void {
    this.mode = mode;
    this.role = role;

    this.player.configure("primary", true);
    this.seeker.configure(false, "secondary", false);

    setHintForSetup(mode, role);
    this.beginRound();
  }

  private beginRound(hideEndsAtUnixMs?: number): void {
    hideOverlay();
    this.player.reset(this.hiderSpawn);
    this.seeker.reset(this.seekerSpawn);
    this.seeker.setActive(false);
    this.player.setInputEnabled(this.role === "hider");

    this.phase = "hiding";
    if (hideEndsAtUnixMs != null) {
      const delayMs = Math.max(0, hideEndsAtUnixMs - Date.now());
      this.phaseEndsAt = performance.now() + delayMs;
    } else {
      this.phaseEndsAt = performance.now() + HIDE_SECONDS * 1000;
    }
    this.lastSecond = -1;
    const secondsLeft = Math.max(0, Math.ceil((this.phaseEndsAt - performance.now()) / 1000));
    setPhaseUi(this.phase, secondsLeft, this.role);

    this.canvas.focus();
    void this.canvas.requestPointerLock();
  }

  private update(): void {
    if (this.phase === "hiding" || this.phase === "seeking") {
      if (this.role === "hider") {
        this.player.update();
      }
    }

    const now = performance.now();
    const secondsLeft = Math.max(0, Math.ceil((this.phaseEndsAt - now) / 1000));

    if (secondsLeft !== this.lastSecond && (this.phase === "hiding" || this.phase === "seeking")) {
      this.lastSecond = secondsLeft;
      setPhaseUi(this.phase, secondsLeft, this.role);
    }

    if (this.phase === "hiding" && now >= this.phaseEndsAt) {
      this.phase = "seeking";
      this.phaseEndsAt = now + SEEK_SECONDS * 1000;
      if (this.mode === "solo") {
        this.seeker.setActive(true);
      } else if (this.role === "seeker") {
        this.seeker.setActive(true);
      }
      this.player.setInputEnabled(this.role === "hider");
      this.lastSecond = -1;
      setPhaseUi(this.phase, SEEK_SECONDS, this.role);
    }

    if (this.phase === "seeking") {
      if (this.mode === "online") {
        // Pose/catch sync is HS-4; online rounds end on the shared seek timer for now.
        if (this.role === "seeker") {
          this.seeker.update(this.player.position);
        }
        if (now >= this.phaseEndsAt) {
          this.endRound(this.role === "seeker" ? "lost" : "won");
        }
        return;
      }

      const { spotted, caught } = this.seeker.update(this.player.position);
      if (caught) {
        this.endRound(this.role === "seeker" ? "won" : "lost");
        return;
      }
      if (spotted) {
        const detail = document.getElementById("phaseDetail");
        if (detail) {
          detail.textContent =
            this.role === "seeker"
              ? "You spotted the hider — close in!"
              : "Spotted! The seeker is chasing you.";
        }
      }
      if (now >= this.phaseEndsAt) {
        this.endRound(this.role === "seeker" ? "lost" : "won");
      }
    } else if (this.phase === "hiding" && this.mode === "online" && this.role === "seeker") {
      this.seeker.update(this.player.position);
    }
  }

  private endRound(result: "won" | "lost"): void {
    this.phase = result;
    this.seeker.setActive(false);
    document.exitPointerLock();
    setPhaseUi(result, 0, this.role);

    const message =
      result === "won"
        ? this.role === "seeker"
          ? "You caught the hider. Rematch?"
          : "You stayed hidden long enough. Rematch?"
        : this.role === "seeker"
          ? "The hider escaped. Try a different search path."
          : "The seeker found you. Try a different hiding spot.";

    if (this.mode === "online") {
      this.net.disconnect();
      this.room = null;
    }

    showResult(message, this.mode);
  }
}
