"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConnectedServersCard } from "@/components/server/connected-servers-card";
import { ReinstallServerCard } from "@/components/server/reinstall-server-card";
import { useServerData } from "@/components/server/server-data-context";
import {
  ApiError,
  getServerEnv,
  updateServerEnv,
  type ServerEnvVar,
} from "@/lib/api";

/** One read-only allocation row. */
function Allocation({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Per-server settings, split into sub-tabs so the long env-var list no longer
 * towers over the rest of the page.
 *
 * The permission model (plan.md section 5) shapes this page: an owner manages
 * their server but never sizes it. Resource limits stay admin-only and are not
 * shown here. There is no owner-facing API to change them, and showing inputs
 * would promise something the backend would refuse. Environment variables the
 * blueprint marks `editable` are the one exception: the owner (and subusers with
 * `settings`) may override those after creation.
 *
 * Reinstalling is the one destructive action on this page, and it sits at the
 * bottom of General rather than in a tab of its own. A tab would be a place to
 * arrive at, and this is a thing to scroll past. It renders for owners and
 * admins only, so a subuser with `settings` can retune the game without being
 * able to erase it.
 *
 * Panels stay mounted (Base UI default), so the env and links fetches fire on
 * mount exactly as they did when everything was on one page.
 */
export function SettingsTab() {
  const { server } = useServerData();

  return (
    <Tabs defaultValue="general">
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="environment">Environment</TabsTrigger>
        <TabsTrigger value="connections">Connections</TabsTrigger>
      </TabsList>
      <TabsContent value="general" className="mt-4 flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>General</CardTitle>
            <CardDescription>Server identity.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Allocation label="Name" value={server.name} />
            <Allocation label="Game" value={server.blueprintKey} />
            <Allocation
              label="Primary port"
              value={server.primaryPort > 0 ? String(server.primaryPort) : "None"}
            />
          </CardContent>
        </Card>
        {/* Last on the page, and owner-only: it hides itself for subusers. */}
        <ReinstallServerCard />
      </TabsContent>
      <TabsContent value="environment" className="mt-4">
        <EnvironmentCard serverId={server.id} />
      </TabsContent>
      <TabsContent value="connections" className="mt-4">
        <ConnectedServersCard />
      </TabsContent>
    </Tabs>
  );
}

/** One env var as an editable row: schema metadata plus value and handlers. */
interface EnvVarRowProps {
  fieldKey: string;
  value: string;
  isSecret: boolean;
  description: string | null;
  options: string[] | null;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onValueChange: (value: string) => void;
}

/** One env var: mono key and hint on the left, the control on the right. */
function EnvVarRow({
  fieldKey,
  value,
  isSecret,
  description,
  options,
  onChange,
  onValueChange,
}: EnvVarRowProps) {
  const [revealed, setRevealed] = React.useState(false);

  return (
    <div className="flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={`env-${fieldKey}`} className="font-mono text-xs font-medium">
          {fieldKey}
        </label>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>

      {options ? (
        <Select
          value={value}
          onValueChange={(v) => {
            if (v) onValueChange(v);
          }}
        >
          <SelectTrigger id={`env-${fieldKey}`} className="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="relative w-full shrink-0 sm:w-72">
          <Input
            id={`env-${fieldKey}`}
            className={isSecret && !revealed ? "pr-10" : undefined}
            type={isSecret && !revealed ? "password" : "text"}
            value={value}
            onChange={onChange}
          />
          {isSecret && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              aria-label={revealed ? `Hide ${fieldKey}` : `Show ${fieldKey}`}
              onClick={() => setRevealed((prev) => !prev)}
            >
              {revealed ? <EyeOff /> : <Eye />}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The editable environment variables card.
 *
 * Loads the server's editable env (the backend returns only keys the blueprint
 * marks `editable`, with secret values masked). The owner edits in place and
 * saves only the keys that changed; the backend rejects anything not marked
 * editable, and changes take effect on the next restart.
 */
function EnvironmentCard({ serverId }: { serverId: string }) {
  const [vars, setVars] = React.useState<ServerEnvVar[] | null>(null);
  const [denied, setDenied] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [edits, setEdits] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const env = await getServerEnv(serverId);
      setVars(env);
      setEdits({});
      setNote(null);
    } catch (err) {
      // 403 means the caller lacks `settings`, so hide the card rather than
      // show an error. Anything else is a real failure worth surfacing.
      if (err instanceof ApiError && err.status === 403) {
        setDenied(true);
      } else {
        setError(
          err instanceof ApiError ? err.message : "Failed to load environment.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A secret field arrives masked ("********"). Typing into it replaces the
  // whole value, so we track it as an edit against the masked sentinel.
  const changedKeys = Object.keys(edits).filter((key) => {
    const original = vars?.find((v) => v.key === key);
    return original ? edits[key] !== original.value : false;
  });
  const hasChanges = changedKeys.length > 0;

  const save = async () => {
    if (!hasChanges) return;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const updates: Record<string, string> = {};
      for (const key of changedKeys) updates[key] = edits[key]!;
      const result = await updateServerEnv(serverId, updates);
      setVars(result.env);
      setEdits({});
      setNote(result.note);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "Failed to save environment.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (denied) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Environment</CardTitle>
        <CardDescription>
          Game settings the blueprint exposes for this server. Changes apply on
          the next restart.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Spinner />
          </div>
        ) : vars === null ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : vars.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This game has no user-configurable environment variables.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {vars.map((field) => (
                <EnvVarRow
                  key={field.key}
                  fieldKey={field.key}
                  value={edits[field.key] ?? field.value}
                  isSecret={field.isSecret}
                  description={field.description}
                  options={field.options}
                  onChange={(e) =>
                    setEdits((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  onValueChange={(value) => {
                    setEdits((prev) => ({ ...prev, [field.key]: value }));
                  }}
                />
              ))}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
            {note && (
              <p className="text-sm text-muted-foreground">{note}</p>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={!hasChanges || saving}
                onClick={load}
              >
                Reset
              </Button>
              <Button
                type="button"
                disabled={!hasChanges || saving}
                onClick={save}
              >
                {saving && <Spinner />}
                Save changes
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
