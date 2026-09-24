import path from "node:path";
import { parallelStatus, runParallelBatch } from "../pactile/parallel/batch.js";

export async function runParallelCli(argv: string[], root = process.cwd()): Promise<number> {
  const [operation, parent, ...args] = argv;
  try {
    if (!parent || parent.startsWith("--")) throw new Error("Parent task is required");
    if (operation === "status") {
      console.log(JSON.stringify(parallelStatus(root, parent), null, 2));
      return 0;
    }
    if (operation !== "run") throw new Error("Usage: pactile parallel <run|status> <parent> --manifest <file>");
    const index = args.indexOf("--manifest");
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("--manifest <file> is required");
    const result = await runParallelBatch(root, parent, path.resolve(root, args[index + 1]));
    console.log(JSON.stringify(result, null, 2));
    return result.children.every((child) => child.outcome === "settled") ? 0 : 1;
  } catch (error) {
    console.error(`Parallel dispatch: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
