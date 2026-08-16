-- Adds maxDatabasesPerServer to the serverLimits panel setting.
--
-- A server owner may self-provision databases on the shared per-node MariaDB
-- (plan.md §7.1). This cap prevents one server from fragmenting the DB engine
-- with dozens of databases. Default 2 is enough for a main DB plus a separate
-- stats/economy DB; 0 forbids self-provisioning entirely (an admin can still
-- raise it per-fleet later through the admin settings page).
--
-- The key already exists (created by 011_server_port_limits.sql); this updates
-- its value to include the new field. ON CONFLICT DO UPDATE so re-running the
-- migration on a panel that already tuned the port limit merges rather than
-- clobbering.

INSERT INTO panel_settings (key, value)
VALUES (
  'serverLimits',
  '{"maxAdditionalPortsPerServer": 5, "maxDatabasesPerServer": 2}'::jsonb
)
ON CONFLICT (key) DO UPDATE
  SET value = panel_settings.value
    || jsonb_build_object(
      'maxDatabasesPerServer',
      COALESCE(
        (panel_settings.value->>'maxDatabasesPerServer')::int,
        2
      )
    );
