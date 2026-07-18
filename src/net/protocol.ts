import type { Role } from "../types";

export type ClientMessage =
  | { type: "create"; role: Role }
  | { type: "join"; code: string }
  | { type: "start" }
  | { type: "leave" };

export type RoomState = {
  type: "room";
  code: string;
  role: Role;
  isHost: boolean;
  guestConnected: boolean;
};

export type ServerMessage =
  | RoomState
  | { type: "error"; message: string }
  | { type: "matchStart"; hideEndsAt: number }
  | { type: "peerLeft" };

export function defaultWsUrl(): string {
  const host = typeof location !== "undefined" ? location.hostname : "localhost";
  const port = typeof location !== "undefined" ? location.port : "";
  const isViteDev = port === "5173" || port === "4173";
  if (isViteDev) {
    return `ws://${host}:5080/ws`;
  }
  const proto =
    typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws";
  const portPart = port && port !== "80" && port !== "443" ? `:${port}` : "";
  return `${proto}://${host}${portPart}/ws`;
}
