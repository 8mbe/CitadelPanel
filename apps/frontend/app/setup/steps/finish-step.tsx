"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChartLine,
  DatabaseBackup,
  FileText,
  Palette,
  Scale,
  Sparkles,
  X,
} from "lucide-react";

import type { AdminSettings } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * The last screen: what this install ended up with, and what is left.
 *
 * Everything the wizard deliberately left out is listed here with a link,
 * rather than being silently dropped. Backups, the AI helper, analytics and the
 * legal pages are all safe to postpone and all easy to forget forever, and an
 * operator who never learns they exist is the failure this screen prevents.
 *
 * The done list is above the todo list on purpose. The wizard has just asked
 * for a lot of decisions; the first thing it owes the operator is confirmation
 * that they took effect.
 */

interface Remaining {
  id: string;
  label: string;
  detail: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
}

export function FinishStep({
  settings,
  nodeName,
  serverName,
  serverId,
}: {
  settings: AdminSettings;
  nodeName: string | null;
  serverName: string | null;
  serverId: string | null;
}) {
  const done: { label: string; ok: boolean }[] = [
    { label: `Named "${settings.branding.siteName}"`, ok: true },
    { label: `Timestamps in ${settings.timezone}`, ok: true },
    {
      label: settings.registration.enabled
        ? "Public sign-up is open"
        : "Sign-up is closed to strangers",
      ok: true,
    },
    {
      label: settings.captcha.enabled
        ? "Bot protection on the auth forms"
        : "No captcha on the auth forms",
      ok: settings.captcha.enabled,
    },
    {
      label: settings.mail.enabled
        ? "Outbound email configured"
        : "No outbound email: password reset is unavailable",
      ok: settings.mail.enabled,
    },
    {
      label: nodeName ? `Node "${nodeName}" registered` : "No node registered yet",
      ok: nodeName != null,
    },
    ...(serverName ? [{ label: `Server "${serverName}" created`, ok: true }] : []),
  ];

  const remaining: Remaining[] = [];
  if (!settings.mail.enabled) {
    remaining.push({
      id: "mail",
      label: "Outbound email",
      detail: "Until this is set, nobody can reset a forgotten password.",
      href: "/admin/settings",
      icon: FileText,
    });
  }
  if (!nodeName) {
    remaining.push({
      id: "node",
      label: "Register a node",
      detail: "No servers can exist until one machine is running the agent.",
      href: "/admin/nodes",
      icon: ArrowRight,
    });
  }
  if (!settings.backups.enabled) {
    remaining.push({
      id: "backups",
      label: "Backups",
      detail:
        "Snapshots of server files and node databases to S3-compatible storage. Nothing is backed up until this is on.",
      href: "/admin/backups",
      icon: DatabaseBackup,
    });
  }
  remaining.push({
    id: "legal",
    label: "Terms and privacy policy",
    detail:
      "The panel ships drafts, not defaults. Read and adapt them before anyone else signs up.",
    href: "/admin/legal",
    icon: Scale,
  });
  if (!settings.ai.enabled) {
    remaining.push({
      id: "ai",
      label: "AI console helper",
      detail:
        "Optional. Point it at any OpenAI-compatible endpoint to explain console output to server owners.",
      href: "/admin/settings",
      icon: Sparkles,
    });
  }
  remaining.push({
    id: "theme",
    label: "Colours and theme",
    detail: "Set the site theme's base and accent colours to match your brand.",
    href: "/admin/settings",
    icon: Palette,
  });
  if (!settings.analytics.enabled || !settings.seo.allowIndexing) {
    remaining.push({
      id: "seo",
      label: "Search indexing and analytics",
      detail:
        "Indexing is off by default, so search engines will ignore this panel until you turn it on.",
      href: "/admin/settings",
      icon: ChartLine,
    });
  }

  return (
    <>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Check className="size-5 text-primary" />
          Setup complete
        </CardTitle>
        <CardDescription>
          {settings.branding.siteName} is configured and this wizard will not
          run again. Everything below can still be changed from the admin area.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ul className="flex flex-col gap-1.5">
          {done.map((item) => (
            <li key={item.label} className="flex items-start gap-2 text-sm">
              {item.ok ? (
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
              ) : (
                <X className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span
                className={cn(
                  item.ok ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {item.label}
              </span>
            </li>
          ))}
        </ul>

        {remaining.length > 0 && (
          <>
            <Separator />
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <h3 className="text-sm font-medium">Worth doing next</h3>
                <p className="text-xs text-muted-foreground">
                  None of these block anything today. All of them are easier now
                  than after the panel has users.
                </p>
              </div>
              <ul className="flex flex-col gap-2">
                {remaining.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.id}>
                      <Link
                        href={item.href}
                        className="flex items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50"
                      >
                        <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="text-sm font-medium">{item.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {item.detail}
                          </span>
                        </span>
                        <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="ml-auto"
            render={<Link href={serverId ? `/servers/${serverId}/console` : "/"} />}
            nativeButton={false}
          >
            {serverId ? "Open your server" : "Go to the panel"}
            <ArrowRight />
          </Button>
        </div>
      </CardContent>
    </>
  );
}
