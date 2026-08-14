import {
  defaultWsUrl,
  type ClientMessage,
  type MatchOutcome,
  type MatchResume,
  type PosePayload,
  type RoomState,
  type ServerMessage,
} from "./protocol";
import type { Role } from "../types";

const RECONNECT_MAX_MS = 40_000;
const RECONNECT_BASE_MS = 400;

export type NetHandlers = {
  onRoom?: (room: RoomState) => void;
  onMatchStart?: (hideEndsAt: number) => void;
  onPhase?: (phase: "hiding" | "seeking", endsAt: number) => void;
  onPose?: (pose: PosePayload) => void;
  onSpotted?: (active: boolean) => void;
  onMatchEnd?: (outcome: MatchOutcome) => void;
  onMatchResume?: (resume: MatchResume) => void;
  onPeerLeft?: () => void;
  onPeerReconnecting?: () => void;
  onPeerResumed?: () => void;
  onError?: (message: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onReconnecting?: () => void;
};

export class NetClient {
  private socket: WebSocket | null = null;
  private handlers: NetHandlers = {};
  private sessionId: string | null = null;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectStartedAt = 0;
  private reconnectAttempt = 0;
  private url = defaultWsUrl();
  private visibilityBound = false;

  setHandlers(handlers: NetHandlers): void {
    this.handlers = handlers;
    this.ensureVisibilityHook();
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get hasSession(): boolean {
    return Boolean(this.sessionId);
  }

  connect(url = defaultWsUrl()): Promise<void> {
    this.url = url;
    this.stopReconnectLoop();
    this.intentionalClose = false;
    return this.openSocket(false);
  }

  /** Intentional leave — no auto-resume. */
  disconnect(): void {
    this.stopReconnectLoop();
    this.intentionalClose = true;
    this.sessionId = null;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "leave" } satisfies ClientMessage));
      } catch {
        // Ignore leave failures while closing.
      }
    }
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }

  create(role: Role): void {
    this.send({ type: "create", role });
  }

  join(code: string): void {
    this.send({ type: "join", code: code.trim().toUpperCase() });
  }

  start(): void {
    this.send({ type: "start" });
  }

  sendPose(x: number, y: number, z: number, yaw: number, crouch = false): void {
    this.send({ type: "pose", x, y, z, yaw, crouch });
  }

  /** Kick a reconnect attempt if we dropped during lobby/match (e.g. phone woke). */
  tryResume(): void {
    if (this.intentionalClose || !this.sessionId) return;
    if (this.connected) return;
    if (this.reconnectTimer != null) return;
    this.beginReconnectLoop();
  }

  private openSocket(resume: boolean): Promise<void> {
    const previous = this.socket;
    this.socket = null;
    if (previous && (previous.readyState === WebSocket.OPEN || previous.readyState === WebSocket.CONNECTING)) {
      previous.close();
    }

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url);
      this.socket = socket;
      let settled = false;

      socket.addEventListener("open", () => {
        if (resume && this.sessionId) {
          socket.send(
            JSON.stringify({ type: "reconnect", sessionId: this.sessionId } satisfies ClientMessage),
          );
        }
        this.reconnectAttempt = 0;
        this.stopReconnectLoop();
        this.handlers.onOpen?.();
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Could not reach the lobby server. Is it running on port 5080?"));
        }
      });

      socket.addEventListener("close", () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.handlers.onClose?.();
        if (!this.intentionalClose && this.sessionId) {
          this.beginReconnectLoop();
        }
      });

      socket.addEventListener("message", (event) => {
        this.handleMessage(String(event.data));
      });
    });
  }

  private beginReconnectLoop(): void {
    if (this.reconnectTimer != null) return;
    this.reconnectStartedAt = performance.now();
    this.reconnectAttempt = 0;
    this.handlers.onReconnecting?.();
    this.scheduleReconnect(0);
  }

  private scheduleReconnect(delayMs: number): void {
    this.stopReconnectLoop();
    if (this.intentionalClose || !this.sessionId) return;
    if (performance.now() - this.reconnectStartedAt > RECONNECT_MAX_MS && this.reconnectAttempt > 0) {
      this.sessionId = null;
      this.handlers.onError?.("Could not reconnect. Create or join a new room.");
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket(true).catch(() => {
        this.reconnectAttempt += 1;
        const next = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, 4000);
        this.scheduleReconnect(next);
      });
    }, delayMs);
  }

  private stopReconnectLoop(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private ensureVisibilityHook(): void {
    if (this.visibilityBound || typeof document === "undefined") return;
    this.visibilityBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.tryResume();
      }
    });
    window.addEventListener("online", () => {
      this.tryResume();
    });
    window.addEventListener("pageshow", () => {
      this.tryResume();
    });
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (message.type !== "pose" && message.type !== "leave") {
        this.handlers.onError?.("Not connected to lobby server.");
      }
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      this.handlers.onError?.("Bad message from server.");
      return;
    }

    switch (message.type) {
      case "room":
        this.sessionId = message.sessionId;
        this.stopReconnectLoop();
        this.handlers.onRoom?.(message);
        break;
      case "matchStart":
        this.handlers.onMatchStart?.(message.hideEndsAt);
        break;
      case "phase":
        this.handlers.onPhase?.(message.phase, message.endsAt);
        break;
      case "pose":
        this.handlers.onPose?.(message);
        break;
      case "spotted":
        this.handlers.onSpotted?.(message.active);
        break;
      case "matchEnd":
        this.sessionId = null;
        this.stopReconnectLoop();
        this.handlers.onMatchEnd?.(message.outcome);
        break;
      case "matchResume":
        this.stopReconnectLoop();
        this.handlers.onMatchResume?.(message);
        break;
      case "peerLeft":
        this.handlers.onPeerLeft?.();
        break;
      case "peerReconnecting":
        this.handlers.onPeerReconnecting?.();
        break;
      case "peerResumed":
        this.handlers.onPeerResumed?.();
        break;
      case "error":
        if (/session expired/i.test(message.message)) {
          this.sessionId = null;
          this.stopReconnectLoop();
        }
        this.handlers.onError?.(message.message);
        break;
    }
  }
}
