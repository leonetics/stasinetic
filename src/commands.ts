import type { Bot } from "mineflayer";
import type { BotState } from "./state.js";
import { triggerPearl } from "./triggerPearl.js";

// ---- anti-spam loophole ----
function randTag8(): string {
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0").slice(0, 8);
}

function normalizeName(s: string) {
  return (s || "").trim().toLowerCase();
}

export function countPearlsFor(state: BotState, username: string) {
  const u = normalizeName(username);
  let n = 0;
  for (const p of Object.values(state.pearls)) {
    if (normalizeName(p.owner) === u) n++;
  }
  return n;
}

export function reply(bot: Bot, username: string, _isWhisper: boolean, text: string) {
  const safe = String(text).replace(/\r?\n/g, " ").trim();
  bot.chat(`/w ${username} ${safe} [${randTag8()}]`);
}

async function handleCommand(
  bot: Bot,
  state: BotState,
  username: string,
  message: string
) {
  const msg = message.trim();
  if (!msg.startsWith("~")) return;

  const cmd = msg.split(/\s+/)[0]?.toLowerCase();

  // ~r / ~registered
  if (cmd === "~r" || cmd === "~registered") {
    const n = countPearlsFor(state, username);
    reply(
      bot,
      username,
      true,
      `${username} has ${n} pearl${n === 1 ? "" : "s"} registered at Stasinetic.`
    );
    return;
  }

  // ~s / ~stasinetic
  if (cmd === "~s" || cmd === "~stasinetic") {
    const n = countPearlsFor(state, username);

    if (n <= 0) {
      reply(bot, username, true, `No pearls registered for ${username} yet.`);
      return;
    }

    reply(bot, username, true, `Attempting to trigger your pearl...`);

    try {
      await triggerPearl(bot, state, username);
      reply(bot, username, true, `Triggered pearl for ${username}.`);
    } catch (err: any) {
      const m = err?.message || String(err);
      reply(bot, username, true, `Failed to trigger pearl: ${m}`);
    }
    return;
  }
}

function parseWhisperLine(line: string): { from: string; msg: string } | null {
  const s = String(line || "").trim();

  let m = s.match(/^(\w{1,16})\s+whispers(?::|\s+to\s+you:)\s+(.*)$/i);
  if (m) return { from: m[1], msg: m[2] };

  m = s.match(/^(\w{1,16})\s*->\s*you:\s*(.*)$/i);
  if (m) return { from: m[1], msg: m[2] };

  m = s.match(/^from\s+(\w{1,16}):\s*(.*)$/i);
  if (m) return { from: m[1], msg: m[2] };

  return null;
}

export function installCommands(bot: Bot, state: BotState) {
  bot.on("chat", (username: string, message: string) => {
    if (!username || username === bot.username) return;
    if (!message?.trim().startsWith("~")) return;
    void handleCommand(bot, state, username, message);
  });

  bot.on("messagestr", (line: string) => {
    const w = parseWhisperLine(line);
    if (!w) return;
    if (!w.from || w.from === bot.username) return;
    if (!w.msg?.trim().startsWith("~")) return;
    void handleCommand(bot, state, w.from, w.msg);
  });
}
