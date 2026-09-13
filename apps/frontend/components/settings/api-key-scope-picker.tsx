"use client";

import * as React from "react";
import { ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  API_KEY_RESOURCES,
  SCOPE_ACTIONS,
  type ApiKeyResource,
  type ApiKeyScopes,
  type ScopeAction,
} from "@/lib/api-key-scopes";
import { cn } from "@/lib/utils";

/**
 * The scope picker for an API key (see docs/api-keys.md).
 *
 * A key is either unrestricted — it is simply its owner, which is what every
 * key was before scopes existed — or scoped to an explicit grant. That is the
 * top-level switch. Below it, each resource has the same two checkboxes, so the
 * three useful grants (read, write, both) fall out of the pair rather than
 * needing a third control: "write" is genuinely separate from "read" here and
 * does not imply it, which is what makes a write-only key (a webhook that only
 * ever issues commands) expressible.
 *
 * Admin resources are shown in their own group and labelled, because granting
 * one to a non-admin's key grants nothing: the panel still re-checks the role
 * on every request. The picker says so rather than hiding them, so an operator
 * reading a key's scopes sees the same list whoever owns it.
 */
export interface ApiKeyScopePickerProps {
  /** `null` is unrestricted; an object (even empty) is a scoped grant. */
  value: ApiKeyScopes | null;
  onChange: (scopes: ApiKeyScopes | null) => void;
  disabled?: boolean;
  className?: string;
}

export function ApiKeyScopePicker({
  value,
  onChange,
  disabled,
  className,
}: ApiKeyScopePickerProps) {
  const restricted = value !== null;
  // The last grant the operator built, kept so flipping "restrict" off and back
  // on does not silently discard it. Held in state and written only from event
  // handlers, never during render.
  const [draft, setDraft] = React.useState<ApiKeyScopes>(value ?? {});

  const toggle = (resource: ApiKeyResource, action: ScopeAction) => {
    const current = value ?? {};
    const granted = current[resource] ?? [];
    // Rebuilt from SCOPE_ACTIONS rather than appended to, so the stored order
    // is always read-then-write and two equal grants serialise identically.
    const next = granted.includes(action)
      ? granted.filter((a) => a !== action)
      : SCOPE_ACTIONS.filter((a) => a === action || granted.includes(a));

    const updated: ApiKeyScopes = { ...current };
    if (next.length === 0) delete updated[resource];
    else updated[resource] = next;

    setDraft(updated);
    onChange(updated);
  };

  const groups = [
    { admin: false, title: "Resources", resources: API_KEY_RESOURCES.filter((r) => !r.admin) },
    { admin: true, title: "Admin resources", resources: API_KEY_RESOURCES.filter((r) => r.admin) },
  ];

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <label className="flex items-start gap-3 rounded-lg border p-3">
        <Switch
          checked={restricted}
          disabled={disabled}
          onCheckedChange={(checked) => onChange(checked ? draft : null)}
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Restrict this key</span>
          <span className="text-xs text-muted-foreground">
            Off, the key can do everything its owner can. On, it can only reach
            the resources you tick below.
          </span>
        </span>
      </label>

      {restricted && (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.title} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {group.title}
                </span>
                {group.admin && (
                  <Badge variant="outline" className="gap-1 text-xs font-normal">
                    <ShieldAlert className="size-3" />
                    Only effective on an admin&apos;s key
                  </Badge>
                )}
              </div>

              <div className="overflow-hidden rounded-lg border">
                {group.resources.map((resource, index) => {
                  const granted = value?.[resource.id] ?? [];
                  return (
                    <div
                      key={resource.id}
                      className={cn(
                        "flex items-center justify-between gap-4 px-3 py-2",
                        index > 0 && "border-t",
                        granted.length > 0 && "bg-muted/40",
                      )}
                    >
                      <div className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium">{resource.label}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {resource.description}
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-3">
                        {SCOPE_ACTIONS.map((action) => (
                          <label
                            key={action}
                            className="flex cursor-pointer items-center gap-1.5 text-xs capitalize"
                          >
                            <Checkbox
                              checked={granted.includes(action)}
                              disabled={disabled}
                              onCheckedChange={() => toggle(resource.id, action)}
                              aria-label={`${resource.label}: ${action}`}
                            />
                            {action}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Whether a picker value is a grant the API will accept. */
export function isUsableScopeSelection(scopes: ApiKeyScopes | null): boolean {
  return scopes === null || Object.keys(scopes).length > 0;
}

/**
 * A key's grant, at a glance: one badge per granted resource with its actions,
 * or a single "Full access" badge for an unrestricted key.
 *
 * The unrestricted case is styled as the loud one on purpose. It is the wider
 * grant, and on a list of keys it is the row worth noticing.
 */
export function ApiKeyScopeSummary({
  scopes,
  className,
}: {
  scopes: ApiKeyScopes | null;
  className?: string;
}) {
  if (scopes === null) {
    return (
      <Badge variant="secondary" className={cn("gap-1", className)}>
        <ShieldAlert className="size-3" />
        Full access
      </Badge>
    );
  }

  const granted = API_KEY_RESOURCES.filter(
    (resource) => (scopes[resource.id]?.length ?? 0) > 0,
  );

  if (granted.length === 0) {
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        No access
      </span>
    );
  }

  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {granted.map((resource) => (
        <Badge
          key={resource.id}
          variant="outline"
          className="font-normal"
          title={resource.description}
        >
          {resource.label}
          <span className="ml-1 text-muted-foreground">
            {(scopes[resource.id] ?? []).join("/")}
          </span>
        </Badge>
      ))}
    </div>
  );
}
