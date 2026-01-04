import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BotState, PearlRecord } from "./state.js";
import { distSq } from "./math.js";
import { log } from "./logger.js";
import { gotoNear, gotoNearXZ, hardResetMovement } from "./pathing.js";
import { setTriggerInProgress } from "./busy.js";

// ---- optional webhook stub (wire later) ----
async function sendWebhook(message: string) {
    log.warn({ message }, "webhook (stub)");
}

// ---- choose closest registered pearl for player (by bot distance) ----
function pickPearlPosFor(
    bot: Bot,
    state: BotState,
    playerName: string
): { id: string; pearl: PearlRecord } | null {
    const botPos = bot.entity?.position;
    if (!botPos) return null;

    const owned = Object.entries(state.pearls).filter(([, p]) => p.owner === playerName);
    if (owned.length === 0) return null;

    let best: { id: string; pearl: PearlRecord; d: number } | null = null;

    for (const [id, pearl] of owned) {
        const d = distSq(
            { x: botPos.x, y: botPos.y, z: botPos.z },
            pearl.pos
        );
        if (!best || d < best.d) best = { id, pearl, d };
    }

    return best ? { id: best.id, pearl: best.pearl } : null;
}

// ---- action block scan (same idea as before, kept minimal here) ----
// this is chuddy, my trigger pos should just be the pearl-pos, but whatever
const ACTION_BLOCK_NAMES = new Set<string>([
    "lever",
    "oak_trapdoor",
    "iron_trapdoor",
    "stone_button",
    "polished_blackstone_button",
    "oak_button",
    "oak_pressure_plate",
    "stone_pressure_plate"
]);

function isActionBlockName(name: string | undefined): boolean {
    if (!name) return false;
    if (ACTION_BLOCK_NAMES.has(name)) return true;
    if (name.endsWith("_button")) return true;
    if (name.endsWith("_pressure_plate")) return true;
    if (name.endsWith("_trapdoor")) return true;
    if (name.endsWith("_door")) return true;
    if (name.endsWith("_fence_gate")) return true;
    return false;
}

function findNearestActionBlock(
    bot: Bot,
    pearlPos: { x: number; y: number; z: number },
    radius: number
) {
    const base = new Vec3(
        Math.floor(pearlPos.x),
        Math.floor(pearlPos.y),
        Math.floor(pearlPos.z)
    );

    let best: { block: any; d2: number } | null = null;

    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const p = base.offset(dx, dy, dz);
                const b = bot.blockAt(p);
                if (!b) continue;
                if (!isActionBlockName(b.name)) continue;

                const d2 = dx * dx + dy * dy + dz * dz;
                if (!best || d2 < best.d2) best = { block: b, d2 };
            }
        }
    }

    return best?.block ?? null;
}

// ---- trigger using nearest action block ----
export async function triggerPearl(
  bot: Bot,
  state: BotState,
  playerName: string,
  actionRadius = 3
) {
  setTriggerInProgress(true);
  try {
    const picked = pickPearlPosFor(bot, state, playerName);

    if (!picked) {
      throw new Error(`No pearl location registered for "${playerName}"`);
    }

    const { id: pearlId, pearl } = picked;
    const pearlPos = pearl.pos;

    if (!bot.pathfinder) {
      throw new Error("Pathfinding not initialized. Call initPathfinding(bot) after createBot().");
    }

    const actionBlock = findNearestActionBlock(bot, pearlPos, actionRadius);
    if (!actionBlock) {
      throw new Error(`No action block found within radius=${actionRadius} of pearl ${pearlId}`);
    }

    const target = actionBlock.position; // integer Vec3

    // best-effort pathfinding: try to get closer, but NEVER block triggering.
    try {
      log.info(
        { playerName, pearlId, target: { x: target.x, y: target.y, z: target.z }, block: actionBlock.name },
        "Pathfinding near action block (3D)"
      );
      await gotoNear(bot, target.x, target.y, target.z, 2);
    } catch (err3d: any) {
      // critical: reset after failure or bot will get slow/stuck movement.
      hardResetMovement(bot);

      log.warn({ err: err3d, playerName, pearlId }, "3D path failed; trying XZ-only");

      try {
        log.info(
          { playerName, pearlId, x: target.x, z: target.z, block: actionBlock.name },
          "Pathfinding near action block (XZ)"
        );
        await gotoNearXZ(bot, target.x, target.z, 2);
      } catch (errxz: any) {
        hardResetMovement(bot);
        await bot.waitForTicks(2);

        log.warn({ err: errxz, playerName, pearlId }, "XZ path failed; attempting trigger anyway");
      }
    }

    // always reset before look/activate to prevent drift / slow state.
    hardResetMovement(bot);

    const lookPos = target.offset(0.5, 0.1, 0.5);
    await bot.lookAt(lookPos, true);
    await bot.waitForTicks(2);

    log.info(
      {
        playerName,
        pearlId,
        lookPos: { x: lookPos.x, y: lookPos.y, z: lookPos.z },
        actionBlock: actionBlock.name,
        pos: { x: target.x, y: target.y, z: target.z },
      },
      "Activating action block"
    );

    await bot.activateBlock(actionBlock);
    await bot.waitForTicks(2);

    log.info({ playerName, pearlId }, "Pearl trigger attempt done.");
    return {
      pearlId,
      actionBlock: actionBlock.name,
      actionPos: { x: target.x, y: target.y, z: target.z },
    };
  } catch (err: any) {
    // reset on errors too so bot doesn't stay slow.
    hardResetMovement(bot);

    log.error({ err, playerName }, "Error while triggering pearl");
    await sendWebhook(
      `❌ **Bot failed triggering pearl (player=${playerName}):** \`${err?.message || err}\``
    );
    throw err;
  } finally {
    setTriggerInProgress(false);
  }
}

