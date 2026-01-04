import type { Bot } from "mineflayer";
import { log } from "./logger.js";
import { isTriggerInProgress } from "./busy.js";

export type GeneralBotStuffOptions = {
  antiAfk?: boolean;
  antiAfkIntervalMs?: number;

  autoTotem?: boolean;
  autoTotemIntervalMs?: number;

  autoGapEat?: boolean;

  // thresholds
  eatIfHealthLeq?: number;
  eatIfFoodLt?: number;

  // name of food item
  foodItemName?: string; // "enchanted_golden_apple"

  // optional hook: if true, we skip actions (ex: while pathing / triggering)
  isBusy?: () => boolean;

  onNoTotem?: () => void;
  onNoFood?: () => void;
  onAteFood?: () => void;
};

const OFFHAND_SLOT = 45;
const TOTEM_NAME = "totem_of_undying";

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function findItem(bot: Bot, name: string) {
  return bot.inventory?.items()?.find((i) => i.name === name) ?? null;
}

function hasTotemOffhand(bot: Bot) {
  const off = bot.inventory?.slots?.[OFFHAND_SLOT];
  return !!off && off.name === TOTEM_NAME;
}

async function ensureTotemOffhand(bot: Bot, opts: Required<Pick<GeneralBotStuffOptions, "onNoTotem">>) {
  if (!bot?.inventory) return false;
  if (!bot.entity) return false;
  if (bot.currentWindow) return false; // don't fight other windows

  if (hasTotemOffhand(bot)) return true;

  const totem = findItem(bot, TOTEM_NAME);
  if (!totem) {
    opts.onNoTotem?.();
    return false;
  }

  try {
    // move to offhand slot.
    // @ts-ignore
    await bot.moveSlotItem(totem.slot, OFFHAND_SLOT);
    return true;
  } catch {
    return false;
  }
}

async function eatEnchantedGapple(
  bot: Bot,
  opts: Required<Pick<GeneralBotStuffOptions, "foodItemName" | "onNoFood" | "onAteFood">>
) {
  if (!bot.entity) return false;
  if (!bot.inventory) return false;
  if (bot.currentWindow) return false; // don't fight other windows
  if (isTriggerInProgress()) return; // dont mess with pearl triggering

  const food = findItem(bot, opts.foodItemName);
  if (!food) {
    opts.onNoFood?.();
    return false;
  }

  // equip first
  await bot.equip(food, "hand");
  await sleep(150);

  // Eat “manually” (more reliable on laggy servers than bot.consume()).
  bot.activateItem();

  const startFood = bot.food;
  const startHealth = bot.health;
  const start = Date.now();
  const TIMEOUT_MS = 15000;

  while (Date.now() - start < TIMEOUT_MS) {
    if (bot.food > startFood || bot.health > startHealth) {
      bot.deactivateItem();
      opts.onAteFood?.();
      return true;
    }
    await sleep(200);
  }

  bot.deactivateItem();
  return false;
}

export function installGeneralBotStuff(bot: Bot, options: GeneralBotStuffOptions = {}) {
  // defaults
  const opts = {
    antiAfk: options.antiAfk ?? true,
    antiAfkIntervalMs: options.antiAfkIntervalMs ?? 30_000,

    autoTotem: options.autoTotem ?? true,
    autoTotemIntervalMs: options.autoTotemIntervalMs ?? 1_000,

    autoGapEat: options.autoGapEat ?? true,

    eatIfHealthLeq: options.eatIfHealthLeq ?? 10,
    eatIfFoodLt: options.eatIfFoodLt ?? 6,

    foodItemName: options.foodItemName ?? "enchanted_golden_apple",

    isBusy: options.isBusy ?? (() => false),

    onNoTotem: options.onNoTotem ?? (() => {}),
    onNoFood: options.onNoFood ?? (() => {}),
    onAteFood: options.onAteFood ?? (() => {}),
  };

  let totemInterval: ReturnType<typeof setInterval> | null = null;
  let antiAfkInterval: ReturnType<typeof setInterval> | null = null;

  let eating = false;
  let lastNoTotemAt = 0;
  let lastNoFoodAt = 0;

  const noTotemThrottleMs = 60_000;
  const noFoodThrottleMs = 60_000;

  function clearLoops() {
    if (totemInterval) clearInterval(totemInterval);
    if (antiAfkInterval) clearInterval(antiAfkInterval);
    totemInterval = null;
    antiAfkInterval = null;
  }

  bot.once("spawn", () => {
    clearLoops();

    if (opts.autoTotem) {
      totemInterval = setInterval(() => {
        if (!bot.entity) return;
        if (opts.isBusy()) return;

        // throttle notifications
        const wrapped = {
          onNoTotem: () => {
            const now = Date.now();
            if (now - lastNoTotemAt >= noTotemThrottleMs) {
              lastNoTotemAt = now;
              opts.onNoTotem();
            }
          }
        };

        void ensureTotemOffhand(bot, wrapped).catch(() => {});
      }, opts.autoTotemIntervalMs);
    }

    if (opts.antiAfk) {
      antiAfkInterval = setInterval(() => {
        if (!bot.entity) return;
        if (opts.isBusy()) return;
        if (eating) return;

        try {
          bot.swingArm("right");
        } catch {}
      }, opts.antiAfkIntervalMs);
    }
  });

  // auto-eat: watch health/food changes
  if (opts.autoGapEat) {
    bot.on("health", () => {
      if (!bot.entity) return;
      if (opts.isBusy()) return;
      if (eating) return;
      if (bot.currentWindow) return;
      if (isTriggerInProgress()) return;

      const needEat = bot.health <= opts.eatIfHealthLeq || bot.food < opts.eatIfFoodLt;
      if (!needEat) return;

      eating = true;

      const wrapped = {
        foodItemName: opts.foodItemName,
        onNoFood: () => {
          const now = Date.now();
          if (now - lastNoFoodAt >= noFoodThrottleMs) {
            lastNoFoodAt = now;
            opts.onNoFood();
          }
        },
        onAteFood: opts.onAteFood,
      };

      (async () => {
        try {
          const ok = await eatEnchantedGapple(bot, wrapped);
          if (!ok) {
            log.warn("Auto-eat failed or timed out.");
          }
        } catch (err: any) {
          log.error({ err }, "Auto-eat error");
        } finally {
          eating = false;
        }
      })();
    });
  }

  // stop loops on disconnect
  bot.on("end", () => {
    clearLoops();
  });

  bot.on("kicked", () => {
    clearLoops();
  });

  bot.on("error", () => {
    clearLoops();
  });

  log.info("General bot stuff installed (anti-AFK / auto-totem / auto-gap).");

  return {
    stop: clearLoops,
  };
}
