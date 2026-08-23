-- CitadelPanel: hand difficulty, max players and online mode back to
-- server.properties on Minecraft: Java Edition servers.
--
-- The itzg image rewrites server.properties from its property environment
-- variables on every boot. While DIFFICULTY, MAX_PLAYERS and ONLINE_MODE were
-- declared in the blueprint, every Java server was created with them set, so
-- an owner who edited difficulty, max-players or online-mode in the Files tab
-- had the edit reverted the next time the server started, with nothing in the
-- panel to explain why. ONLINE_MODE was the worst of the three: velocity-proxy.md
-- tells owners to put online-mode=false in server.properties to enable modern
-- forwarding, which the env then undid.
--
-- The blueprint no longer declares them (an unset variable is left alone by the
-- image), but the values already stored per server would keep being handed to
-- the agent on the next container recreate. Dropping the rows here is what makes
-- the file authoritative for servers that already exist.
--
-- Scoped to the built-in minecraft-java blueprint on purpose: minecraft-bedrock
-- keeps these variables, and an admin-created blueprint may legitimately declare
-- keys with the same names.
--
-- Existing containers keep the env they were created with until they are
-- recreated (a port change, a link change, a reinstall or a heal). Docker fixes
-- a container's environment at creation time.

DELETE FROM server_env
WHERE key IN ('DIFFICULTY', 'MAX_PLAYERS', 'ONLINE_MODE')
  AND server_id IN (
    SELECT s.id
    FROM servers s
    JOIN blueprints b ON b.id = s.blueprint_id
    WHERE b.key = 'minecraft-java'
      AND b.is_builtin = TRUE
  );
