import cron from "node-cron";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const SCRIPTS_DIR = process.env.SYNC_SCRIPTS_DIR || resolve(import.meta.dirname, "../../../scripts");
const SCHEDULE = process.env.SYNC_CRON_SCHEDULE || "0 1 * * *"; // 01:00 UTC

let running = false;

function runSync(): void {
  if (running) {
    console.log("[cron] Sync already running, skipping");
    return;
  }

  running = true;
  const start = Date.now();
  console.log(`[cron] Starting daily sync at ${new Date().toISOString()}`);

  const child = spawn("npx", ["tsx", "daily-sync-v2.ts"], {
    cwd: SCRIPTS_DIR,
    stdio: "pipe",
    env: { ...process.env },
  });

  child.stdout.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.log(`[sync] ${line}`);
    }
  });

  child.stderr.on("data", (data: Buffer) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      console.error(`[sync:err] ${line}`);
    }
  });

  child.on("close", (code) => {
    running = false;
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[cron] Sync finished in ${dur}s with exit code ${code}`);
  });

  child.on("error", (err) => {
    running = false;
    console.error(`[cron] Failed to start sync: ${err.message}`);
  });
}

export function startSyncCron(): void {
  if (!cron.validate(SCHEDULE)) {
    console.error(`[cron] Invalid schedule: ${SCHEDULE}`);
    return;
  }

  console.log(`[cron] Daily sync scheduled: ${SCHEDULE} (UTC)`);
  cron.schedule(SCHEDULE, runSync, { timezone: "UTC" });
}

export function triggerSyncManually(): boolean {
  if (running) return false;
  runSync();
  return true;
}

export function isSyncRunning(): boolean {
  return running;
}
