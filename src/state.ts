import fs from "fs";
import path from "path";

export type AccountConfig = {
  host: string;
  port?: number;
  username: string;
  auth: "microsoft" | "offline";
  version?: string;
};

export type BotState = {
  account: AccountConfig;
  pearls: Record<string, PearlRecord>;
};

export type Vec3 = {
  x: number;
  y: number;
  z: number;
};

export type PearlStatus = "airborne" | "stasis" | "gone" | "unknown";

export type PearlRecord = {
  owner: string;   // best-effort attribution
  pos: Vec3;       // for "stasis" we store block coords (ints)

  createdAt: number;
  lastSeenAt: number;

  // movement tracking for heuristic
  lastMoveAt: number;          // last time position changed meaningfully
  lastPos?: Vec3;              // last raw (non-snapped) position

  entityId?: number;           // mineflayer entity id while alive
  dimension?: string;
  status: PearlStatus;
};

const STATE_PATH = path.resolve(process.cwd(), "state.json");

export function loadState(): BotState {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`Missing state.json at ${STATE_PATH}`);
  }

  const raw = fs.readFileSync(STATE_PATH, "utf8");
  return JSON.parse(raw) as BotState;
}

export function saveState(state: BotState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}