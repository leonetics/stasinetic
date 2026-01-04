import type { Bot } from "mineflayer";
import type { BotState, Vec3 } from "./state.js";
import { saveState } from "./state.js";
import { log } from "./logger.js";
import { reply, countPearlsFor } from "./commands.js";

/**
 * 1) On startup, detect all pearls currently loaded.
 *    - If a pearl entityId already exists in JSON, ignore (no duplicates).
 *    - Otherwise register it as owner="unknown".
 *
 * 2) When pearls are triggered / become gone, remove from JSON automatically.
 *
 * + When a pearl is promoted to stasis, whisper the owner with updated count.
 */

// ---- promotion / motion tuning ----
const MIN_AGE_MS = 2500;   // don't promote pearls immediately after spawn
const SETTLE_MS = 600;     // must remain stable this long
const SPEED_EPS = 0.15;    // blocks/sec considered "basically not moving"
const MOVE_EPS = 0.15;     // ignore tiny jitter displacement (blocks)

// ---- attribution tuning ----
const SWING_WINDOW_MS = 300;  // how long a swing is considered relevant
const CANDIDATE_RADIUS = 14;  // max distance from player to pearl to consider attribution

// ---- reconciliation tuning ----
const RESCAN_MS = 1000;
// grace period before deleting a record whose entityId is missing.
// prevents false deletes when chunks unload/reload or mineflayer misses packets.
const MISSING_GRACE_MS = 5000;

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n));
}

function lookDir(yaw: number, pitch: number) {
  // mineflayer yaw/pitch are radians
  const x = -Math.sin(yaw) * Math.cos(pitch);
  const y = Math.sin(pitch);
  const z = -Math.cos(yaw) * Math.cos(pitch);
  return { x, y, z };
}

function dot(a: any, b: any) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function norm(v: any) {
  const m = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

function vecTo(from: any, to: any) {
  return { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
}

function dist(a: Vec3, b: Vec3) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function snapToBlock(p: Vec3): Vec3 {
  // Stasis trigger wants block coords
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function isEnderPearlEntity(entity: any): boolean {
  const name = (entity?.name || "").toLowerCase();
  const display = (entity?.displayName || "").toLowerCase();

  if (name === "ender_pearl" || name === "enderpearl") return true;
  if (display.includes("ender pearl")) return true;

  // fallback (loose)
  if (name.includes("pearl")) return true;

  return false;
}

function nowPos(entity: any): Vec3 {
  return { x: entity.position.x, y: entity.position.y, z: entity.position.z };
}

function tryPromoteToStasis(state: BotState, pearlKey: string, now: number): boolean {
  const rec = state.pearls[pearlKey];
  if (!rec) return false;
  if (rec.status !== "airborne") return false;

  const age = now - rec.createdAt;
  if (age < MIN_AGE_MS) return false;

  const stableSince = (rec as any).stableSince as number | undefined;
  if (!stableSince) return false;

  const stableFor = now - stableSince;
  if (stableFor < SETTLE_MS) return false;

  // promote using last stable raw position to avoid "bad Y mid-flight"
  const stablePos = (rec as any).stablePos as Vec3 | undefined;
  const raw = stablePos ?? rec.pos;

  rec.lastPos = raw;
  rec.pos = snapToBlock(raw);
  rec.status = "stasis";

  log.info(
    { pearlId: pearlKey, owner: rec.owner, pos: rec.pos, ageMs: age, stableForMs: stableFor },
    "Pearl promoted to stasis"
  );
  return true;
}

export function installPearlDetection(bot: Bot, state: BotState) {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = (reason: string) => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        saveState(state);
        log.debug({ reason }, "state.json saved");
      } catch (err: any) {
        log.error({ err, reason }, "Failed to save state.json");
      }
    }, 150);
  };

  const entityToKey = new Map<number, string>();

  const rebuildIndex = () => {
    entityToKey.clear();
    for (const [key, rec] of Object.entries(state.pearls)) {
      if (typeof rec.entityId === "number") entityToKey.set(rec.entityId, key);
    }
  };
  rebuildIndex();

  // Whisper owner on promotion (always whisper, never public)
  function notifyPromoted(owner: string) {
    if (!owner || owner === "unknown") return;

    const n = countPearlsFor(state, owner);
    reply(
      bot,
      owner,
      true,
      `Your pearl was promoted to Stasis. You now have ${n} pearl${n === 1 ? "" : "s"} registered.`
    );
  }

  const lastSwingByEntityId = new Map<number, { at: number }>();
  const client = (bot as any)._client;
  if (client?.on) {
    client.on("packet", (data: any, meta: any) => {
      const name = meta?.name;
      if (name !== "animation" && name !== "entity_animation") return;

      const eId = data?.entityId;
      if (typeof eId !== "number") return;

      lastSwingByEntityId.set(eId, { at: Date.now() });
    });
  } else {
    log.warn("No bot._client; owner attribution may be worse");
  }

  function pickOwnerForPearl(pearlPos: Vec3, now: number): string {
    let bestUser: string | undefined;
    let bestScore = -Infinity;

    for (const [username, pinfo] of Object.entries(bot.players)) {
      const ent: any = (pinfo as any)?.entity;
      if (!ent?.position) continue;

      const dx = ent.position.x - pearlPos.x;
      const dy = ent.position.y - pearlPos.y;
      const dz = ent.position.z - pearlPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > CANDIDATE_RADIUS * CANDIDATE_RADIUS) continue;

      // require a recent swing to attribute (prevents guessing for preexisting pearls)
      const swing = lastSwingByEntityId.get(ent.id);
      if (!swing) continue;

      const age = now - swing.at;
      if (age > SWING_WINDOW_MS) continue;
      const swingRecency = clamp01(1 - age / SWING_WINDOW_MS);

      const dir = lookDir(ent.yaw ?? 0, ent.pitch ?? 0);
      const toPearl = norm(vecTo(ent.position, pearlPos));
      const facing = clamp01((dot(norm(dir), toPearl) + 1) / 2);

      const closeness = 1 / (1 + distSq);
      const score = (swingRecency * 4) + (facing * 1.5) + (closeness * 1);

      if (score > bestScore) {
        bestScore = score;
        bestUser = username;
      }
    }

    return bestUser ?? "unknown";
  }

  function upsertPearlFromEntity(entity: any, source: "startup" | "spawn" | "rescan") {
    if (!isEnderPearlEntity(entity)) return;

    const eId = entity.id as number;
    const now = Date.now();

    // if already tracked by entityId, just refresh lastSeen/pos.
    const existingKey = entityToKey.get(eId);
    if (existingKey) {
      const rec = state.pearls[existingKey];
      if (!rec) {
        entityToKey.delete(eId);
      } else {
        rec.lastSeenAt = now;
        const raw = nowPos(entity);
        if (rec.status === "stasis") rec.lastPos = raw;
        else rec.pos = raw;

        delete (rec as any).missingSince;
      }
      return;
    }

    const p = nowPos(entity);

    // attribution ONLY for actual spawn events; for startup/rescan it's unknown.
    const owner = source === "spawn" ? pickOwnerForPearl(p, now) : "unknown";
    const pearlKey = source === "spawn" ? `${eId}:${now}` : `pre:${eId}:${now}`;

    state.pearls[pearlKey] = {
      owner,
      pos: { x: p.x, y: p.y, z: p.z },
      createdAt: now,
      lastSeenAt: now,
      lastMoveAt: now,
      entityId: eId,
      dimension: bot.game?.dimension,
      status: "airborne",
    };

    (state.pearls[pearlKey] as any).lastRawAt = now;
    (state.pearls[pearlKey] as any).lastSpeed = undefined;
    (state.pearls[pearlKey] as any).stableSince = undefined;
    (state.pearls[pearlKey] as any).stablePos = undefined;
    (state.pearls[pearlKey] as any).missingSince = undefined;

    entityToKey.set(eId, pearlKey);

    log.info({ pearlId: pearlKey, entityId: eId, owner, pos: p, source }, "Pearl registered");
    scheduleSave(`pearl_registered_${source}`);

    // delayed re-attribution for spawned pearls if swing arrives slightly late
    if (source === "spawn" && owner === "unknown") {
      setTimeout(() => {
        const rec = state.pearls[pearlKey];
        if (!rec || rec.owner !== "unknown") return;
        const better = pickOwnerForPearl(rec.pos, Date.now());
        if (better !== "unknown") {
          rec.owner = better;
          log.info({ pearlId: pearlKey, owner: better }, "Pearl owner resolved (delayed)");
          scheduleSave("pearl_owner_resolved");
        }
      }, 250);
    }
  }

  function removePearlRecord(pearlKey: string, reason: string) {
    const rec = state.pearls[pearlKey];
    if (!rec) return;

    const eId = rec.entityId;
    if (typeof eId === "number") entityToKey.delete(eId);

    delete state.pearls[pearlKey];
    log.info({ pearlId: pearlKey, reason }, "Pearl removed from state");
    scheduleSave(`pearl_removed_${reason}`);
  }

  function scanLoadedPearls(pass: "startup" | "delayed" | "rescan") {
    const entities: any = (bot as any).entities ?? {};
    for (const ent of Object.values(entities)) {
      if (!isEnderPearlEntity(ent)) continue;
      upsertPearlFromEntity(ent, pass === "rescan" ? "rescan" : "startup");
    }
  }

  scanLoadedPearls("startup");
  setTimeout(() => scanLoadedPearls("delayed"), 1500);

  bot.on("entitySpawn", (entity) => {
    if (!isEnderPearlEntity(entity)) return;
    upsertPearlFromEntity(entity, "spawn");
  });

  bot.on("entityMoved", (entity) => {
    if (!isEnderPearlEntity(entity)) return;

    const now = Date.now();
    const key = entityToKey.get(entity.id);
    if (!key) return;

    const rec = state.pearls[key];
    if (!rec) {
      entityToKey.delete(entity.id);
      return;
    }

    rec.lastSeenAt = now;

    const newPos = nowPos(entity);

    if (rec.status === "stasis") {
      rec.lastPos = newPos;
      delete (rec as any).missingSince;
      return;
    }

    const oldPos = rec.pos;
    rec.pos = newPos;

    const lastAt = ((rec as any).lastRawAt as number | undefined) ?? now;
    const dtMs = Math.max(1, now - lastAt);
    const dt = dtMs / 1000;

    const d = dist(oldPos, newPos);
    const speed = d / dt;

    (rec as any).lastSpeed = speed;
    (rec as any).lastRawAt = now;

    const moved = d > MOVE_EPS;

    if (moved || speed > SPEED_EPS) {
      rec.lastMoveAt = now;
      (rec as any).stableSince = undefined;
      (rec as any).stablePos = undefined;
    } else {
      if (!(rec as any).stableSince) (rec as any).stableSince = now;
      (rec as any).stablePos = newPos;
    }

    const promoted = tryPromoteToStasis(state, key, now);
    if (promoted) {
      notifyPromoted(rec.owner);
      scheduleSave("pearl_promoted_to_stasis");
    }

    delete (rec as any).missingSince;
  });

  bot.on("entityGone", (entity) => {
    if (!isEnderPearlEntity(entity)) return;

    const key = entityToKey.get(entity.id);
    if (!key) return;

    removePearlRecord(key, "entityGone");
  });

  setInterval(() => {
    const now = Date.now();

    scanLoadedPearls("rescan");

    const entities: any = (bot as any).entities ?? {};

    for (const [key, rec] of Object.entries(state.pearls)) {
      const eId = rec.entityId;
      if (typeof eId !== "number") continue;

      const ent = entities[eId];

      if (ent && isEnderPearlEntity(ent)) {
        rec.lastSeenAt = now;

        const raw = nowPos(ent);
        if (rec.status === "stasis") rec.lastPos = raw;
        else rec.pos = raw;

        delete (rec as any).missingSince;
        continue;
      }

      const missingSince = (rec as any).missingSince as number | undefined;
      if (!missingSince) {
        (rec as any).missingSince = now;
        continue;
      }

      if (now - missingSince >= MISSING_GRACE_MS) {
        removePearlRecord(key, "missing_rescan");
      }
    }

    for (const [key, rec] of Object.entries(state.pearls)) {
      if (rec.status !== "airborne") continue;

      const promoted = tryPromoteToStasis(state, key, now);
      if (promoted) {
        notifyPromoted(rec.owner);
        scheduleSave("pearl_promoted_interval");
      }
    }
  }, RESCAN_MS);
}