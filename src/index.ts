import { installPearlDetection } from "./pearlDetect.js";
import { initPathfinding } from "./pathing.js";
import { loadState, saveState } from "./state.js";
import { triggerPearl } from "./triggerPearl.js";
import { installCommands } from "./commands.js";
import { installGeneralBotStuff } from "./general.js";
import { isTriggerInProgress } from "./busy.js";
import { log } from "./logger.js";

import mineflayer, { type Bot } from "mineflayer";
import express from "express";

const state = loadState();

// ---- reconnect tuning ----
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;
const RECONNECT_JITTER_MS = 2_000;

let botRef: Bot | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let stopping = false;

function nextDelayMs() {
  // exponential backoff with cap + jitter
  const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts));
  const jitter = Math.floor(Math.random() * RECONNECT_JITTER_MS);
  return exp + jitter;
}

function clearReconnectTimer() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(reason: string, extra?: any) {
  if (stopping) return;
  if (reconnectTimer) return; // already scheduled

  const delay = nextDelayMs();
  log.warn({ delayMs: delay, attempts: reconnectAttempts, reason, extra }, "Scheduling reconnect");

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts++;
    createAndBindBot();
  }, delay);
}

function destroyBot(tag: string) {
  const bot = botRef;
  botRef = null;

  if (!bot) return;

  try {
    // remove listeners to avoid leaks if something keeps references
    bot.removeAllListeners();
  } catch {}

  try {
    // try graceful quit; if already ended, this is fine
    bot.quit();
  } catch {}

  log.info({ tag }, "Destroyed bot instance");
}

function createAndBindBot() {
  clearReconnectTimer();

  // if an old bot exists, nuke it first
  destroyBot("recreate");

  const bot = mineflayer.createBot({
    host: state.account.host,
    port: state.account.port,
    username: state.account.username,
    auth: state.account.auth,
    version: state.account.version,
  });

  botRef = bot;

  log.info(
    {
      host: state.account.host,
      username: state.account.username,
      version: state.account.version,
      attempt: reconnectAttempts,
    },
    "Bot connecting"
  );

  bot.once("spawn", () => {
    reconnectAttempts = 0; // reset backoff on successful spawn
    log.info("Spawned");

    // Install everything on this fresh instance
    initPathfinding(bot);
    installPearlDetection(bot, state);
    installCommands(bot, state);
    installGeneralBotStuff(bot, {
      autoGapEat: true,
      eatIfHealthLeq: 10, // eat at 5 hearts or lower
      eatIfFoodLt: 6, // eat when hunger < 6
      foodItemName: "enchanted_golden_apple",
      isBusy: () => isTriggerInProgress(),
    });
  });

  bot.on("kicked", (reason: string, loggedIn?: boolean) => {
    log.warn({ reason, loggedIn }, "Kicked from server");
    scheduleReconnect("kicked", { reason, loggedIn });
  });

  bot.on("end", () => {
    log.warn("Disconnected (end event)");
    scheduleReconnect("end");
  });

  bot.on("error", (err: Error) => {
    // Mineflayer often emits 'error' before 'end' in some cases,
    // so don't reconnect immediately here unless you want faster flaps.
    log.error({ err }, "Bot error occurred");
  });

  return bot;
}

// start bot the first time
createAndBindBot();

// ---------------- HTTP server (single instance) ----------------
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  const bot = botRef;
  res.json({
    ok: true,
    connected: !!bot,
    spawned: !!bot?.entity,
    username: bot?.username ?? null,
  });
});

const port = Number(8080);
app.listen(port, () => {
  log.info({ port }, "HTTP server up");
});

app.post("/trigger/player", async (req, res) => {
  const { player } = req.body ?? {};
  if (typeof player !== "string") {
    return res.status(400).json({ ok: false, error: "Expected { player: string }" });
  }

  const bot = botRef;
  if (!bot) {
    return res.status(503).json({ ok: false, error: "bot_not_connected" });
  }
  if (!bot.entity) {
    return res.status(503).json({ ok: false, error: "bot_not_spawned" });
  }

  try {
    const { pearlId } = await triggerPearl(bot, state, player);

    // saveState is synchronous (atomic rename). No need to await.
    saveState(state);

    res.json({ ok: true, triggered: pearlId });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? "trigger failed" });
  }
});

// graceful shutdown hooks
process.on("SIGINT", () => {
  stopping = true;
  clearReconnectTimer();
  destroyBot("SIGINT");
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopping = true;
  clearReconnectTimer();
  destroyBot("SIGTERM");
  process.exit(0);
});