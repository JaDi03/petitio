import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface PauseSwitch {
  paused(): boolean;
  set(on: boolean): void;
}

// a file on the Sprite's disk: read before every action, so a pause works without a redeploy
export function pauseSwitch(dataDir: string): PauseSwitch {
  const file = join(dataDir, "paused");
  return {
    paused: () => existsSync(file),
    set(on) {
      if (on) {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(file, new Date().toISOString());
      } else {
        rmSync(file, { force: true });
      }
    },
  };
}

export function memoryPause(initial = false): PauseSwitch {
  let on = initial;
  return { paused: () => on, set: (v) => { on = v; } };
}
