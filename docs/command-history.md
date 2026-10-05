# Console command history

The console input remembers the latest 100 commands submitted from that view.
Arrow Up recalls the latest submission, then walks toward older commands. Arrow
Down walks toward newer commands and finally restores the unsent draft the user
had before browsing. Navigation stops at either end. Repeated submissions remain
separate entries so the order matches what the user sent.

Recall fills the input; it never sends anything. A recalled command can be edited
and submitted with Enter or Send. Editing does not change the stored entry or
the original draft. Leaving an edited recall to browse again discards that edit;
submitting it adds a new history entry and clears the input.

## Where the history lives

History is component state in `ConsoleCommandInput`, keyed by server id. Switching
servers or leaving the console unmounts that state; refreshing clears it too.
Connection drops, reconnects, and server power changes retain it while the view
stays mounted. Nothing is written to browser storage or fetched from audit logs.
This keeps another user's commands out of recall and avoids leaving command text
on a shared device after the view closes.

The input records a command only after the console's submission callback accepts
it. A blank command, an offline/disconnected console, or a direct socket that is
no longer open does not clear the input or add an entry. Accepted means handed to
the existing WebSocket or HTTP submission path, not confirmed execution by the
game server. A later HTTP failure remains visible in console output, and the
submitted command remains available to recall and retry. Both transports use the
same history; see [direct-console.md](direct-console.md) for their auth and audit
flow.

## Phones and keyboard access

Previous and Next buttons beside the input provide the same navigation without
requiring arrow keys on a phone keyboard. They have 44px targets below the `sm`
breakpoint and use the existing dense button size on larger screens. Pointer
presses preserve input focus instead of moving it to a button and closing the
software keyboard. Recall places the caret at the end for editing. Buttons have
accessible names and stay reachable by Tab; they disable at their history
boundary and whenever the input is unavailable.

Only unmodified Arrow Up and Arrow Down in the command input navigate history.
Modifier shortcuts and IME composition retain their normal keyboard behavior.
The mobile input uses 16px text to avoid focus zoom, disables capitalization,
autocorrection, and spellcheck, and requests a Send action from software keyboards.
