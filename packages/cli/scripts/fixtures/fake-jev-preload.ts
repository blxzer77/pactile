import fs from "node:fs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRecord(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function sourceRefs(value: unknown): string[] {
  if (!isRecord(value) || typeof value.text !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value.text);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((candidate) =>
      isRecord(candidate) && typeof candidate.ref === "string"
        ? [candidate.ref]
        : [],
    );
  } catch {
    return [];
  }
}

const captureFile = process.env.PACTILE_TEST_JEV_CAPTURE;
const responseMode = process.env.PACTILE_TEST_JEV_RESPONSE ?? "answer";
let callCount = 0;

globalThis.fetch = async (input, init = {}) => {
  callCount += 1;
  const headers = new Headers(init.headers);
  const requestBody = parseRecord(String(init.body ?? "{}"));
  const state = isRecord(requestBody.state) ? requestBody.state : {};
  const snippets = Array.isArray(state.sourceSnippets)
    ? state.sourceSnippets.flatMap(sourceRefs)
    : [];
  const questions = isRecord(requestBody.questions)
    ? requestBody.questions
    : {};
  const candidateNames = Object.keys(questions);
  const capture = {
    callCount,
    url: String(input),
    method: init.method,
    authorizationMatchesConfiguredKey:
      headers.get("authorization") ===
      `Bearer ${process.env.PACTILE_JEV_API_KEY}`,
    body: requestBody,
  };
  if (!captureFile)
    throw new Error("Jev fixture capture path is not configured.");
  fs.writeFileSync(captureFile, JSON.stringify(capture));

  if (responseMode === "wait") {
    const releaseFile = process.env.PACTILE_TEST_JEV_RELEASE;
    const deadline = Date.now() + 8_000;
    while (
      releaseFile &&
      !fs.existsSync(releaseFile) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!releaseFile || !fs.existsSync(releaseFile)) {
      throw new Error("test did not release mock fetch");
    }
  }
  if (responseMode === "failure") {
    return new Response("provider detail must not escape", { status: 503 });
  }

  let selectedRefs: unknown = [];
  try {
    selectedRefs = JSON.parse(
      process.env.PACTILE_TEST_JEV_SELECTED_REFS ?? "[]",
    );
  } catch {
    selectedRefs = [];
  }
  const wantedRefs = new Set(Array.isArray(selectedRefs) ? selectedRefs : []);
  const answers = Object.fromEntries(
    candidateNames.map((name, index) => [
      name,
      {
        type: "noul",
        noul: wantedRefs.has(snippets[index]) ? 0.98 : 0.02,
      },
    ]),
  );
  return new Response(
    JSON.stringify({
      model: "jev-test-model",
      answers,
      usage: { input_tokens: 45, output_tokens: 5 },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-typesafe-request-id": "req_session_01",
      },
    },
  );
};
