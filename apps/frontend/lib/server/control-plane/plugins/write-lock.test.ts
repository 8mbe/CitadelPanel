import { expect, test } from "bun:test";
import { beginPluginWrite } from "./write-lock";

test("a concurrent write is rejected for the same server only", () => {
  const release = beginPluginWrite("one")!;
  const releaseOther = beginPluginWrite("two")!;
  expect(beginPluginWrite("one")).toBeNull();
  release();
  const releaseNext = beginPluginWrite("one")!;
  expect(releaseNext).toBeFunction();
  release();
  expect(beginPluginWrite("one")).toBeNull();
  releaseNext();
  releaseOther();
});
