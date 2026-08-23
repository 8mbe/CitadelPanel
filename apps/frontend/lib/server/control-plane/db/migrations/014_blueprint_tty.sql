-- CitadelPanel: blueprint TTY allocation.
--
-- Some server software only emits colored console output when it detects a real
-- terminal. The itzg/minecraft-server image uses JLine3's
-- TerminalConsoleAppender, which converts both log levels and Minecraft's own §
-- chat-formatting codes to ANSI, but only when stdout is a TTY. Without one it
-- strips all color, leaving the panel's ANSI renderer with nothing to render.
--
-- A blueprint can opt its container into a pseudo-TTY so the server's color
-- conversion runs. The attach layer detects a TTY container and reads its
-- stream as raw bytes (no 8-byte Docker multiplexing). See docker/attach.ts.
--
-- Defaults to FALSE: most game servers don't need it, and non-TTY keeps stdout
-- and stderr cleanly separated.

ALTER TABLE blueprints ADD COLUMN IF NOT EXISTS tty BOOLEAN NOT NULL DEFAULT FALSE;
