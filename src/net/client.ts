import {
  defaultWsUrl,
  type ClientMessage,
  type MatchOutcome,
  type PosePayload,
  type RoomState,
  type ServerMessage,
} from "./protocol";
import type { Role } from "../types";

export type NetHandlers = {
  onRoom?: (room: RoomState) => void;
  onMatchStart?: (hideEndsAt: number) => void;
  onPhase?: (phase: "hiding" | "seeking", endsAt: number) => void;
  onPose?: (pose: PosePayload) => void;
  onSpotted?: (active: boolean) => void;
  onMatchEnd?: (outcome: MatchOutcome) => void;
  onPeerLeft?: () => void;
  onError?: (message: string) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export class NetClient {
  private socket: WebSocket | null = null;
  private handlers: NetHandlers = {};

  setHandlers(handlers: NetHandlers): void {
    this.handlers = handlers;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  connect(url = defaultWsUrl()): Promise<void> {
    this.disconnect();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.handlers.onOpen?.();
        resolve();
      });

      socket.addEventListener("error", () => {
        reject(new Error("Could not reach the lobby server. Is it running on port 5080?"));
      });

      socket.addEventListener("close", () => {
        if (this.socket === socket) this.socket = null;
        this.handlers.onClose?.();
      });

      socket.addEventListener("message", (event) => {
        this.handleMessage(String(event.data));
      });
    });
  }

  disconnect(): void {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      try {
        this.send({ type: "leave" });
      } catch {
        // Ignore leave failures while closing.
      }
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

  sendPose(x: number, y: number, z: number, yaw: number): void {
    this.send({ type: "pose", x, y, z, yaw });
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
        this.handlers.onMatchEnd?.(message.outcome);
        break;
      case "peerLeft":
        this.handlers.onPeerLeft?.();
        break;
      case "error":
        this.handlers.onError?.(message.message);
        break;
    }
  }
}
