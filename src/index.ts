import { installPearlDetection } from "./pearlDetect.js";
import { gotoNear, initPathfinding } from "./pathing.js";
import { loadState, saveState } from "./state.js";
import { triggerPearl } from "./triggerPearl.js";

import { log } from "./logger.js";

import mineflayer from "mineflayer";
import express from "express";

const state = loadState();

const bot = mineflayer.createBot({
  host: state.account.host,
  port: state.account.port,
  username: state.account.username,
  auth: state.account.auth,
  version: state.account.version,
});

log.info(
  {
    host: state.account.host,
    username: state.account.username,
    version: state.account.version
  },
  "Loaded account config"
);

bot.once("spawn", () => {
  log.info("Spawned");
  initPathfinding(bot);
  installPearlDetection(bot, state);
});
bot.on("kicked", (reason: string, loggedIn?: boolean) => {
  log.warn({ reason, loggedIn }, "Kicked from server");
});
bot.on("error", (err: Error) => {
  log.error({ err }, "Error occurred");
});

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
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

  try {
    const { pearlId } = await triggerPearl(bot, state, player);

    await saveState(state)

    res.json({ ok: true, triggered: pearlId });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message ?? "trigger failed" });
  }
});

