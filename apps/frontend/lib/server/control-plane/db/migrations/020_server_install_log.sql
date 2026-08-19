-- Provisioning output, kept on the server row.
--
-- Provisioning used to run inside the create request: the admin's POST held
-- open while the node pulled an image and ran the blueprint's install script,
-- and any node call that answered slower than its timeout failed the whole
-- create. It now runs as a background task and the row is the progress
-- report — which means the output has to live somewhere the next request can
-- read it, because the install container that produced it is removed as soon
-- as the script exits.
--
-- Append-only while a provision is in flight, and rewritten from scratch when
-- a server is re-provisioned. NOT NULL with a default so every existing row
-- reads as "no output recorded" rather than null.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS install_log TEXT NOT NULL DEFAULT '';

-- When the current (or last) provision started. Lets the UI show how long an
-- install has been running, and is what tells a panel restart which rows were
-- left mid-provision by the process that died. Nullable: servers created
-- before this column never recorded one.
ALTER TABLE servers
  ADD COLUMN IF NOT EXISTS install_started_at TIMESTAMPTZ;
