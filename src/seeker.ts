import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Ray } from "@babylonjs/core/Culling/ray";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { SCHEMES, anyPressed, type ControlScheme } from "./types";

const WALK_SPEED = 0.09;
const CHASE_SPEED = 0.14;
const HUMAN_SPEED = 0.18;
const HUMAN_SPRINT = 1.7;
const TURN_LERP = 0.12;
const HUMAN_TURN = 0.045;
const SIGHT_RANGE = 22;
const CATCH_RANGE = 1.6;
const LOOK_AHEAD = 1.8;
const STUCK_FRAMES = 25;
const STUCK_EPSILON = 0.02;
const EYE_HEIGHT = 1.6;
const MAX_PITCH = Math.PI / 2 - 0.08;

const WAYPOINTS = [
  new Vector3(0, 1, 14),
  new Vector3(14, 1, 14),
  new Vector3(14, 1, 0),
  new Vector3(14, 1, -14),
  new Vector3(0, 1, -14),
  new Vector3(-14, 1, -14),
  new Vector3(-14, 1, 0),
  new Vector3(-14, 1, 14),
];

export class Seeker {
  readonly mesh: Mesh;
  readonly camera: FreeCamera;
  private waypointIndex = 0;
  private hunting = false;
  private human = false;
  private scheme: ControlScheme = "secondary";
  private cameraEnabled = false;
  private inputEnabled = false;
  private readonly obstacles: AbstractMesh[];
  private readonly scene: Scene;
  private readonly canvas: HTMLCanvasElement;
  private readonly keys = new Set<string>();
  private lastPos = Vector3.Zero();
  private stuckFrames = 0;
  private preferLeft = true;
  private yaw = 0;
  private pitch = 0;
  private looking = false;

  constructor(scene: Scene, canvas: HTMLCanvasElement, spawn: Vector3, obstacles: AbstractMesh[]) {
    this.scene = scene;
    this.canvas = canvas;
    this.obstacles = obstacles;
    this.mesh = MeshBuilder.CreateCapsule(
      "seeker",
      { height: 1.8, radius: 0.35, tessellation: 12 },
      scene,
    );
    this.mesh.position = spawn.clone();
    this.mesh.ellipsoid = new Vector3(0.35, 0.9, 0.35);
    this.mesh.checkCollisions = true;
    this.mesh.isPickable = false;

    const material = new StandardMaterial("seekerMat", scene);
    material.diffuseColor = new Color3(0.85, 0.25, 0.28);
    material.emissiveColor = new Color3(0.25, 0.05, 0.05);
    material.specularColor = new Color3(0.2, 0.2, 0.2);
    this.mesh.material = material;

    const eye = MeshBuilder.CreateSphere("seekerEye", { diameter: 0.28 }, scene);
    eye.parent = this.mesh;
    eye.position = new Vector3(0, 0.4, 0.32);
    eye.isPickable = false;
    const eyeMat = new StandardMaterial("seekerEyeMat", scene);
    eyeMat.diffuseColor = new Color3(1, 0.9, 0.4);
    eyeMat.emissiveColor = new Color3(0.6, 0.4, 0.05);
    eye.material = eyeMat;

    this.camera = new FreeCamera("seekerCam", spawn.clone(), scene);
    this.camera.minZ = 0.1;
    this.camera.inertia = 0;
    this.camera.inputs.clear();
    this.camera.setEnabled(false);

    window.addEventListener("keydown", (event) => this.keys.add(event.code));
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
    window.addEventListener("blur", () => this.keys.clear());
    document.addEventListener("pointerlockchange", () => {
      this.looking = document.pointerLockElement === this.canvas;
    });
    this.canvas.addEventListener("mousemove", (event) => {
      if (!this.looking || !this.cameraEnabled) return;
      this.yaw += event.movementX * 0.0022;
      this.pitch -= event.movementY * 0.0022;
      this.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, this.pitch));
    });
  }

  configure(human: boolean, scheme: ControlScheme, ownsCamera: boolean): void {
    this.human = human;
    this.scheme = scheme;
    this.cameraEnabled = ownsCamera;
    this.mesh.isVisible = !ownsCamera;
    this.camera.setEnabled(ownsCamera);
  }

  reset(spawn: Vector3): void {
    this.mesh.position.set(spawn.x, 0.9, spawn.z);
    this.waypointIndex = 0;
    this.hunting = false;
    this.stuckFrames = 0;
    this.keys.clear();
    this.yaw = Math.PI;
    this.pitch = 0;
    this.lastPos.copyFrom(this.mesh.position);
    this.syncCamera();
  }

  setActive(active: boolean): void {
    this.hunting = active;
    this.inputEnabled = this.human && active;
    if (!active) this.keys.clear();
  }

  getPose(): { x: number; y: number; z: number; yaw: number } {
    return {
      x: this.mesh.position.x,
      y: this.mesh.position.y,
      z: this.mesh.position.z,
      yaw: this.yaw,
    };
  }

  /** Snap / lerp target for a remotely controlled seeker body. */
  setRemotePose(x: number, y: number, z: number, yaw: number, smooth = true): void {
    if (smooth) {
      this.mesh.position.x += (x - this.mesh.position.x) * 0.35;
      this.mesh.position.y = y;
      this.mesh.position.z += (z - this.mesh.position.z) * 0.35;
      this.yaw += shortestAngle(yaw - this.yaw) * 0.35;
    } else {
      this.mesh.position.set(x, y, z);
      this.yaw = yaw;
    }
    this.mesh.rotation.y = this.yaw;
  }

  update(hiderPos: Vector3): { spotted: boolean; caught: boolean } {
    if (!this.hunting) {
      if (this.cameraEnabled) this.syncCamera();
      return { spotted: false, caught: false };
    }

    if (this.human) {
      return this.updateHuman(hiderPos);
    }
    return this.updateAi(hiderPos);
  }

  private updateHuman(hiderPos: Vector3): { spotted: boolean; caught: boolean } {
    if (this.inputEnabled) {
      const map = SCHEMES[this.scheme];
      if (anyPressed(this.keys, map.turnLeft)) this.yaw -= HUMAN_TURN;
      if (anyPressed(this.keys, map.turnRight)) this.yaw += HUMAN_TURN;

      const forward = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      const sprint = anyPressed(this.keys, map.sprint);
      const speed = HUMAN_SPEED * (sprint ? HUMAN_SPRINT : 1);
      const move = Vector3.Zero();

      if (anyPressed(this.keys, map.forward)) move.addInPlace(forward);
      if (anyPressed(this.keys, map.back)) move.addInPlace(forward.scale(-1));
      if (anyPressed(this.keys, map.right)) move.addInPlace(right);
      if (anyPressed(this.keys, map.left)) move.addInPlace(right.scale(-1));

      if (move.lengthSquared() > 0.0001) {
        move.normalize().scaleInPlace(speed);
        this.mesh.moveWithCollisions(move);
        this.mesh.position.y = 0.9;
      }

      this.mesh.rotation.y = this.yaw;
    }

    this.syncCamera();

    const spotted = this.canSee(hiderPos);
    const toHider = this.mesh.position.subtract(hiderPos);
    toHider.y = 0;
    const caught = toHider.length() < CATCH_RANGE && spotted;
    return { spotted, caught };
  }

  private updateAi(hiderPos: Vector3): { spotted: boolean; caught: boolean } {
    const spotted = this.canSee(hiderPos);
    const target = spotted ? hiderPos : WAYPOINTS[this.waypointIndex];
    const toTarget = target.subtract(this.mesh.position);
    toTarget.y = 0;
    const distance = toTarget.length();

    if (!spotted && distance < 1.5) {
      this.waypointIndex = (this.waypointIndex + 1) % WAYPOINTS.length;
    }

    if (distance > 0.05) {
      const desired = toTarget.scale(1 / distance);
      const steered = this.steer(desired);
      const speed = spotted ? CHASE_SPEED : WALK_SPEED;
      const before = this.mesh.position.clone();
      this.mesh.moveWithCollisions(steered.scale(speed));
      this.mesh.position.y = 0.9;

      const moved = Vector3.Distance(before, this.mesh.position);
      if (moved < STUCK_EPSILON) {
        this.stuckFrames += 1;
        if (this.stuckFrames >= STUCK_FRAMES) this.unstuck(spotted);
      } else {
        this.stuckFrames = 0;
      }

      const yaw = Math.atan2(steered.x, steered.z);
      let deltaYaw = yaw - this.mesh.rotation.y;
      while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
      while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;
      this.mesh.rotation.y += deltaYaw * TURN_LERP;
      this.yaw = this.mesh.rotation.y;
    }

    this.lastPos.copyFrom(this.mesh.position);

    const toHider = this.mesh.position.subtract(hiderPos);
    toHider.y = 0;
    const caught = toHider.length() < CATCH_RANGE && spotted;
    return { spotted, caught };
  }

  private syncCamera(): void {
    if (!this.cameraEnabled) return;
    this.camera.position.set(this.mesh.position.x, EYE_HEIGHT, this.mesh.position.z);
    const look = new Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.setTarget(this.camera.position.add(look));
  }

  private steer(desired: Vector3): Vector3 {
    if (!this.isBlocked(desired, LOOK_AHEAD)) return desired;

    const left = this.rotateY(desired, Math.PI / 3);
    const right = this.rotateY(desired, -Math.PI / 3);
    const hardLeft = this.rotateY(desired, Math.PI / 2);
    const hardRight = this.rotateY(desired, -Math.PI / 2);
    const options = this.preferLeft
      ? [left, hardLeft, right, hardRight]
      : [right, hardRight, left, hardLeft];

    for (const option of options) {
      if (!this.isBlocked(option, LOOK_AHEAD)) return option;
    }

    this.preferLeft = !this.preferLeft;
    return this.rotateY(desired, Math.PI);
  }

  private unstuck(chasing: boolean): void {
    this.stuckFrames = 0;
    this.preferLeft = !this.preferLeft;
    if (!chasing) this.waypointIndex = (this.waypointIndex + 1) % WAYPOINTS.length;

    const nudge = this.preferLeft ? Math.PI / 2 : -Math.PI / 2;
    const away = this.rotateY(
      new Vector3(Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y)),
      nudge,
    );
    this.mesh.moveWithCollisions(away.scale(0.6));
    this.mesh.position.y = 0.9;
    this.mesh.position.x = Math.max(-17, Math.min(17, this.mesh.position.x));
    this.mesh.position.z = Math.max(-17, Math.min(17, this.mesh.position.z));
  }

  private isBlocked(direction: Vector3, distance: number): boolean {
    const origin = this.mesh.position.add(new Vector3(0, 0.4, 0));
    const ray = new Ray(origin, direction, distance);
    const hit = this.scene.pickWithRay(
      ray,
      (mesh) => this.obstacles.includes(mesh),
      true,
    );
    return Boolean(hit?.hit && (hit.distance ?? 0) < distance);
  }

  private rotateY(dir: Vector3, angle: number): Vector3 {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return new Vector3(dir.x * cos - dir.z * sin, 0, dir.x * sin + dir.z * cos).normalize();
  }

  private canSee(hiderPos: Vector3): boolean {
    const origin = this.mesh.position.add(new Vector3(0, 0.5, 0));
    const toHider = hiderPos.subtract(origin);
    const distance = toHider.length();
    if (distance > SIGHT_RANGE || distance < 0.2) return false;

    const direction = toHider.scale(1 / distance);
    const forward = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    if (Vector3.Dot(forward, direction) < 0.35) return false;

    const ray = new Ray(origin, direction, distance);
    const hit = this.scene.pickWithRay(
      ray,
      (mesh) => this.obstacles.includes(mesh),
      false,
    );

    return !hit?.hit || (hit.distance ?? 0) >= distance - 0.5;
  }
}

function shortestAngle(delta: number): number {
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}
