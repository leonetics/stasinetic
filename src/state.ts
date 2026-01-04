import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

const DEFAULT_STATE_PATH = (() => {
  // src/ -> dist/ at runtime. dist/state.js -> projectRoot/state.json
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "state.json");
})();

const STATE_PATH = process.env.STATE_PATH
  ? path.resolve(process.env.STATE_PATH)
  : DEFAULT_STATE_PATH;

export function loadState(): BotState {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`Missing state.json at ${STATE_PATH}`);
  }

  const raw = fs.readFileSync(STATE_PATH, "utf8");
  return JSON.parse(raw) as BotState;
}

export function saveState(state: BotState) {
  // write to temp then rename.
  const dir = path.dirname(STATE_PATH);
  const tmp = path.join(dir, `.state.json.tmp.${process.pid}`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, STATE_PATH);
  } finally {
    // best-effort cleanup if something went wrong before rename.
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}