import { Engine } from "@babylonjs/core/Engines/engine";
import { Game } from "./game";

const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new Engine(canvas, true, {
  preserveDrawingBuffer: true,
  stencil: true,
});

const game = new Game(engine, canvas);
game.start();

window.addEventListener("resize", () => {
  engine.resize();
});
