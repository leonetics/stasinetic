import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BotState, PearlRecord } from "./state.js";
import { distSq } from "./math.js";
import { log } from "./logger.js";
import { gotoNear, gotoNearXZ } from "./pathing.js";

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

// ---- legacy behavior + best-effort pathfinding ----
export async function triggerPearl(bot: Bot, state: BotState, playerName: string) {
    const picked = pickPearlPosFor(bot, state, playerName);

    if (!picked) {
        bot.chat(`No pearl location registered for ${playerName}.`);
        throw new Error(`No pearl location registered for "${playerName}"`);
    }

    const { id: pearlId, pearl } = picked;
    const pearlBlock = pearl.pos;

    if (!bot.pathfinder) {
        throw new Error("Pathfinding not initialized. Call initPathfinding(bot) after createBot().");
    }

    // Best-effort pathfinding: try to get closer, but NEVER block triggering.
    try {
        log.info(
            { playerName, pearlId, x: pearlBlock.x, y: pearlBlock.y, z: pearlBlock.z },
            "Pathfinding near pearl (3D)"
        );
        await gotoNear(bot, pearlBlock.x, pearlBlock.y, pearlBlock.z, 2);
    } catch (err3d: any) {
        log.warn({ err: err3d, playerName, pearlId }, "3D path failed; trying XZ-only");

        try {
            log.info(
                { playerName, pearlId, x: pearlBlock.x, z: pearlBlock.z },
                "Pathfinding near pearl (XZ)"
            );
            await gotoNearXZ(bot, pearlBlock.x, pearlBlock.z, 2);
        } catch (errxz: any) {
            log.warn({ err: errxz, playerName, pearlId }, "XZ path failed; attempting trigger anyway");
            // swallow and continue
        }
    }

    // Legacy centered Vec3 position (used for BOTH lookAt and blockAt)
    const pos = new Vec3(
        pearlBlock.x + 0.5,
        pearlBlock.y + 1,
        pearlBlock.z + 0.5
    );

    try {
        log.info(
            { playerName, pearlId, x: pearlBlock.x, y: pearlBlock.y, z: pearlBlock.z },
            "Attempting to trigger pearl"
        );

        // look at block (legacy behavior)
        const lookPos = new Vec3(pearlBlock.x + 0.5, pearlBlock.y + 0.5, pearlBlock.z + 0.5);
        const blockPos = new Vec3(pearlBlock.x, pearlBlock.y, pearlBlock.z);

        await bot.lookAt(lookPos, true);
        await bot.waitForTicks(2);

        const block = bot.blockAt(blockPos);
        if (!block) throw new Error("No block found at registered pearl position");

        await bot.activateBlock(block);
        await bot.waitForTicks(2);

        log.info({ playerName, pearlId }, "Pearl trigger attempt done.");

        // remove pearl from JSON state (you requested this behavior)
        delete state.pearls[pearlId];

        return { pearlId };
    } catch (err: any) {
        log.error({ err, playerName, pearlId }, "Error while triggering pearl");
        await sendWebhook(
            `❌ **Bot failed triggering pearl (player=${playerName}):** \`${err?.message || err}\``
        );
        throw err;
    }
}
