const LOOK_SENS = 0.0035;
const STICK_RADIUS = 56;

export type TouchSample = {
  /** Strafe axis, −1…1 (right positive). */
  moveX: number;
  /** Forward axis, −1…1 (forward positive). */
  moveZ: number;
  lookYaw: number;
  lookPitch: number;
  sprint: boolean;
  crouch: boolean;
};

/** True when the device is likely phone/tablet (coarse pointer or touch). */
export function prefersTouchControls(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const noHover = window.matchMedia("(hover: none)").matches;
  const touchPoints = navigator.maxTouchPoints > 0;
  return coarse || (noHover && touchPoints);
}

/**
 * On-screen move stick (left), look drag (right), sprint + crouch hold.
 * Keyboard/mouse still work when this is hidden.
 */
export class TouchControls {
  private readonly root: HTMLElement;
  private readonly stickPad: HTMLElement;
  private readonly stickKnob: HTMLElement;
  private readonly lookPad: HTMLElement;
  private readonly sprintBtn: HTMLElement;
  private readonly crouchBtn: HTMLElement;

  private movePointerId: number | null = null;
  private lookPointerId: number | null = null;
  private sprintPointerId: number | null = null;
  private crouchPointerId: number | null = null;
  private stickOriginX = 0;
  private stickOriginY = 0;
  private moveX = 0;
  private moveZ = 0;
  private lookDX = 0;
  private lookDY = 0;
  private lastLookX = 0;
  private lastLookY = 0;
  private sprint = false;
  private crouch = false;
  private visible = false;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "touchControls";
    this.root.className = "hidden";
    this.root.innerHTML = `
      <div id="touchStick" class="touch-stick" aria-hidden="true">
        <div class="touch-stick-ring"></div>
        <div class="touch-stick-knob"></div>
      </div>
      <div id="touchLook" class="touch-look" aria-hidden="true"></div>
      <button type="button" id="touchSprint" class="touch-sprint">Sprint</button>
      <button type="button" id="touchCrouch" class="touch-crouch">Crouch</button>
    `;
    document.body.appendChild(this.root);

    this.stickPad = this.root.querySelector("#touchStick") as HTMLElement;
    this.stickKnob = this.root.querySelector(".touch-stick-knob") as HTMLElement;
    this.lookPad = this.root.querySelector("#touchLook") as HTMLElement;
    this.sprintBtn = this.root.querySelector("#touchSprint") as HTMLElement;
    this.crouchBtn = this.root.querySelector("#touchCrouch") as HTMLElement;

    this.bindStick();
    this.bindLook();
    this.bindSprint();
    this.bindCrouch();
  }

  get available(): boolean {
    return prefersTouchControls();
  }

  show(): void {
    if (!this.available) return;
    this.visible = true;
    this.root.classList.remove("hidden");
  }

  hide(): void {
    this.visible = false;
    this.root.classList.add("hidden");
    this.resetAll();
  }

  /** Read axes and consume look deltas for this frame. */
  sample(): TouchSample | null {
    if (!this.visible) return null;
    const lookYaw = this.lookDX * LOOK_SENS;
    const lookPitch = this.lookDY * LOOK_SENS;
    this.lookDX = 0;
    this.lookDY = 0;
    return {
      moveX: this.moveX,
      moveZ: this.moveZ,
      lookYaw,
      lookPitch,
      sprint: this.sprint,
      crouch: this.crouch,
    };
  }

  private bindStick(): void {
    const onDown = (event: PointerEvent) => {
      if (this.movePointerId !== null) return;
      event.preventDefault();
      this.stickPad.setPointerCapture(event.pointerId);
      this.movePointerId = event.pointerId;
      const rect = this.stickPad.getBoundingClientRect();
      this.stickOriginX = rect.left + rect.width / 2;
      this.stickOriginY = rect.top + rect.height / 2;
      this.applyStick(event.clientX, event.clientY);
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== this.movePointerId) return;
      event.preventDefault();
      this.applyStick(event.clientX, event.clientY);
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== this.movePointerId) return;
      this.releaseCapture(this.stickPad, event.pointerId);
      this.movePointerId = null;
      this.moveX = 0;
      this.moveZ = 0;
      this.stickKnob.style.transform = "translate(-50%, -50%)";
    };

    this.stickPad.addEventListener("pointerdown", onDown);
    this.stickPad.addEventListener("pointermove", onMove);
    this.stickPad.addEventListener("pointerup", onUp);
    this.stickPad.addEventListener("pointercancel", onUp);
  }

  private applyStick(clientX: number, clientY: number): void {
    let dx = clientX - this.stickOriginX;
    let dy = clientY - this.stickOriginY;
    const len = Math.hypot(dx, dy);
    if (len > STICK_RADIUS) {
      dx = (dx / len) * STICK_RADIUS;
      dy = (dy / len) * STICK_RADIUS;
    }
    this.stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    this.moveX = dx / STICK_RADIUS;
    this.moveZ = -dy / STICK_RADIUS;
  }

  private bindLook(): void {
    const onDown = (event: PointerEvent) => {
      if (this.lookPointerId !== null) return;
      event.preventDefault();
      this.lookPad.setPointerCapture(event.pointerId);
      this.lookPointerId = event.pointerId;
      this.lastLookX = event.clientX;
      this.lastLookY = event.clientY;
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== this.lookPointerId) return;
      event.preventDefault();
      this.lookDX += event.clientX - this.lastLookX;
      this.lookDY += event.clientY - this.lastLookY;
      this.lastLookX = event.clientX;
      this.lastLookY = event.clientY;
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== this.lookPointerId) return;
      this.releaseCapture(this.lookPad, event.pointerId);
      this.lookPointerId = null;
    };

    this.lookPad.addEventListener("pointerdown", onDown);
    this.lookPad.addEventListener("pointermove", onMove);
    this.lookPad.addEventListener("pointerup", onUp);
    this.lookPad.addEventListener("pointercancel", onUp);
  }

  private bindSprint(): void {
    const down = (event: PointerEvent) => {
      if (this.sprintPointerId !== null) return;
      event.preventDefault();
      this.sprintPointerId = event.pointerId;
      this.sprint = true;
      this.sprintBtn.classList.add("active");
      this.sprintBtn.setPointerCapture(event.pointerId);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== this.sprintPointerId) return;
      this.releaseCapture(this.sprintBtn, event.pointerId);
      this.sprintPointerId = null;
      this.sprint = false;
      this.sprintBtn.classList.remove("active");
    };
    // Hold until the owning finger lifts — do not clear on pointerleave while captured.
    this.sprintBtn.addEventListener("pointerdown", down);
    this.sprintBtn.addEventListener("pointerup", up);
    this.sprintBtn.addEventListener("pointercancel", up);
  }

  private bindCrouch(): void {
    const down = (event: PointerEvent) => {
      if (this.crouchPointerId !== null) return;
      event.preventDefault();
      this.crouchPointerId = event.pointerId;
      this.crouch = true;
      this.crouchBtn.classList.add("active");
      this.crouchBtn.setPointerCapture(event.pointerId);
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== this.crouchPointerId) return;
      this.releaseCapture(this.crouchBtn, event.pointerId);
      this.crouchPointerId = null;
      this.crouch = false;
      this.crouchBtn.classList.remove("active");
    };
    this.crouchBtn.addEventListener("pointerdown", down);
    this.crouchBtn.addEventListener("pointerup", up);
    this.crouchBtn.addEventListener("pointercancel", up);
  }

  private releaseCapture(el: HTMLElement, pointerId: number): void {
    if (el.hasPointerCapture(pointerId)) {
      el.releasePointerCapture(pointerId);
    }
  }

  private resetAll(): void {
    if (this.movePointerId !== null) {
      this.releaseCapture(this.stickPad, this.movePointerId);
    }
    if (this.lookPointerId !== null) {
      this.releaseCapture(this.lookPad, this.lookPointerId);
    }
    if (this.sprintPointerId !== null) {
      this.releaseCapture(this.sprintBtn, this.sprintPointerId);
    }
    if (this.crouchPointerId !== null) {
      this.releaseCapture(this.crouchBtn, this.crouchPointerId);
    }
    this.movePointerId = null;
    this.lookPointerId = null;
    this.sprintPointerId = null;
    this.crouchPointerId = null;
    this.moveX = 0;
    this.moveZ = 0;
    this.lookDX = 0;
    this.lookDY = 0;
    this.sprint = false;
    this.crouch = false;
    this.stickKnob.style.transform = "translate(-50%, -50%)";
    this.sprintBtn.classList.remove("active");
    this.crouchBtn.classList.remove("active");
  }
}
