"use client";

import * as React from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { adminListUsers, type ApiUser } from "@/lib/api";

/** A selectable user. `label` is what Base UI shows in the input once chosen. */
export interface UserOption {
  value: string;
  label: string;
  name: string;
  email: string;
}

export function toUserOption(user: ApiUser): UserOption {
  return { value: user.id, label: user.name, name: user.name, email: user.email };
}

/**
 * Owner picker that searches the user directory server-side as you type.
 *
 * It starts empty — nothing is pre-selected, so an admin has to name the owner
 * rather than accept whichever account happened to sort first.
 *
 * A plain <Select> of every account does not survive scale; this queries
 * `adminListUsers(q)` (debounced) and lets Base UI's combobox handle keyboard
 * and a11y. `filter={null}` disables client-side filtering because the server
 * already applied the query.
 */
export function UserCombobox({
  id,
  value,
  onChange,
  placeholder = "Search users by name or email…",
}: {
  id?: string;
  value: UserOption | null;
  onChange: (user: UserOption | null) => void;
  placeholder?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [items, setItems] = React.useState<UserOption[]>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    // After a selection Base UI sets the input to the chosen label, which fires
    // an input change — don't turn that into a redundant search.
    if (value && query === value.label) return;

    let cancelled = false;
    setLoading(true);
    const handle = setTimeout(async () => {
      try {
        const users = await adminListUsers(query.trim() || undefined);
        if (!cancelled) setItems(users.map(toUserOption));
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, value]);

  return (
    <Combobox
      items={items}
      value={value}
      onValueChange={(next) => onChange(next)}
      onInputValueChange={(text) => setQuery(text)}
      filter={null}
      isItemEqualToValue={(a, b) => a.value === b.value}
    >
      <ComboboxInput id={id} placeholder={placeholder} />
      <ComboboxContent>
        <ComboboxEmpty>
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            {loading ? "Searching…" : "No users found"}
          </div>
        </ComboboxEmpty>
        <ComboboxList>
          {items.map((user) => (
            <ComboboxItem key={user.value} value={user}>
              <div className="flex flex-col">
                <span className="font-medium">{user.name}</span>
                <span className="text-xs text-muted-foreground">{user.email}</span>
              </div>
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
