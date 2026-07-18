import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";
import { SCHEMES, anyPressed, type ControlScheme } from "./types";

const MOVE_SPEED = 0.18;
const SPRINT_MULT = 1.7;
const EYE_HEIGHT = 1.6;
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

  constructor(scene: Scene, canvas: HTMLCanvasElement, spawn: Vector3) {
    this.canvas = canvas;

    this.body = MeshBuilder.CreateCapsule(
      "playerBody",
      { height: 1.7, radius: 0.35, tessellation: 8 },
      scene,
    );
    this.body.isPickable = false;
    this.body.checkCollisions = true;
    this.body.ellipsoid = new Vector3(0.35, 0.85, 0.35);

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
    if (!enabled) this.keys.clear();
  }

  reset(spawn: Vector3): void {
    this.keys.clear();
    this.yaw = 0;
    this.pitch = 0;
    this.body.position.set(spawn.x, 0.85, spawn.z);
    this.syncCamera();
  }

  update(): void {
    if (!this.inputEnabled) {
      if (this.cameraEnabled) this.syncCamera();
      return;
    }

    const map = SCHEMES[this.scheme];
    if (anyPressed(this.keys, map.turnLeft)) this.yaw -= TURN_SPEED;
    if (anyPressed(this.keys, map.turnRight)) this.yaw += TURN_SPEED;

    const forward = new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const sprint = anyPressed(this.keys, map.sprint);
    const speed = MOVE_SPEED * (sprint ? SPRINT_MULT : 1);
    const move = Vector3.Zero();

    if (anyPressed(this.keys, map.forward)) move.addInPlace(forward);
    if (anyPressed(this.keys, map.back)) move.addInPlace(forward.scale(-1));
    if (anyPressed(this.keys, map.right)) move.addInPlace(right);
    if (anyPressed(this.keys, map.left)) move.addInPlace(right.scale(-1));

    if (move.lengthSquared() > 0.0001) {
      move.normalize().scaleInPlace(speed);
      this.body.moveWithCollisions(move);
      this.body.position.y = 0.85;
    }

    if (this.cameraEnabled) this.syncCamera();
  }

  get position(): Vector3 {
    return this.body.position.add(new Vector3(0, EYE_HEIGHT - 0.85, 0));
  }

  private syncCamera(): void {
    this.camera.position.set(this.body.position.x, EYE_HEIGHT, this.body.position.z);
    const look = new Vector3(
      Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.setTarget(this.camera.position.add(look));
  }
}
