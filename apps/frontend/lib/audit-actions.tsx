"use client";

import * as React from "react";
import {
  Boxes,
  Cog,
  Database,
  FileCog,
  FilePlus,
  FileText,
  FolderTree,
  KeyRound,
  Link2,
  MoreHorizontal,
  Network,
  Plug,
  Power,
  Puzzle,
  RefreshCw,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  UserCog,
  UserMinus,
  UserPlus,
  UserX,
  Zap,
} from "lucide-react";

import { formatBytes, formatMb } from "@/lib/format";

/**
 * Shared presentation for the audit log.
 *
 * Every audit action gets a human label, a category (which drives the badge
 * color), and an icon. `describeMetadata` pulls the action-specific detail
 * (paths, sizes, from/to diffs) out of the metadata JSONB so the row can show
 * *what* changed at a glance.
 *
 * This is consumed by both the per-server activity tab and the fleet-wide admin
 * audit page so the two stay in sync. The admin page additionally renders
 * node/blueprint/user/settings/setup/suspicious actions that never appear in a
 * per-server feed.
 */

export type ActionCategory =
  | "lifecycle"
  | "console"
  | "files"
  | "subusers"
  | "sftp"
  | "config"
  | "databases"
  | "nodes"
  | "blueprints"
  | "admin"
  | "security"
  | "system";

export interface ActionMeta {
  label: string;
  category: ActionCategory;
  icon: React.ComponentType<{ className?: string }>;
}

/** Map a canonical audit action to a human label + category + icon. */
export function actionMeta(action: string): ActionMeta {
  switch (action) {
    // Lifecycle
    case "server.create":
      return { label: "Server created", category: "lifecycle", icon: Server };
    case "server.start":
      return { label: "Server started", category: "lifecycle", icon: Power };
    case "server.stop":
      return { label: "Server stopped", category: "lifecycle", icon: Power };
    case "server.restart":
      return { label: "Server restarted", category: "lifecycle", icon: RefreshCw };
    case "server.kill":
      return { label: "Server killed", category: "lifecycle", icon: Zap };
    case "server.delete":
      return { label: "Server deleted", category: "lifecycle", icon: Trash2 };
    case "server.suspend":
      return { label: "Server suspended", category: "admin", icon: ShieldAlert };
    case "server.unsuspend":
      return { label: "Server unsuspended", category: "admin", icon: ShieldAlert };

    // Config
    case "server.env.update":
      return { label: "Environment variables updated", category: "config", icon: FileCog };
    case "server.resources.update":
      return { label: "Resources updated", category: "config", icon: SlidersHorizontal };

    // Ports
    case "server.port.add":
      return { label: "Port added", category: "config", icon: Plug };
    case "server.port.remove":
      return { label: "Port removed", category: "config", icon: Plug };

    // Databases
    case "server.database.add":
      return { label: "Database added", category: "databases", icon: Database };
    case "server.database.remove":
      return { label: "Database removed", category: "databases", icon: Database };
    case "server.database.reset_password":
      return { label: "Database password reset", category: "databases", icon: KeyRound };

    // Console
    case "server.console.command":
      return { label: "Console command", category: "console", icon: MoreHorizontal };

    // Files
    case "server.file.write":
      return { label: "File edited", category: "files", icon: FileText };
    case "server.file.delete":
      return { label: "File deleted", category: "files", icon: Trash2 };
    case "server.file.rename":
      return { label: "File renamed", category: "files", icon: FolderTree };
    case "server.file.copy":
      return { label: "File copied", category: "files", icon: FolderTree };
    case "server.file.upload":
      return { label: "File uploaded", category: "files", icon: FilePlus };
    case "server.file.pull":
      return { label: "File pulled from URL", category: "files", icon: Link2 };

    // Plugins
    case "server.plugin.install":
      return { label: "Plugin installed", category: "files", icon: Puzzle };
    case "server.plugin.remove":
      return { label: "Plugin removed", category: "files", icon: Puzzle };
    case "server.plugin.toggle":
      return { label: "Plugin enabled/disabled", category: "files", icon: Puzzle };
    case "server.plugin.settings":
      return { label: "Plugin settings changed", category: "files", icon: Puzzle };
    case "server.plugin.auto-update":
      return { label: "Plugins auto-updated", category: "files", icon: Puzzle };

    // SFTP
    case "server.sftp.auth":
      return { label: "SFTP session", category: "sftp", icon: Plug };
    case "server.sftp.credential.create":
      return { label: "SFTP credential created", category: "sftp", icon: Plug };
    case "server.sftp.credential.regenerate":
      return { label: "SFTP credential regenerated", category: "sftp", icon: Plug };
    case "server.sftp.credential.delete":
      return { label: "SFTP credential deleted", category: "sftp", icon: Plug };

    // Subusers
    case "subuser.invite":
      return { label: "Subuser added", category: "subusers", icon: UserPlus };
    case "subuser.update":
      return { label: "Subuser permissions changed", category: "subusers", icon: UserCog };
    case "subuser.remove":
      return { label: "Subuser removed", category: "subusers", icon: UserMinus };

    // Nodes
    case "node.create":
      return { label: "Node created", category: "nodes", icon: Network };
    case "node.update":
      return { label: "Node updated", category: "nodes", icon: Network };
    case "node.delete":
      return { label: "Node deleted", category: "nodes", icon: Trash2 };
    case "node.drain":
      return { label: "Node drained", category: "nodes", icon: Network };
    case "node.portpool.add":
      return { label: "Node port pool entry added", category: "nodes", icon: Network };
    case "node.portpool.delete":
      return { label: "Node port pool entry removed", category: "nodes", icon: Network };

    // Blueprints
    case "blueprint.create":
      return { label: "Blueprint created", category: "blueprints", icon: Boxes };
    case "blueprint.update":
      return { label: "Blueprint updated", category: "blueprints", icon: Boxes };
    case "blueprint.delete":
      return { label: "Blueprint deleted", category: "blueprints", icon: Trash2 };
    case "blueprint.plugins.update":
      return { label: "Blueprint plugin support changed", category: "blueprints", icon: Puzzle };

    // Users / admin enforcement
    case "user.role.update":
      return { label: "User role changed", category: "admin", icon: ShieldCheck };
    case "user.ban":
      return { label: "User banned", category: "admin", icon: UserX };
    case "user.unban":
      return { label: "User unbanned", category: "admin", icon: ShieldCheck };
    case "user.delete":
      return { label: "User deleted", category: "admin", icon: UserX };

    // API keys
    case "apikey.create":
      return { label: "API key created", category: "security", icon: KeyRound };
    case "apikey.update":
      return { label: "API key updated", category: "security", icon: KeyRound };
    case "apikey.delete":
      return { label: "API key revoked", category: "security", icon: KeyRound };

    // Security
    case "suspicious.review":
      return { label: "Suspicious activity reviewed", category: "security", icon: ShieldAlert };
    case "suspicious.flag":
      return { label: "Suspicious activity flagged", category: "security", icon: ShieldAlert };

    // System / setup
    case "setup.admin.create":
      return { label: "First admin created", category: "system", icon: ShieldCheck };
    case "setup.complete":
      return { label: "Setup completed", category: "system", icon: ShieldCheck };
    case "settings.update":
      return { label: "Panel settings updated", category: "system", icon: Settings };

    default:
      return { label: action, category: "config", icon: Cog };
  }
}

export const CATEGORY_TONE: Record<ActionCategory, string> = {
  lifecycle: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  console: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  files: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  subusers: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  sftp: "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400",
  config: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  databases: "bg-pink-500/10 text-pink-600 dark:text-pink-400",
  nodes: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  blueprints: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  admin: "bg-red-500/10 text-red-600 dark:text-red-400",
  security: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
  system: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
};

/**
 * Render the action-specific detail from metadata as a short string.
 * Metadata never contains secret values (only paths, keys, sizes), so it is
 * safe to surface directly.
 *
 * Actions performed with an API key (rather than the session cookie) get a
 * "via API key" suffix regardless of action — the marker is stamped on the
 * metadata by the audit writer, not per-action.
 */
export function describeMetadata(
  action: string,
  meta: Record<string, unknown>,
): string | null {
  const base = describeActionMetadata(action, meta);

  if (meta.viaApiKey === true) {
    const prefix =
      typeof meta.viaKeyPrefix === "string" ? meta.viaKeyPrefix : null;
    const suffix = prefix ? `via API key ${prefix}…` : "via API key";
    return base ? `${base} · ${suffix}` : suffix;
  }
  return base;
}

function describeActionMetadata(
  action: string,
  meta: Record<string, unknown>,
): string | null {
  const str = (v: unknown): string | null =>
    typeof v === "string" ? v : null;
  const num = (v: unknown): number | null =>
    typeof v === "number" ? v : null;

  switch (action) {
    case "server.console.command": {
      const cmd = str(meta.command);
      return cmd ? `“${cmd}”` : null;
    }
    case "server.file.write":
    case "server.file.upload": {
      const path = str(meta.path);
      if (!path) return null;
      const size = num(meta.sizeBytes);
      if (size !== null && size > 0) return `${path} · ${formatBytes(size)}`;
      return path;
    }
    case "server.file.delete": {
      // Deletes are batched, so a row carries { paths }; rows written before
      // batching carry the legacy single { path }.
      const paths = meta.paths;
      if (Array.isArray(paths)) {
        const list = paths.filter((p): p is string => typeof p === "string");
        return list.length > 0 ? list.join(", ") : null;
      }
      return str(meta.path);
    }
    case "server.file.rename":
    case "server.file.copy": {
      const from = str(meta.from);
      const to = str(meta.to);
      return from && to ? `${from} → ${to}` : from ?? to;
    }
    case "server.file.pull": {
      const path = str(meta.path);
      const url = str(meta.url);
      if (path && url) return `${path} ← ${url}`;
      return path ?? url;
    }
    case "server.plugin.install": {
      const plugin = str(meta.plugin);
      const version = str(meta.version);
      if (plugin && version) return `${plugin} ${version}`;
      return plugin;
    }
    case "server.plugin.remove": {
      const plugin = str(meta.plugin);
      const filename = str(meta.filename);
      const dirs = meta.deletedConfigDirs;
      const wiped =
        Array.isArray(dirs) && dirs.length > 0
          ? ` · wiped ${dirs.filter((d): d is string => typeof d === "string").join(", ")}`
          : "";
      return plugin
        ? `${plugin}${filename ? ` (${filename})` : ""}${wiped}`
        : filename || null;
    }
    case "server.plugin.toggle": {
      const plugin = str(meta.plugin);
      const enabled = meta.enabled;
      if (plugin && typeof enabled === "boolean") {
        return `${plugin} · ${enabled ? "enabled" : "disabled"}`;
      }
      return plugin;
    }
    case "server.plugin.settings": {
      const autoUpdate = meta.autoUpdate;
      return typeof autoUpdate === "boolean"
        ? `auto-update ${autoUpdate ? "on" : "off"}`
        : null;
    }
    case "server.plugin.auto-update": {
      const updated = meta.updated;
      if (Array.isArray(updated)) {
        const rows = updated
          .filter(
            (u): u is { plugin: string; from: string; to: string } =>
              typeof u === "object" &&
              u !== null &&
              typeof (u as { plugin?: unknown }).plugin === "string",
          )
          .map((u) => `${u.plugin} ${u.from} → ${u.to}`);
        if (rows.length > 0) return rows.join(", ");
      }
      return null;
    }
    case "server.env.update": {
      const keys = meta.keys;
      if (Array.isArray(keys) && keys.length > 0) {
        return keys.filter((k): k is string => typeof k === "string").join(", ");
      }
      return null;
    }
    case "server.resources.update": {
      // metadata is { from: {cpuLimit, memoryLimitMb, diskLimitMb}, to: {...} }
      const pick = (obj: unknown) => {
        if (obj === null || typeof obj !== "object") return null;
        const o = obj as Record<string, unknown>;
        const cpu = num(o.cpuLimit);
        const mem = num(o.memoryLimitMb);
        const disk = num(o.diskLimitMb);
        if (cpu === null || mem === null || disk === null) return null;
        return `${cpu} CPU · ${formatMb(mem)} · ${formatMb(disk)}`;
      };
      const from = pick(meta.from);
      const to = pick(meta.to);
      if (from && to) return `${from} → ${to}`;
      return from ?? to;
    }
    case "server.port.add":
    case "server.port.remove": {
      const port = num(meta.port);
      const protocol = str(meta.protocol);
      // Older rows recorded a split {hostPort, containerPort} pair; show the
      // host side so they still render.
      const legacy = num(meta.hostPort);
      const shown = port ?? legacy;
      if (shown !== null) {
        return protocol ? `${shown} ${protocol}` : `${shown}`;
      }
      return null;
    }
    case "server.database.add": {
      const name = str(meta.dbName);
      return name ?? null;
    }
    case "server.database.remove": {
      const name = str(meta.dbName);
      return name ?? null;
    }
    case "subuser.invite":
    case "subuser.update":
    case "subuser.remove": {
      // Who the action touched, then the granted flags. The email is
      // denormalized into the record at write time so history survives the
      // grant being revoked or the account deleted; older rows predate it and
      // fall back to flags only. subuserId is a UUID — not useful to display.
      const email = str(meta.subuserEmail);
      const perms = meta.permissions;
      const flags =
        perms && typeof perms === "object"
          ? Object.entries(perms)
              .filter(([, v]) => v === true)
              .map(([k]) => k)
          : [];
      if (email && flags.length > 0) return `${email} · ${flags.join(", ")}`;
      if (email) return email;
      if (flags.length > 0) return flags.join(", ");
      return null;
    }
    case "server.sftp.auth": {
      const method = str(meta.method);
      return method ? `via ${method}` : null;
    }
    case "server.sftp.credential.create":
    case "server.sftp.credential.regenerate": {
      const username = str(meta.username);
      return username ?? null;
    }
    case "server.sftp.credential.delete": {
      const username = str(meta.deletedUsername);
      return username ?? null;
    }
    case "server.delete": {
      return meta.dataDeleted === true ? "data directory removed" : "data retained";
    }
    case "server.suspend": {
      const reason = str(meta.reason);
      return reason ?? null;
    }
    case "node.create":
    case "node.delete": {
      const name = str(meta.name);
      return name ?? null;
    }
    case "blueprint.create":
    case "blueprint.update": {
      const name = str(meta.name);
      return name ?? null;
    }
    case "user.role.update": {
      const from = str(meta.from);
      const to = str(meta.to);
      return from && to ? `${from} → ${to}` : null;
    }
    case "user.ban": {
      const reason = str(meta.reason);
      return reason ?? null;
    }
    case "apikey.create": {
      // The creator is always the key's owner (admins mint keys for
      // themselves), so naming the owner again would be noise.
      const name = str(meta.keyName);
      return name ? `"${name}"` : str(meta.keyPrefix) ? `${str(meta.keyPrefix)}…` : null;
    }
    case "apikey.delete": {
      const name = str(meta.keyName);
      const label = name ? `"${name}"` : str(meta.keyPrefix) ? `${str(meta.keyPrefix)}…` : null;
      const owner = str(meta.ownerEmail);
      if (label && owner) return `${label} · ${owner}`;
      return label;
    }
    case "apikey.update": {
      const name = str(meta.keyName);
      const label = name ? `"${name}"` : str(meta.keyPrefix) ? `${str(meta.keyPrefix)}…` : null;
      const enabled = meta.enabled;
      const state =
        typeof enabled === "boolean" ? (enabled ? "enabled" : "disabled") : null;
      const owner = str(meta.ownerEmail);
      const parts = [label, state].filter((p): p is string => p !== null);
      if (owner) parts.push(owner);
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    case "suspicious.flag": {
      const score = num(meta.score);
      const rules = meta.rules;
      if (Array.isArray(rules) && rules.length > 0) {
        const names = rules.filter((r): r is string => typeof r === "string");
        if (names.length > 0) {
          return score !== null ? `score ${score} · ${names.join(", ")}` : names.join(", ");
        }
      }
      return score !== null ? `score ${score}` : null;
    }
    case "settings.update": {
      const changed = meta.changed;
      if (Array.isArray(changed) && changed.length > 0) {
        return changed.filter((c): c is string => typeof c === "string").join(", ");
      }
      return null;
    }
    default:
      return null;
  }
}
