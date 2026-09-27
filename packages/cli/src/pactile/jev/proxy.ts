import process from "node:process";
import { ProxyAgent } from "undici";
import { JEV_ENDPOINT_V1 } from "./contracts.js";

const JEV_HOST = new URL(JEV_ENDPOINT_V1).hostname.toLowerCase();
const JEV_PORT = "443";

function bypassesProxy(value: string | undefined): boolean {
  if (!value) return false;
  return value.split(/[\s,]+/u).some((entry) => {
    const token = entry.trim().toLowerCase();
    if (token === "*") return true;
    const match = /^(\*\.|\.)?([a-z0-9.-]+?)(?::(\d+))?$/u.exec(token);
    if (!match || (match[3] && match[3] !== JEV_PORT)) return false;
    const host = match[2];
    return host === JEV_HOST || JEV_HOST.endsWith(`.${host}`);
  });
}

/** Uses the caller's HTTPS proxy only for the fixed Jev origin. */
export function createJevEnvironmentFetchV1(): {
  fetchImpl: typeof fetch;
  close: () => Promise<void>;
} | null {
  const noProxy = process.env.no_proxy ?? process.env.NO_PROXY;
  if (bypassesProxy(noProxy)) return null;
  const proxyUri = process.env.https_proxy ?? process.env.HTTPS_PROXY;
  if (!proxyUri) return null;
  const agent = new ProxyAgent(proxyUri);
  return {
    fetchImpl: (input, init) =>
      globalThis.fetch(input, { ...init, dispatcher: agent } as RequestInit),
    close: async () => {
      await agent.destroy();
    },
  };
}
