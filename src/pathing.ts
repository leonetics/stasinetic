import type { Bot } from "mineflayer";
import pathfinderPkg from "mineflayer-pathfinder";
import { log } from "./logger.js";

const { pathfinder, Movements, goals } = pathfinderPkg as any;
const { GoalNear } = goals;

// Hard reset to avoid "slow walking" / stuck states after NoPath or aborted goals.
export function hardResetMovement(bot: Bot) {
  try {
    bot.pathfinder?.setGoal(null);
  } catch {}

  try {
    bot.clearControlStates();
  } catch {}

  // Be explicit: some versions/plugins leave these latched.
  try {
    bot.setControlState("forward", false);
    bot.setControlState("back", false);
    bot.setControlState("left", false);
    bot.setControlState("right", false);
    bot.setControlState("jump", false);
    bot.setControlState("sprint", false);
    bot.setControlState("sneak", false);
  } catch {}
}

export async function initPathfinding(bot: Bot) {
  bot.loadPlugin(pathfinder);

  // ESM-safe minecraft-data load
  const mcDataMod: any = await import("minecraft-data");
  const mcData = mcDataMod.default ? mcDataMod.default(bot.version) : mcDataMod(bot.version);

  const movements = new Movements(bot, mcData);
  bot.pathfinder.setMovements(movements);

  log.info({ version: bot.version }, "Pathfinding initialized");
}

/**
 * go near a 3D coordinate.
 * always clears movement state in finally to prevent stuck/slow movement after failures.
 */
export async function gotoNear(
  bot: Bot,
  x: number,
  y: number,
  z: number,
  range = 2,
  timeoutMs = 8000
) {
  if (!bot.pathfinder) throw new Error("pathfinder not initialized");

  const goal = new GoalNear(x, y, z, range);

  // clear stale states before starting
  hardResetMovement(bot);

  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const p = bot.pathfinder.goto(goal);

    const raced = await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("gotoNear timeout")), timeoutMs);
      })
    ]);

    return raced;
  } catch (err) {
    log.debug({ err }, "gotoNear failed");
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    hardResetMovement(bot);
  }
}

/**
 * go near an XZ coordinate.
 * we use current Y as a baseline (still ok for fallback)
 */
export async function gotoNearXZ(
  bot: Bot,
  x: number,
  z: number,
  range = 2,
  timeoutMs = 8000
) {
  if (!bot.pathfinder) throw new Error("pathfinder not initialized");

  const y = Math.floor(bot.entity?.position?.y ?? 0);
  const goal = new GoalNear(x, y, z, range);

  hardResetMovement(bot);

  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    const p = bot.pathfinder.goto(goal);

    const raced = await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("gotoNearXZ timeout")), timeoutMs);
      })
    ]);

    return raced;
  } catch (err) {
    log.debug({ err }, "gotoNearXZ failed");
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    hardResetMovement(bot);
  }
}
