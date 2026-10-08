# Panel export and import

Administrators can export the control plane under **Admin → Settings** and import
it into a fresh panel with no registered servers. An export holds users and their
password hashes, two-factor settings, API keys, branding and configuration, node
credentials, blueprints, and every server's metadata. It also includes subusers,
ports, environment variables, database credentials, plugins, schedules, audit and
job history, and the passwords and snapshot pointers needed to read S3 backups.

Server files stay on their nodes. MariaDB contents stay in their node database,
and restic snapshots stay in S3. Import never starts, stops, deletes or moves a
container. The restored panel uses the original server and node ids to reconnect
to those resources. A panel export is therefore useful after losing the panel
database, but is not a backup of a game world or a node disk.

Related: [backups.md](backups.md) covers files and node databases,
[archive.md](archive.md) explains why an archived server's snapshot pointer must
survive, [server-lifecycle.md](server-lifecycle.md) covers container recovery, and
[node-recovery.md](node-recovery.md) covers reconnecting a node without a panel
export.

## A portable archive without exporting the panel's boot secrets

The download is JSON containing one AES-256-GCM ciphertext. A passphrase of at
least twelve characters derives its key with scrypt, using a fresh 16-byte salt
and a fixed bounded work factor for every export. The GCM nonce is fresh too.
Neither metadata nor credential values appear as readable JSON in the file.
Keep the passphrase separately. Losing it makes the export unreadable.

The source panel decrypts its encrypted database fields in memory before sealing
the archive. The destination encrypts them again with its own
`PANEL_ENCRYPTION_KEY`. Better Auth's TOTP secrets and backup codes receive the
same treatment through Better Auth's encryption functions and the destination's
`BETTER_AUTH_SECRET`. Password and API-key hashes need no conversion. This lets a
new installation use new boot secrets without losing existing node credentials,
tenant database passwords or restic repository passwords.

The archive does not include `.env`, `DATABASE_URL`, `PANEL_ENCRYPTION_KEY` or
`BETTER_AUTH_SECRET`. Node bearer tokens are database metadata and are included,
so an unlocked archive grants control over those nodes. Only an administrator
signed in with a browser session can export or import. API keys cannot obtain a
snapshot even when they have an unrestricted scope.

## Why import replaces a fresh panel

Merging panel identities would need answers for owners with duplicate emails,
conflicting node ids, overlapping published ports and servers whose ids already
name running containers. Guessing any of those can transfer a tenant's server to
the wrong account or disconnect the panel from live files. Import instead keeps
the original ids and replaces the destination's metadata in one transaction.
The destination must contain no server records. Create and sign in with its
temporary administrator first, then import before registering a fleet.

The preview shows the export time, record counts, and imported administrator
emails. It requires at least one active imported administrator with a password
login. Confirming requires the exact text `REPLACE PANEL`. After import, sign in
with one of those imported accounts. The temporary administrator is replaced
along with the rest of the destination's users.

Sessions, verification challenges, and console capability tokens are deliberately
absent from exports and are cleared on import. They grant temporary access, not
panel identity. Auth caches are cleared and old browser-session cookies must
resolve against the now-empty session table before granting access. The importing
action is audited with the original operator's id and email as metadata because
their account may no longer exist after replacement.

## The commit point and things that cannot be guessed

Export captures all tables in one repeatable-read transaction with shared table
locks. Builds, power transitions, backups, migrations, archives, and scheduled
runs must be settled before exporting. Import refuses an archive with unfinished
work for the same reason: the detached task that owned that row does not travel
with the database record.

Import accepts a closed list of known tables and compares every column's name,
PostgreSQL type and nullability against the destination. Both panels must run the
same database schema. Unknown tables in the archive cannot become SQL, and an
extra installed table that references panel data blocks replacement rather than
being deleted by `CASCADE`.

The actual replacement takes exclusive locks, checks the destination again,
clears the known tables together and inserts rows in dependency order. The one
cycle, a server's `archive_run_id` pointing to a backup run that points back to the
server, is connected after the run rows exist. Serial log sequences are advanced
past imported ids. A failed constraint, incompatible row or lock timeout aborts
the transaction and leaves the prior panel intact. Five-second lock timeouts
prevent an import waiting indefinitely behind other requests.

The snapshot download is capped at 64 MB, its decoded metadata at 47 MB, and its
total rows at 500,000. Request bodies have a separate 70 MB streaming limit that
also applies when the sender omits `Content-Length`. Larger installations should
use a PostgreSQL backup and retain their original encryption keys.

Changing the panel hostname still needs the corresponding node `PANEL_URL` and
public console configuration updated. The export preserves saved addresses; it
cannot rewrite deployment configuration on another machine. Keep only one panel
actively managing a restored fleet.

## Validation

`panelSnapshotFormat.test.ts` checks archive authentication, passphrase handling,
the table allowlist, settled-job gates and every portable secret field. The
PostgreSQL integration suite is opt-in because it replaces all data in its test
database. Set `PANEL_SNAPSHOT_TEST_DATABASE_URL` to a disposable, fully migrated
database with `test` in its name, then run `panelSnapshot.integration.test.ts` in
its own Bun test process.

The integration fixture fills every exported table, including the archive's
circular foreign key and serial ids above JavaScript's safe integer limit. It
exports with one pair of boot encryption keys and imports with another, then
checks an actual password and two-factor backup-code sign-in. It also verifies
rollback on invalid foreign keys, protection for a live destination and extension
tables, session removal, API-key refusal and typed confirmation. Cached browser
identities must fail after import even when their user id survives. Cached
API-key identities must fail as soon as the key is disabled or deleted.
