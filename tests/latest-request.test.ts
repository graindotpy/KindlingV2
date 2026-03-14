import { describe, expect, it } from "vitest";
import { createLatestRequestGate } from "@/lib/search/latest-request";

describe("createLatestRequestGate", () => {
  it("lets only the most recent request update the UI", () => {
    const gate = createLatestRequestGate();
    const applied: string[] = [];
    const firstRequest = gate.begin();
    const secondRequest = gate.begin();

    if (gate.isCurrent(firstRequest)) {
      applied.push("first");
    }

    if (gate.isCurrent(secondRequest)) {
      applied.push("second");
    }

    expect(applied).toEqual(["second"]);
  });

  it("invalidates an in-flight request when the search state resets", () => {
    const gate = createLatestRequestGate();
    const requestId = gate.begin();

    gate.invalidate();

    expect(gate.isCurrent(requestId)).toBe(false);
  });
});
