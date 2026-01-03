import type { Bot } from "mineflayer";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// mineflayer-pathfinder is CommonJS; require() is the cleanest way under ESM
const pathfinderPkg = require("mineflayer-pathfinder") as any;
const { pathfinder, Movements, goals } = pathfinderPkg;

export function initPathfinding(bot: Bot) {
  bot.loadPlugin(pathfinder);

  bot.once("spawn", () => {
    // minecraft-data is also commonly used via require in mineflayer ecosystem
    const mcData = require("minecraft-data")(bot.version);
    const movements = new Movements(bot, mcData);

    // sane defaults for 2b2t
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.scafoldingBlocks = [];

    bot.pathfinder.setMovements(movements);
  });
}

export async function gotoNear(
  bot: Bot,
  x: number,
  y: number,
  z: number,
  range = 8
) {
  if (!goals?.GoalNear) {
    throw new Error("mineflayer-pathfinder goals.GoalNear not available (bad import)");
  }
  const goal = new goals.GoalNear(x, y, z, range);
  return bot.pathfinder.goto(goal);
}

export async function gotoNearXZ(
  bot: Bot,
  x: number,
  z: number,
  range = 3
) {
  if (!goals?.GoalNearXZ) {
    throw new Error("mineflayer-pathfinder goals.GoalNearXZ not available");
  }
  const goal = new goals.GoalNearXZ(x, z, range);
  return bot.pathfinder.goto(goal);
}