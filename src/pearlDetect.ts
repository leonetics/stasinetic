// src/pearlDetect.ts
import type { Bot } from "mineflayer";
import type { BotState, Vec3 } from "./state.js";
import { log } from "./logger.js";

/**
 * Goal:
 * - Detect ender pearls
 * - Attribute owner ONLY if a recent swing exists (prevents "guessing" on preexisting pearls)
 * - Promote to stasis ONLY after:
 *    1) pearl is at least MIN_AGE_MS old
 *    2) pearl has been continuously "stable" for SETTLE_MS
 * - Stability is measured via speed + displacement (not just instantaneous jitter)
 */

// ---- promotion / motion tuning ----
const MIN_AGE_MS = 2500;   // don't promote pearls immediately after spawn
const SETTLE_MS = 600;    // must remain stable this long
const SPEED_EPS = 0.08;    // blocks/sec considered "basically not moving"
const MOVE_EPS = 0.15;     // ignore tiny jitter displacement (blocks)

// ---- attribution tuning ----
const SWING_WINDOW_MS = 2000;  // how long a swing is considered relevant
const CANDIDATE_RADIUS = 14;   // max distance from player to pearl to consider attribution

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

function tryPromoteToStasis(state: BotState, pearlId: string, now: number) {
  const rec = state.pearls[pearlId];
  if (!rec) return;
  if (rec.status !== "airborne") return;

  const age = now - rec.createdAt;
  if (age < MIN_AGE_MS) return;

  const stableSince = (rec as any).stableSince as number | undefined;
  if (!stableSince) return;

  const stableFor = now - stableSince;
  if (stableFor < SETTLE_MS) return;

  // Promote using last stable raw position to avoid "bad Y mid-flight"
  const stablePos = (rec as any).stablePos as Vec3 | undefined;
  const raw = stablePos ?? rec.pos;

  rec.lastPos = raw;
  rec.pos = snapToBlock(raw);
  rec.status = "stasis";

  log.info(
    { pearlId, owner: rec.owner, pos: rec.pos, ageMs: age, stableForMs: stableFor },
    "Pearl promoted to stasis (stable window)"
  );
}

export function installPearlDetection(bot: Bot, state: BotState) {
  // ---- swing capture ----
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

      // REQUIRE a recent swing to attribute (prevents guessing for preexisting pearls)
      const swing = lastSwingByEntityId.get(ent.id);
      if (!swing) continue;

      const age = now - swing.at;
      if (age > SWING_WINDOW_MS) continue;

      const swingRecency = clamp01(1 - age / SWING_WINDOW_MS);

      // tie-breakers
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

  bot.on("entitySpawn", (entity) => {
    if (!isEnderPearlEntity(entity)) return;

    const now = Date.now();
    const p = entity.position as Vec3;

    const pearlId = `${entity.id}:${now}`;
    const owner = pickOwnerForPearl({ x: p.x, y: p.y, z: p.z }, now);

    state.pearls[pearlId] = {
      owner,
      pos: { x: p.x, y: p.y, z: p.z },
      createdAt: now,
      lastSeenAt: now,
      lastMoveAt: now,
      entityId: entity.id,
      dimension: bot.game?.dimension,
      status: "airborne"
    };

    // additional runtime-only fields used by heuristic
    (state.pearls[pearlId] as any).lastRawAt = now;
    (state.pearls[pearlId] as any).lastSpeed = undefined;
    (state.pearls[pearlId] as any).stableSince = undefined;
    (state.pearls[pearlId] as any).stablePos = undefined;

    log.info({ pearlId, owner, pos: state.pearls[pearlId].pos }, "Pearl detected (spawn)");

    // Delayed re-attribution (only helps if a swing arrives slightly after spawn)
    if (owner === "unknown") {
      setTimeout(() => {
        const rec = state.pearls[pearlId];
        if (!rec || rec.owner !== "unknown") return;

        const better = pickOwnerForPearl(rec.pos, Date.now());
        if (better !== "unknown") {
          rec.owner = better;
          log.info({ pearlId, owner: better }, "Pearl owner resolved (delayed)");
        }
      }, 250);
    }
  });

  bot.on("entityMoved", (entity) => {
    if (!isEnderPearlEntity(entity)) return;

    const now = Date.now();

    const recKey = Object.keys(state.pearls).find(
      (k) => state.pearls[k]?.entityId === entity.id
    );
    if (!recKey) return;

    const rec = state.pearls[recKey];
    const newPos = { x: entity.position.x, y: entity.position.y, z: entity.position.z };

    rec.lastSeenAt = now;

    // For stasis pearls, don't overwrite snapped pos; keep lastPos for debug
    if (rec.status === "stasis") {
      rec.lastPos = newPos;
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

    // Determine stability
    const moved = d > MOVE_EPS;

    if (moved || speed > SPEED_EPS) {
      rec.lastMoveAt = now;
      (rec as any).stableSince = undefined;
      (rec as any).stablePos = undefined;
    } else {
      if (!(rec as any).stableSince) (rec as any).stableSince = now;
      (rec as any).stablePos = newPos;
    }

    tryPromoteToStasis(state, recKey, now);
  });

  bot.on("entityGone", (entity) => {
    if (!isEnderPearlEntity(entity)) return;

    const now = Date.now();

    const recKey = Object.keys(state.pearls).find(
      (k) => state.pearls[k]?.entityId === entity.id
    );
    if (!recKey) return;

    const rec = state.pearls[recKey];

    if (rec.status === "stasis") {
      rec.lastSeenAt = now;
      rec.entityId = undefined;
      log.info({ pearlId: recKey, owner: rec.owner }, "Stasis pearl entity gone (kept)");
      return;
    }

    // last-moment promotion attempt
    tryPromoteToStasis(state, recKey, now);

    if (state.pearls[recKey].status === "stasis") {
      state.pearls[recKey].entityId = undefined;
      log.info({ pearlId: recKey, owner: rec.owner }, "Pearl gone but promoted to stasis");
      return;
    }

    rec.status = "gone";
    rec.lastSeenAt = now;
    rec.entityId = undefined;

    log.info({ pearlId: recKey, owner: rec.owner }, "Pearl entity gone (not stasis)");
  });

  // Periodic promotion in case entityMoved stops firing (lag/chunk weirdness)
  setInterval(() => {
    const now = Date.now();
    for (const [id, rec] of Object.entries(state.pearls)) {
      if (rec.status === "airborne") {
        tryPromoteToStasis(state, id, now);
      }
    }
  }, 500);
}
