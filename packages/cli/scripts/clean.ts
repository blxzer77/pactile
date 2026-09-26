import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

for (const relativePath of ["dist", ".tmp/p31-script-build"]) {
  fs.rmSync(path.join(packageRoot, relativePath), {
    recursive: true,
    force: true,
  });
}
