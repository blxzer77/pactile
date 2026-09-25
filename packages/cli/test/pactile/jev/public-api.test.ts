import { describe, expect, it } from "vitest";
import {
  createJevDecisionFacadeV1,
  planRetrievalWithJevV1,
} from "../../../src/index.js";

describe("public package Jev entry points", () => {
  it("exports the controlled decision facade and optional retrieval wrapper", () => {
    expect(typeof createJevDecisionFacadeV1).toBe("function");
    expect(typeof planRetrievalWithJevV1).toBe("function");
  });
});
