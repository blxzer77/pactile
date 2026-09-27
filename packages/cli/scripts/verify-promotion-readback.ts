import path from "node:path";
import { pathToFileURL } from "node:url";

const NPM_DIST_TAGS_URL =
  "https://registry.npmjs.org/-/package/%40blxzer%2Fpactile/dist-tags";

export async function verifyPromotionReadback({
  version,
  fetchImpl = fetch,
}: {
  version: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!version.trim()) {
    throw new Error("VERSION is required to verify the npm promotion.");
  }

  const response = await fetchImpl(NPM_DIST_TAGS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Registry HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    throw new Error("Registry dist-tag response must be a JSON object.");
  }

  const tags = payload as Record<string, unknown>;
  if (tags.latest !== version || Object.hasOwn(tags, "candidate")) {
    throw new Error(
      "Registry readback did not confirm latest promotion and candidate removal.",
    );
  }
}

async function runCli(): Promise<void> {
  const version = process.env.VERSION;
  if (!version) {
    throw new Error("VERSION is required to verify the npm promotion.");
  }
  await verifyPromotionReadback({ version });
}

const invokedAs = process.argv[1];
if (
  invokedAs &&
  import.meta.url === pathToFileURL(path.resolve(invokedAs)).href
) {
  runCli().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
