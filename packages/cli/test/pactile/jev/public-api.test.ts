import { describe, expect, it } from "vitest";
import {
  createJevDecisionFacadeV1,
  prepareBatch2TileSelectionWithJevV1,
  prepareSelectedTaskAgentTileSelectionWithJevV1,
  adviseTileSelectionWithJevV1,
  planRetrievalWithJevV1,
} from "../../../src/index.js";

describe("public package Jev entry points", () => {
  it("exports the controlled decision facade and optional decision wrappers", () => {
    expect(typeof createJevDecisionFacadeV1).toBe("function");
    expect(typeof planRetrievalWithJevV1).toBe("function");
    expect(typeof adviseTileSelectionWithJevV1).toBe("function");
    expect(typeof prepareBatch2TileSelectionWithJevV1).toBe("function");
    expect(typeof prepareSelectedTaskAgentTileSelectionWithJevV1).toBe(
      "function",
    );
  });
});
