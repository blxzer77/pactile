import fs from "node:fs";
import { type ResumeTaskRunRequest } from "../../src/core/task/index.js";
import { resumeTaskRunWithCoordinationBarrier } from "../../src/pactile/coordination/index.js";

const payload = process.env.PACTILE_RESUME_WORKER_PAYLOAD;
const readyFile = process.env.PACTILE_RESUME_WORKER_READY;
const goFile = process.env.PACTILE_RESUME_WORKER_GO;
if (!payload || !readyFile || !goFile) {
  process.stderr.write("worker environment is incomplete\n");
  process.exit(2);
}

const request = JSON.parse(payload) as ResumeTaskRunRequest;
fs.writeFileSync(readyFile, "ready\n", { flag: "wx" });
while (!fs.existsSync(goFile)) {
  await new Promise((resolve) => setTimeout(resolve, 2));
}

try {
  const result = resumeTaskRunWithCoordinationBarrier(request);
  process.stdout.write(
    `${JSON.stringify({ ok: true, revision: result.kernel.revision })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
}
