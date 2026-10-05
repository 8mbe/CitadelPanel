import { describe, expect, test } from "bun:test";

import {
  commandHistoryReducer as reduce,
  emptyCommandHistory,
  type CommandHistory,
} from "./command-history";

function submitted(...commands: string[]): CommandHistory {
  return commands.reduce(
    (state, command) => reduce(state, { type: "submit", command }),
    emptyCommandHistory,
  );
}

describe("console command history", () => {
  test("recalls commands in submission order and stops at the oldest", () => {
    let state = submitted("list", "save-all", "say hello");
    for (const command of ["say hello", "save-all", "list"]) {
      state = reduce(state, { type: "previous" });
      expect(state.command).toBe(command);
    }
    expect(reduce(state, { type: "previous" })).toBe(state);
    for (const command of ["save-all", "say hello", ""]) {
      state = reduce(state, { type: "next" });
      expect(state.command).toBe(command);
    }
    expect(reduce(state, { type: "next" })).toBe(state);
  });

  test("restores the exact unsent draft after browsing multiple commands", () => {
    let state = reduce(submitted("list", "save-all"), {
      type: "edit", command: "  say draft  ",
    });
    state = reduce(state, { type: "previous" });
    state = reduce(state, { type: "previous" });
    state = reduce(state, { type: "next" });
    state = reduce(state, { type: "next" });
    expect(state.command).toBe("  say draft  ");
    expect(state.position).toBeNull();
    // A subsequent history visit captures the newly edited draft.
    state = reduce(state, { type: "edit", command: "new draft" });
    state = reduce(state, { type: "previous" });
    expect(reduce(state, { type: "next" }).command).toBe("new draft");
  });

  test("editing a recalled command preserves the original entry and draft", () => {
    let state = reduce(submitted("list", "say hello"), {
      type: "edit", command: "draft",
    });
    state = reduce(state, { type: "previous" });
    state = reduce(state, { type: "edit", command: "say goodbye" });
    expect(state.entries).toEqual(["list", "say hello"]);
    expect(reduce(state, { type: "next" }).command).toBe("draft");
    state = reduce(state, { type: "submit", command: state.command });
    expect(state.entries).toEqual(["list", "say hello", "say goodbye"]);
    expect(state.command).toBe("");
    expect(state.position).toBeNull();
    expect(state.draft).toBe("");
    expect(reduce(state, { type: "previous" }).command).toBe("say goodbye");
  });

  test("empty history leaves the draft alone", () => {
    const state = reduce(emptyCommandHistory, { type: "edit", command: "draft" });
    expect(reduce(state, { type: "previous" })).toBe(state);
    expect(reduce(state, { type: "next" })).toBe(state);
  });

  test("records repeated submissions separately", () => {
    let state = submitted("list", "list");
    expect(state.entries).toEqual(["list", "list"]);
    state = reduce(state, { type: "previous" });
    expect(state.position).toBe(1);
    state = reduce(state, { type: "previous" });
    expect(state.position).toBe(0);
    expect(state.command).toBe("list");
  });

  test("retains only the latest 100 submissions", () => {
    let state = submitted(...Array.from({ length: 105 }, (_, i) => `say ${i}`));
    expect(state.entries).toHaveLength(100);
    expect(state.entries[0]).toBe("say 5");
    state = reduce(state, { type: "previous" });
    expect(state.command).toBe("say 104");
    for (let i = 0; i < 110; i++) state = reduce(state, { type: "previous" });
    expect(state.command).toBe("say 5");
    expect(state.position).toBe(0);
  });

  test("trims submitted commands and ignores blank submissions", () => {
    const state = submitted("  list  ");
    expect(state.entries).toEqual(["list"]);
    expect(reduce(state, { type: "submit", command: " \t " })).toBe(state);
  });
});
