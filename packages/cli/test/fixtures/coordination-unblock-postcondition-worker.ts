import fs from "node:fs";
import { CoordinationStore } from "../../src/pactile/coordination/index.js";

const payload = process.env.PACTILE_UNBLOCK_WORKER_PAYLOAD;
const readyFile = process.env.PACTILE_UNBLOCK_WORKER_READY;
const releaseFile = process.env.PACTILE_UNBLOCK_WORKER_RELEASE;
if (!payload || !readyFile || !releaseFile) {
  process.stderr.write("worker environment is incomplete\n");
  process.exit(2);
}

const request = JSON.parse(payload) as {
  root: string;
  taskId: string;
  blockId: string;
};
const coordination = new CoordinationStore(request.root);
try {
  coordination.unblockTaskWithPostcondition(
    {
      taskId: request.taskId,
      blockId: request.blockId,
      reason: "A postcondition check is held open for the concurrency probe.",
      actor: { platform: "user", id: "test" },
      evidenceLevel: "local",
    },
    () => {
      fs.writeFileSync(readyFile, "unblock-appended\n", { flag: "wx" });
      while (!fs.existsSync(releaseFile)) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      throw new Error("simulated stale unblock");
    },
    {
      taskId: request.taskId,
      blockedByTaskId: "upstream",
      reason: "The postcondition failed; a fresh resolution is required.",
      actor: { platform: "user", id: "test" },
      evidenceLevel: "local",
    },
  );
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}
