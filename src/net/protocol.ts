import type { Role } from "../types";

export type ClientMessage =
  | { type: "create"; role: Role }
  | { type: "join"; code: string }
  | { type: "reconnect"; sessionId: string }
  | { type: "start" }
  | { type: "leave" }
  | { type: "pose"; x: number; y: number; z: number; yaw: number; crouch?: boolean };

export type PosePayload = {
  type: "pose";
  role: Role;
  x: number;
  y: number;
  z: number;
  yaw: number;
  crouch?: boolean;
};

export type RoomState = {
  type: "room";
  code: string;
  role: Role;
  isHost: boolean;
  guestConnected: boolean;
  sessionId: string;
};

export type MatchOutcome = "caught" | "escaped";

export type MatchResume = {
  type: "matchResume";
  phase: "hiding" | "seeking";
  endsAt: number;
  spotted: boolean;
};

export type ServerMessage =
  | RoomState
  | { type: "error"; message: string }
  | { type: "matchStart"; hideEndsAt: number }
  | { type: "phase"; phase: "hiding" | "seeking"; endsAt: number }
  | PosePayload
  | { type: "spotted"; active: boolean }
  | { type: "matchEnd"; outcome: MatchOutcome }
  | { type: "peerLeft" }
  | { type: "peerReconnecting" }
  | { type: "peerResumed" }
  | MatchResume;

export function defaultWsUrl(): string {
  const host = typeof location !== "undefined" ? location.hostname : "localhost";
  const port = typeof location !== "undefined" ? location.port : "";
  const isViteDev = port === "5173" || port === "4173";
  if (isViteDev) {
    return `ws://${host}:5080/ws`;
  }
  const proto =
    typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws";
  const ws = new URL("ws", typeof location !== "undefined" ? location.href : `http://${host}/`);
  ws.protocol = proto === "wss" ? "wss:" : "ws:";
  return ws.toString();
}
