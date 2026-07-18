import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { Scene } from "@babylonjs/core/scene";

export interface Arena {
  floor: Mesh;
  walls: Mesh[];
  cover: Mesh[];
  spawn: Vector3;
  seekerSpawn: Vector3;
}

function mat(scene: Scene, name: string, color: Color3, specular = new Color3(0.1, 0.1, 0.1)): StandardMaterial {
  const material = new StandardMaterial(name, scene);
  material.diffuseColor = color;
  material.specularColor = specular;
  return material;
}

export function buildArena(scene: Scene): Arena {
  const floor = MeshBuilder.CreateGround("floor", { width: 40, height: 40 }, scene);
  floor.material = mat(scene, "floorMat", new Color3(0.18, 0.22, 0.28));
  // Y is locked on characters; floor collisions cause agents to jam against props.
  floor.checkCollisions = false;

  const wallMat = mat(scene, "wallMat", new Color3(0.32, 0.38, 0.48));
  const coverMat = mat(scene, "coverMat", new Color3(0.45, 0.33, 0.24));
  const accentMat = mat(scene, "accentMat", new Color3(0.2, 0.55, 0.62));

  const wallSpecs = [
    { name: "wallN", w: 40, d: 1, x: 0, z: 19.5 },
    { name: "wallS", w: 40, d: 1, x: 0, z: -19.5 },
    { name: "wallE", w: 1, d: 40, x: 19.5, z: 0 },
    { name: "wallW", w: 1, d: 40, x: -19.5, z: 0 },
  ];

  const walls: Mesh[] = wallSpecs.map((spec) => {
    const wall = MeshBuilder.CreateBox(spec.name, { width: spec.w, height: 4, depth: spec.d }, scene);
    wall.position = new Vector3(spec.x, 2, spec.z);
    wall.material = wallMat;
    wall.checkCollisions = true;
    return wall;
  });

  const coverLayouts = [
    { x: -8, z: -6, w: 3, h: 2.2, d: 1.2 },
    { x: -4, z: 4, w: 1.4, h: 2.8, d: 4 },
    { x: 2, z: -8, w: 5, h: 1.8, d: 1.4 },
    { x: 7, z: 2, w: 1.6, h: 2.4, d: 3.5 },
    { x: -12, z: 8, w: 4, h: 2, d: 1.5 },
    { x: 10, z: -10, w: 2, h: 2.6, d: 2 },
    { x: 0, z: 10, w: 6, h: 1.6, d: 1.2 },
    { x: 12, z: 10, w: 1.5, h: 3, d: 5 },
    { x: -2, z: -2, w: 2.2, h: 2, d: 2.2 },
  ];

  const cover: Mesh[] = coverLayouts.map((layout, index) => {
    const box = MeshBuilder.CreateBox(
      `cover${index}`,
      { width: layout.w, height: layout.h, depth: layout.d },
      scene,
    );
    box.position = new Vector3(layout.x, layout.h / 2, layout.z);
    box.material = index % 3 === 0 ? accentMat : coverMat;
    box.checkCollisions = true;
    return box;
  });

  return {
    floor,
    walls,
    cover,
    spawn: new Vector3(0, 1.7, -14),
    seekerSpawn: new Vector3(0, 1, 14),
  };
}
