/** Boots the legacy mock on its own port for integration tests. */

import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

export const TEST_PORT = 4273;
export const TEST_BASE_URL = `http://localhost:${TEST_PORT}`;

let server: ChildProcess | undefined;

export async function startApp(): Promise<void> {
  if (server) return;
  server = spawn("npx", ["tsx", "apps/legacy-core/server.ts"], {
    env: { ...process.env, LEGACY_CORE_PORT: String(TEST_PORT) },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${TEST_BASE_URL}/dev/state`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`Legacy mock did not start on ${TEST_BASE_URL}`);
}

export async function stopApp(): Promise<void> {
  server?.kill();
  server = undefined;
}

export async function inject(path: string): Promise<void> {
  await fetch(`${TEST_BASE_URL}${path}`);
}
