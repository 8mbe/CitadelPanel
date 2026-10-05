import { describe, expect, test } from "bun:test";
import { countFreePorts } from "./schedulerMath";

describe("countFreePorts", () => {
  test("counts pool numbers that are not already claimed", () => {
    expect(countFreePorts([25565, 25566, 25567], new Set([25566]))).toBe(2);
  });

  test("reports an exhausted pool as having no capacity", () => {
    expect(countFreePorts([25565, 25566], new Set([25565, 25566]))).toBe(0);
  });
});
