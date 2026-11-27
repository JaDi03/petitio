import { existsSync } from "node:fs";
import { request } from "node:http";

// Sprites Tasks API: a live task keeps the Sprite from pausing mid-run
// https://docs.fly.io/sprites/keeping-sprites-running.md
const SOCKET = "/.sprite/api.sock";

function call(method: string, path: string, body?: unknown): Promise<void> {
  if (!existsSync(SOCKET)) return Promise.resolve();
  return new Promise((resolve) => {
    const req = request(
      { socketPath: SOCKET, path, method, headers: { host: "sprite", "content-type": "application/json" }, timeout: 5000 },
      (res) => {
        res.resume();
        res.on("end", () => { resolve(); });
      },
    );
    // a failed hold only risks a pause; the run itself goes on
    req.on("error", () => { resolve(); });
    req.on("timeout", () => { req.destroy(); });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

export async function withHold<T>(name: string, work: () => Promise<T>): Promise<T> {
  await call("POST", "/v1/tasks", { name, expire: "5m" });
  try {
    return await work();
  } finally {
    await call("DELETE", `/v1/tasks/${encodeURIComponent(name)}`);
  }
}
