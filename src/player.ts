import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import type { TouchSample } from "./touch";
import { SCHEMES, anyPressed, type ControlScheme } from "./types";

const MOVE_SPEED = 0.18;
const SPRINT_MULT = 1.7;
const CROUCH_MULT = 0.55;
const STAND_HALF = 0.85;
const STAND_EYE = 1.6;
const CROUCH_HALF = 0.5;
const CROUCH_EYE = 0.95;
const STAND_HEIGHT = 1.7;
const CROUCH_HEIGHT = 1.0;
const MAX_PITCH = Math.PI / 2 - 0.08;
const TURN_SPEED = 0.045;

export class Player {
  readonly camera: FreeCamera;
  readonly body: Mesh;
  private readonly keys = new Set<string>();
  private readonly canvas: HTMLCanvasElement;
  private yaw = 0;
  private pitch = 0;
  private looking = false;
  private scheme: ControlScheme = "primary";
  private cameraEnabled = true;
  private inputEnabled = true;
  private crouching = false;

  constructor(scene: Scene, canvas: HTMLCanvasElement, spawn: Vector3) {
    this.canvas = canvas;

    this.body = MeshBuilder.CreateCapsule(
      "playerBody",
      { height: STAND_HEIGHT, radius: 0.35, tessellation: 8 },
      scene,
    );
    this.body.isPickable = false;
    this.body.checkCollisions = true;
    this.body.ellipsoid = new Vector3(0.35, STAND_HALF, 0.35);

    const material = new StandardMaterial("hiderMat", scene);
    material.diffuseColor = new Color3(0.35, 0.65, 0.95);
    material.emissiveColor = new Color3(0.05, 0.1, 0.18);
    this.body.material = material;
    this.body.isVisible = false;

    this.camera = new FreeCamera("player", spawn.clone(), scene);
    this.camera.minZ = 0.1;
    this.camera.inertia = 0;
    this.camera.inputs.clear();

    scene.collisionsEnabled = true;

    window.addEventListener("keydown", (event) => {
      this.keys.add(event.code);
    });
    window.addEventListener("keyup", (event) => {
      this.keys.delete(event.code);
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
    });

    document.addEventListener("pointerlockchange", () => {
      this.looking = document.pointerLockElement === this.canvas;
    });

    this.canvas.addEventListener("mousemove", (event) => {
      if (!this.looking || !this.cameraEnabled) return;
      this.yaw += event.movementX * 0.0022;
      this.pitch -= event.movementY * 0.0022;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    });

    this.reset(spawn);
  }

  configure(scheme: ControlScheme, ownsCamera: boolean): void {
    this.scheme = scheme;
    this.cameraEnabled = ownsCamera;
    this.body.isVisible = !ownsCamera;
    this.camera.setEnabled(ownsCamera);
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
    if (!enabled) {
      this.keys.clear();
      this.applyStance(false);
      this.body.position.y = STAND_HALF;
    }
  }

  reset(spawn: Vector3): void {
    this.keys.clear();
    this.yaw = 0;
    this.pitch = 0;
    this.applyStance(false);
    this.body.position.set(spawn.x, STAND_HALF, spawn.z);
    this.syncCamera();
  }

  update(touch: TouchSample | null = null): void {
    // Look works whenever we own the camera (including wait / hide).
    if (this.cameraEnabled && touch) {
      this.yaw += touch.lookYaw;
      this.pitch -= touch.lookPitch;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    }

    if (!this.inputEnabled) {
      if (this.cameraEnabled) this.syncCamera();
      return;
    }

    const map = SCHEMES[this.scheme];
    if (anyPressed(this.keys, map.turnLeft)) this.yaw -= TURN_SPEED;
    if (anyPressed(this.keys, map.turnRight)) this.yaw += TURN_SPEED;

    const crouching = anyPressed(this.keys, map.crouch) || Boolean(touch?.crouch);
    this.applyStance(crouching);

    const forward = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    // Crouch wins over sprint.
    const sprint =
      !crouching && (anyPressed(this.keys, map.sprint) || Boolean(touch?.sprint));
    const speed = MOVE_SPEED * (crouching ? CROUCH_MULT : sprint ? SPRINT_MULT : 1);
    const move = Vector3.Zero();

    if (anyPressed(this.keys, map.forward)) move.addInPlace(forward);
    if (anyPressed(this.keys, map.back)) move.addInPlace(forward.scale(-1));
    if (anyPressed(this.keys, map.right)) move.addInPlace(right);
    if (anyPressed(this.keys, map.left)) move.addInPlace(right.scale(-1));

    if (touch) {
      move.addInPlace(forward.scale(touch.moveZ));
      move.addInPlace(right.scale(touch.moveX));
    }

    if (move.lengthSquared() > 0.0001) {
      move.normalize().scaleInPlace(speed);
      this.body.moveWithCollisions(move);
    }

    this.body.position.y = this.crouching ? CROUCH_HALF : STAND_HALF;

    if (this.cameraEnabled) this.syncCamera();
  }

  get position(): Vector3 {
    const half = this.crouching ? CROUCH_HALF : STAND_HALF;
    const eye = this.crouching ? CROUCH_EYE : STAND_EYE;
    return this.body.position.add(new Vector3(0, eye - half, 0));
  }

  getPose(): { x: number; y: number; z: number; yaw: number; crouch: boolean } {
    return {
      x: this.body.position.x,
      y: this.body.position.y,
      z: this.body.position.z,
      yaw: this.yaw,
      crouch: this.crouching,
    };
  }

  /** Snap / lerp target for a remotely controlled hider body. */
  setRemotePose(
    x: number,
    y: number,
    z: number,
    yaw: number,
    crouch = false,
    smooth = true,
  ): void {
    this.applyStance(crouch);
    if (smooth) {
      this.body.position.x += (x - this.body.position.x) * 0.35;
      this.body.position.y = y;
      this.body.position.z += (z - this.body.position.z) * 0.35;
      this.yaw += shortestAngle(yaw - this.yaw) * 0.35;
    } else {
      this.body.position.set(x, y, z);
      this.yaw = yaw;
    }
    this.body.rotation.y = this.yaw;
  }

  private applyStance(crouching: boolean): void {
    if (this.crouching === crouching) return;
    this.crouching = crouching;
    const half = crouching ? CROUCH_HALF : STAND_HALF;
    const scaleY = crouching ? CROUCH_HEIGHT / STAND_HEIGHT : 1;
    this.body.scaling.y = scaleY;
    this.body.ellipsoid = new Vector3(0.35, half, 0.35);
  }

  private syncCamera(): void {
    const eye = this.crouching ? CROUCH_EYE : STAND_EYE;
    this.camera.position.set(this.body.position.x, eye, this.body.position.z);
    const look = new Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.setTarget(this.camera.position.add(look));
  }
}

function shortestAngle(delta: number): number {
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
