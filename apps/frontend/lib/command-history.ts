export interface CommandHistory {
  entries: string[];
  position: number | null;
  draft: string;
  command: string;
}

export type CommandHistoryAction =
  | { type: "edit"; command: string }
  | { type: "submit"; command: string }
  | { type: "previous" }
  | { type: "next" };

export const emptyCommandHistory: CommandHistory = {
  entries: [],
  position: null,
  draft: "",
  command: "",
};

export function commandHistoryReducer(
  state: CommandHistory,
  action: CommandHistoryAction,
): CommandHistory {
  switch (action.type) {
    case "edit":
      return { ...state, command: action.command };
    case "submit": {
      const command = action.command.trim();
      if (!command) return state;
      return {
        ...emptyCommandHistory,
        entries: [...state.entries, command].slice(-100),
      };
    }
    case "previous": {
      if (state.entries.length === 0 || state.position === 0) return state;
      const position =
        state.position === null ? state.entries.length - 1 : state.position - 1;
      return {
        ...state,
        position,
        command: state.entries[position],
        draft: state.position === null ? state.command : state.draft,
      };
    }
    case "next": {
      if (state.position === null) return state;
      if (state.position === state.entries.length - 1) {
        return { ...state, position: null, command: state.draft, draft: "" };
      }
      const position = state.position + 1;
      return { ...state, position, command: state.entries[position] };
    }
  }
}
