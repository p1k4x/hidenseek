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
import type { MatchOutcome, PosePayload, RoomState } from "./net/protocol";
import { Player } from "./player";
import { Seeker } from "./seeker";
import { TouchControls } from "./touch";
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
const POSE_INTERVAL_MS = 1000 / 15;

export class Game {
  private readonly scene: Scene;
  private readonly player: Player;
  private readonly seeker: Seeker;
  private readonly hiderSpawn: Vector3;
  private readonly seekerSpawn: Vector3;
  private readonly net = new NetClient();
  private readonly touch = new TouchControls();
  private mode: GameMode = "solo";
  private role: Role = "hider";
  private phase: Phase = "idle";
  private phaseEndsAt = 0;
  private lastSecond = -1;
  private room: RoomState | null = null;
  private lastPoseSentAt = 0;
  private remoteTarget: PosePayload | null = null;
  private remoteReady = false;

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
        // After WS resume mid-match, keep the arena up — don't flash the lobby.
        if (this.phase === "hiding" || this.phase === "seeking") {
          return;
        }
        showLobby(room);
      },
      onMatchStart: (hideEndsAt) => {
        if (!this.room) return;
        this.startOnlineMatch(this.room.role, hideEndsAt);
      },
      onPhase: (phase, endsAt) => {
        if (this.mode !== "online") return;
        if (phase === "seeking" && this.phase === "hiding") {
          this.enterSeekingFromServer(endsAt);
        }
      },
      onPose: (pose) => {
        if (this.mode !== "online") return;
        if (pose.role === this.role) return;
        this.remoteTarget = pose;
        if (!this.remoteReady) {
          this.applyRemotePose(pose, false);
          this.remoteReady = true;
        }
      },
      onSpotted: (active) => {
        if (this.mode !== "online" || this.phase !== "seeking") return;
        this.setSpottedDetail(active);
      },
      onMatchEnd: (outcome) => {
        if (this.mode !== "online") return;
        this.endOnlineMatch(outcome);
      },
      onMatchResume: (resume) => {
        if (this.mode !== "online") return;
        this.applyMatchResume(resume);
      },
      onPeerReconnecting: () => {
        if (this.phase === "hiding" || this.phase === "seeking") {
          const detail = document.getElementById("phaseDetail");
          if (detail) detail.textContent = "Opponent reconnecting…";
          return;
        }
        if (this.room) {
          showLobby(this.room, "Opponent reconnecting…");
        }
      },
      onPeerResumed: () => {
        if (this.phase === "hiding" || this.phase === "seeking") {
          const detail = document.getElementById("phaseDetail");
          if (detail) {
            detail.textContent =
              this.phase === "hiding"
                ? this.role === "seeker"
                  ? "Hider is finding cover. You unlock when the hunt starts."
                  : "Get behind cover before the seeker wakes up."
                : this.role === "seeker"
                  ? "Find the hider before time runs out."
                  : "Stay out of the seeker's line of sight.";
          }
          return;
        }
        if (this.room) {
          showLobby(this.room);
        }
      },
      onReconnecting: () => {
        if (this.phase === "hiding" || this.phase === "seeking") {
          const detail = document.getElementById("phaseDetail");
          if (detail) detail.textContent = "Reconnecting…";
          return;
        }
        if (this.room) {
          showLobby(this.room, "Reconnecting…");
        }
      },
      onPeerLeft: () => {
        if (this.phase === "hiding" || this.phase === "seeking") {
          this.phase = "idle";
          this.remoteTarget = null;
          this.remoteReady = false;
          this.touch.hide();
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
        if (this.phase === "hiding" || this.phase === "seeking") {
          this.phase = "idle";
          this.remoteTarget = null;
          this.remoteReady = false;
          this.touch.hide();
          document.exitPointerLock();
          this.net.disconnect();
          this.room = null;
          showOnlineMenu(message);
          return;
        }
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
        this.remoteTarget = null;
        this.remoteReady = false;
        this.touch.hide();
        this.net.disconnect();
        this.room = null;
        showModeMenu();
      },
    });

    this.canvas.addEventListener("click", () => {
      if (this.touch.available) return;
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
    this.remoteTarget = null;
    this.remoteReady = false;

    if (role === "hider") {
      this.player.configure("primary", true);
      this.seeker.configure(false, "secondary", false);
      this.scene.activeCamera = this.player.camera;
    } else {
      this.player.configure("primary", false);
      this.seeker.configure(true, "primary", true);
      this.scene.activeCamera = this.seeker.camera;
      // Hide the remote hider until seeking starts.
      this.player.body.isVisible = false;
    }

    setHintForSetup("online", role);
    this.beginRound(hideEndsAtUnixMs);
  }

  private startConfigured(mode: GameMode, role: Role): void {
    this.mode = mode;
    this.role = role;
    this.remoteTarget = null;
    this.remoteReady = false;

    this.player.configure("primary", true);
    this.seeker.configure(false, "secondary", false);
    this.scene.activeCamera = this.player.camera;

    setHintForSetup(mode, role);
    this.beginRound();
  }

  private beginRound(hideEndsAtUnixMs?: number): void {
    hideOverlay();
    this.player.reset(this.hiderSpawn);
    this.seeker.reset(this.seekerSpawn);
    this.seeker.setActive(false);
    this.player.setInputEnabled(this.role === "hider");
    if (this.mode === "online" && this.role === "seeker") {
      this.player.body.isVisible = false;
    }

    this.phase = "hiding";
    if (hideEndsAtUnixMs != null) {
      const delayMs = Math.max(0, hideEndsAtUnixMs - Date.now());
      this.phaseEndsAt = performance.now() + delayMs;
    } else {
      this.phaseEndsAt = performance.now() + HIDE_SECONDS * 1000;
    }
    this.lastSecond = -1;
    this.lastPoseSentAt = 0;
    const secondsLeft = Math.max(0, Math.ceil((this.phaseEndsAt - performance.now()) / 1000));
    setPhaseUi(this.phase, secondsLeft, this.role);

    this.canvas.focus();
    this.touch.show();
    if (!this.touch.available) {
      void this.canvas.requestPointerLock();
    }
  }

  private enterSeekingFromServer(endsAtUnixMs: number, delayMs?: number): void {
    const delay = delayMs ?? Math.max(0, endsAtUnixMs - Date.now());
    this.phase = "seeking";
    this.phaseEndsAt = performance.now() + delay;
    if (this.role === "seeker") {
      this.seeker.setActive(true);
      this.player.body.isVisible = true;
    }
    this.player.setInputEnabled(this.role === "hider");
    this.lastSecond = -1;
    const secondsLeft = Math.max(0, Math.ceil(delay / 1000));
    setPhaseUi(this.phase, secondsLeft, this.role);
  }

  private applyMatchResume(resume: { phase: "hiding" | "seeking"; endsAt: number; spotted: boolean }): void {
    const delayMs = Math.max(0, resume.endsAt - Date.now());
    this.lastSecond = -1;

    if (resume.phase === "seeking" && this.phase !== "seeking") {
      this.enterSeekingFromServer(resume.endsAt, delayMs);
    } else if (resume.phase === "hiding") {
      this.phase = "hiding";
      this.phaseEndsAt = performance.now() + delayMs;
      this.seeker.setActive(false);
      this.player.setInputEnabled(this.role === "hider");
      if (this.role === "seeker") {
        this.player.body.isVisible = false;
      }
      const secondsLeft = Math.max(0, Math.ceil(delayMs / 1000));
      setPhaseUi(this.phase, secondsLeft, this.role);
    } else {
      this.phaseEndsAt = performance.now() + delayMs;
      const secondsLeft = Math.max(0, Math.ceil(delayMs / 1000));
      setPhaseUi(this.phase, secondsLeft, this.role);
    }

    if (resume.phase === "seeking") {
      this.setSpottedDetail(resume.spotted);
    }

    this.touch.show();
  }

  private setSpottedDetail(active: boolean): void {
    const detail = document.getElementById("phaseDetail");
    if (!detail) return;
    if (active) {
      detail.textContent =
        this.role === "seeker"
          ? "You spotted the hider — close in!"
          : "Spotted! The seeker is chasing you.";
    } else {
      detail.textContent =
        this.role === "seeker"
          ? "Find the hider before time runs out."
          : "Stay out of the seeker's line of sight.";
    }
  }

  private update(): void {
    const touch = this.touch.sample();

    if (this.mode === "online" && (this.phase === "hiding" || this.phase === "seeking")) {
      this.updateOnline(touch);
      return;
    }

    if (this.phase === "hiding" || this.phase === "seeking") {
      if (this.role === "hider") {
        this.player.update(touch);
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
      this.seeker.setActive(true);
      this.player.setInputEnabled(this.role === "hider");
      this.lastSecond = -1;
      setPhaseUi(this.phase, SEEK_SECONDS, this.role);
    }

    if (this.phase === "seeking") {
      const { spotted, caught } = this.seeker.update(this.player.position, touch);
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
    }
  }

  private updateOnline(touch: ReturnType<TouchControls["sample"]>): void {
    const now = performance.now();

    if (this.role === "hider") {
      this.player.update(touch);
    } else {
      // Local seeker: move/look; catch is decided on the server.
      this.seeker.update(this.player.position, touch);
    }

    if (this.remoteTarget) {
      this.applyRemotePose(this.remoteTarget, true);
    }

    if (now - this.lastPoseSentAt >= POSE_INTERVAL_MS) {
      this.lastPoseSentAt = now;
      const pose = this.role === "hider" ? this.player.getPose() : this.seeker.getPose();
      this.net.sendPose(pose.x, pose.y, pose.z, pose.yaw);
    }

    const secondsLeft = Math.max(0, Math.ceil((this.phaseEndsAt - now) / 1000));
    if (secondsLeft !== this.lastSecond) {
      this.lastSecond = secondsLeft;
      setPhaseUi(this.phase, secondsLeft, this.role);
    }
    // Hide→seek and match end are server-authoritative (phase / matchEnd messages).
  }

  private applyRemotePose(pose: PosePayload, smooth: boolean): void {
    // Neither avatar is revealed during the hide phase.
    if (this.phase === "hiding") return;
    if (pose.role === "hider") {
      this.player.setRemotePose(pose.x, pose.y, pose.z, pose.yaw, smooth);
    } else {
      this.seeker.setRemotePose(pose.x, pose.y, pose.z, pose.yaw, smooth);
    }
  }

  private endOnlineMatch(outcome: MatchOutcome): void {
    const localWon =
      (outcome === "caught" && this.role === "seeker") ||
      (outcome === "escaped" && this.role === "hider");
    this.endRound(localWon ? "won" : "lost");
  }

  private endRound(result: "won" | "lost"): void {
    this.phase = result;
    this.seeker.setActive(false);
    this.remoteTarget = null;
    this.remoteReady = false;
    this.touch.hide();
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
