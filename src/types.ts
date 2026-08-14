export type GameMode = "solo" | "online";
export type Role = "hider" | "seeker";
export type Phase = "idle" | "hiding" | "seeking" | "won" | "lost";

export type ControlScheme = "primary" | "secondary";

export interface SchemeKeys {
  forward: string[];
  back: string[];
  left: string[];
  right: string[];
  sprint: string[];
  crouch: string[];
  turnLeft?: string[];
  turnRight?: string[];
}

export const SCHEMES: Record<ControlScheme, SchemeKeys> = {
  primary: {
    forward: ["KeyW"],
    back: ["KeyS"],
    left: ["KeyA"],
    right: ["KeyD"],
    sprint: ["ShiftLeft", "ShiftRight"],
    // Ctrl only on primary — secondary uses Ctrl for sprint.
    crouch: ["KeyC", "ControlLeft", "ControlRight"],
  },
  secondary: {
    forward: ["ArrowUp"],
    back: ["ArrowDown"],
    left: ["ArrowLeft"],
    right: ["ArrowRight"],
    sprint: ["ControlRight", "ControlLeft"],
    crouch: ["KeyC"],
    turnLeft: ["Comma"],
    turnRight: ["Period"],
  },
};

export function anyPressed(keys: Set<string>, codes: string[] | undefined): boolean {
  if (!codes) return false;
  return codes.some((code) => keys.has(code));
}
