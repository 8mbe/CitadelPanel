"use client";

import * as React from "react";
import { Plus, ShieldAlert, Trash2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  adminCreateBlueprint,
  adminGetBlueprint,
  adminUpdateBlueprint,
  ApiError,
  type BlueprintResourceProfile,
} from "@/lib/api";
import {
  detailToForm,
  emptyForm,
  formToPayload,
  MODRINTH_PROVIDER_SPEC,
  type EnvRow,
  type FormValues,
  type PluginProfileRow,
  type PortRow,
} from "@/lib/blueprint-io";

type Mode = "create" | "edit" | "duplicate";

export function BlueprintFormDialog({
  mode,
  blueprintId,
  initialValues,
  open,
  onOpenChange,
  onSaved,
}: {
  mode: Mode;
  blueprintId?: string;
  /** Prefilled form for a create-from-import review. Ignored for edit. */
  initialValues?: FormValues;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [values, setValues] = React.useState<FormValues>(
    () => initialValues ?? emptyForm(),
  );
  const [loading, setLoading] = React.useState(mode !== "create");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The key is fixed once a blueprint exists; edits keep it, duplicates get a
  // fresh one the admin must supply.
  const keyEditable = mode !== "edit";

  React.useEffect(() => {
    if (mode === "create" || !blueprintId) {
      setValues(initialValues ?? emptyForm());
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const detail = await adminGetBlueprint(blueprintId);
        if (cancelled) return;
        const loaded = detailToForm(detail);
        if (mode === "duplicate") {
          // A duplicate is a brand-new blueprint: clear the (immutable) key and
          // mark the name so the admin sees which one it came from.
          loaded.key = "";
          loaded.name = `${detail.name} (copy)`;
        }
        setValues(loaded);
        setError(null);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Failed to load blueprint.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, blueprintId, initialValues]);

  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  // --- Ports ------------------------------------------------------------------
  const addPort = () =>
    setValues((prev) => ({
      ...prev,
      ports: [...prev.ports, { container: "", primary: false }],
    }));

  const removePort = (index: number) =>
    setValues((prev) => {
      const ports = prev.ports.filter((_, i) => i !== index);
      // Never leave zero ports or an orphaned primary flag.
      if (ports.length > 0 && !ports.some((p) => p.primary)) ports[0]!.primary = true;
      return { ...prev, ports };
    });

  const updatePort = (index: number, patch: Partial<PortRow>) =>
    setValues((prev) => ({
      ...prev,
      ports: prev.ports.map((port, i) => (i === index ? { ...port, ...patch } : port)),
    }));

  const setPrimaryPort = (index: number) =>
    setValues((prev) => ({
      ...prev,
      ports: prev.ports.map((port, i) => ({ ...port, primary: i === index })),
    }));

  // --- Env --------------------------------------------------------------------
  const addEnv = () =>
    setValues((prev) => ({
      ...prev,
      env: [
        ...prev.env,
        { key: "", required: false, secret: false, editable: false, default: "", description: "", options: "" },
      ],
    }));

  const removeEnv = (index: number) =>
    setValues((prev) => ({ ...prev, env: prev.env.filter((_, i) => i !== index) }));

  const updateEnv = (index: number, patch: Partial<EnvRow>) =>
    setValues((prev) => ({
      ...prev,
      env: prev.env.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }));

  // --- Plugins -----------------------------------------------------------------
  // Non-secret env keys are candidates for both the profile selector and the
  // game-version pointer; secret values must never steer plugin resolution.
  const envKeys = values.env
    .map((row) => row.key.trim())
    .filter((key) => key.length > 0);

  const setPluginProfile = (index: number, patch: Partial<PluginProfileRow>) =>
    setValues((prev) => ({
      ...prev,
      pluginProfiles: prev.pluginProfiles.map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }));

  // When the profile-selecting env field changes (or its options do), rebuild
  // the profile rows from that field's allowed values. Edits to a row whose
  // value still exists are kept, vanished values are dropped. Values that
  // can't load plugins (e.g. VANILLA) simply stay disabled.
  React.useEffect(() => {
    const field = values.pluginEnvField;
    if (!field) return;
    setValues((prev) => {
      const envRow = prev.env.find(
        (r) => r.key.trim() === field && !r.secret,
      );
      const options = envRow
        ? envRow.options
            .split(",")
            .map((o) => o.trim())
            .filter((o) => o.length > 0)
        : [];
      if (options.length === 0) return prev;
      const byValue = new Map(
        prev.pluginProfiles
          .filter((r) => r.envValue)
          .map((r) => [r.envValue, r] as const),
      );
      return {
        ...prev,
        pluginProfiles: options.map(
          (envValue) =>
            byValue.get(envValue) ?? {
              enabled: false,
              envValue,
              label: "",
              directory: "",
              projectType: "plugin" as const,
              loaders: "",
              gameVersionEnv: "",
            },
        ),
      };
    });
    // Deliberately not watching values.env: option edits shouldn't clobber
    // profile rows on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values.pluginEnvField]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const payload = formToPayload(values);
      if (mode === "edit" && blueprintId) {
        await adminUpdateBlueprint(blueprintId, payload);
      } else {
        await adminCreateBlueprint(payload);
      }
      onSaved();
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Failed to save blueprint.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const title =
    mode === "edit"
      ? "Edit blueprint"
      : mode === "duplicate"
        ? "Duplicate blueprint"
        : "New blueprint";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            A blueprint defines how a server is built and run: image, ports,
            environment, and an optional first-launch install script.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Spinner />
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-6">
            {/* Identity ------------------------------------------------------ */}
            <FieldGroup>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="bp-name">Name</FieldLabel>
                  <Input
                    id="bp-name"
                    required
                    maxLength={128}
                    placeholder="Valheim Dedicated"
                    value={values.name}
                    onChange={(e) => set("name", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="bp-key">Key</FieldLabel>
                  <Input
                    id="bp-key"
                    required
                    maxLength={63}
                    placeholder="valheim"
                    value={values.key}
                    disabled={!keyEditable}
                    onChange={(e) => set("key", e.target.value)}
                  />
                  <FieldDescription>
                    {keyEditable
                      ? "Lowercase letters, digits and dashes. Cannot change later."
                      : "The key is fixed once a blueprint exists."}
                  </FieldDescription>
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="bp-description">Description</FieldLabel>
                <Input
                  id="bp-description"
                  maxLength={1024}
                  placeholder="Short summary shown when provisioning."
                  value={values.description}
                  onChange={(e) => set("description", e.target.value)}
                />
              </Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="bp-image">Runtime image</FieldLabel>
                  <Input
                    id="bp-image"
                    required
                    placeholder="itzg/minecraft-server:latest"
                    value={values.dockerImage}
                    onChange={(e) => set("dockerImage", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="bp-datapath">Data path</FieldLabel>
                  <Input
                    id="bp-datapath"
                    required
                    placeholder="/data"
                    value={values.dataPath}
                    onChange={(e) => set("dataPath", e.target.value)}
                  />
                  <FieldDescription>Where the server keeps its files.</FieldDescription>
                </Field>
              </div>
            </FieldGroup>

            {/* Ports --------------------------------------------------------- */}
            <FieldSet>
              <FieldLegend>Ports</FieldLegend>
              <FieldDescription>
                The game&apos;s preferred ports. They come from the node&apos;s
                port pool when free, otherwise a random free pool port is
                drawn. Each is published as the same number inside and outside
                the container, on TCP and UDP both. Exactly one is the primary
                (player-facing) port.
              </FieldDescription>
              <div className="flex flex-col gap-2">
                {values.ports.map((port, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      required
                      placeholder="25565"
                      className="w-28"
                      value={port.container}
                      onChange={(e) => updatePort(i, { container: e.target.value })}
                      aria-label={`Port ${i + 1}`}
                    />
                    <span className="text-xs text-muted-foreground">TCP + UDP</span>
                    <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                      <input
                        type="radio"
                        name="bp-primary-port"
                        checked={port.primary}
                        onChange={() => setPrimaryPort(i)}
                      />
                      Primary
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto"
                      disabled={values.ports.length === 1}
                      onClick={() => removePort(i)}
                      aria-label={`Remove port ${i + 1}`}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addPort}>
                <Plus />
                Add port
              </Button>
            </FieldSet>

            {/* Environment --------------------------------------------------- */}
            <FieldSet>
              <FieldLegend>Environment variables</FieldLegend>
              <FieldDescription>
                Define every variable the server may receive. Only keys marked
                Editable can be changed by the server owner after creation; the
                rest are locked to the default. Unknown keys are never passed to
                the container.
              </FieldDescription>
              <div className="flex flex-col gap-3">
                {values.env.map((row, i) => (
                  <div key={i} className="rounded-lg border p-3">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="KEY"
                        className="w-40 font-mono"
                        value={row.key}
                        onChange={(e) => updateEnv(i, { key: e.target.value })}
                        aria-label={`Variable ${i + 1} name`}
                      />
                      <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Switch
                          checked={row.required}
                          onCheckedChange={(checked) => updateEnv(i, { required: checked })}
                        />
                        Required
                      </label>
                      <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Switch
                          checked={row.secret}
                          onCheckedChange={(checked) => updateEnv(i, { secret: checked })}
                        />
                        Secret
                      </label>
                      <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Switch
                          checked={row.editable}
                          onCheckedChange={(checked) => updateEnv(i, { editable: checked })}
                        />
                        Editable
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="ml-auto"
                        onClick={() => removeEnv(i)}
                        aria-label={`Remove variable ${i + 1}`}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <Input
                        placeholder="Default value"
                        value={row.default}
                        onChange={(e) => updateEnv(i, { default: e.target.value })}
                        aria-label={`Variable ${i + 1} default`}
                      />
                      <Input
                        placeholder="Allowed values (comma-separated)"
                        value={row.options}
                        onChange={(e) => updateEnv(i, { options: e.target.value })}
                        aria-label={`Variable ${i + 1} options`}
                      />
                    </div>
                    <Input
                      className="mt-2"
                      placeholder="Description"
                      value={row.description}
                      onChange={(e) => updateEnv(i, { description: e.target.value })}
                      aria-label={`Variable ${i + 1} description`}
                    />
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addEnv}>
                <Plus />
                Add variable
              </Button>
            </FieldSet>

            {/* Launch -------------------------------------------------------- */}
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="bp-startup">Startup command</FieldLabel>
                <Input
                  id="bp-startup"
                  placeholder="Leave blank to use the image's own entrypoint"
                  value={values.startupCommand}
                  onChange={(e) => set("startupCommand", e.target.value)}
                />
                <FieldDescription>
                  {"{{VAR}}"} placeholders are filled from the resolved environment.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="bp-stop">Stop command</FieldLabel>
                <Input
                  id="bp-stop"
                  placeholder="e.g. stop"
                  value={values.stopCommand}
                  onChange={(e) => set("stopCommand", e.target.value)}
                />
                <FieldDescription>
                  Sent to the console for a graceful shutdown before SIGKILL.
                </FieldDescription>
              </Field>
            </FieldGroup>

            {/* Install ------------------------------------------------------- */}
            <FieldSet>
              <div className="flex items-center justify-between">
                <div>
                  <FieldLegend>First-launch install</FieldLegend>
                  <FieldDescription>
                    Runs once, before first start, in a throwaway container with
                    the data volume mounted.
                  </FieldDescription>
                </div>
                <Switch
                  checked={values.installEnabled}
                  onCheckedChange={(checked) => set("installEnabled", checked)}
                  aria-label="Enable install step"
                />
              </div>
              {values.installEnabled && (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="bp-install-image">Installer image</FieldLabel>
                    <Input
                      id="bp-install-image"
                      placeholder="alpine:latest"
                      value={values.installImage}
                      onChange={(e) => set("installImage", e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="bp-install-entrypoint">Entrypoint</FieldLabel>
                    <Input
                      id="bp-install-entrypoint"
                      placeholder="/bin/sh -c  (leave blank for default)"
                      value={values.installEntrypoint}
                      onChange={(e) => set("installEntrypoint", e.target.value)}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="bp-install-script">Install script</FieldLabel>
                    <Textarea
                      id="bp-install-script"
                      rows={6}
                      className="font-mono text-xs"
                      placeholder={"set -e\ncurl -fsSL https://… -o server.tar\ntar xf server.tar"}
                      value={values.installScript}
                      onChange={(e) => set("installScript", e.target.value)}
                    />
                  </Field>
                </FieldGroup>
              )}
            </FieldSet>

            {/* Plugins ------------------------------------------------------- */}
            <FieldSet>
              <div className="flex items-center justify-between">
                <div>
                  <FieldLegend>Plugins / mods</FieldLegend>
                  <FieldDescription>
                    Declares how the panel searches a catalog and installs
                    plugins into this blueprint&apos;s servers. Pure data. The
                    panel&apos;s fetch engine interprets it; hosts must be public
                    https and downloads are pinned to the declared hosts.
                  </FieldDescription>
                </div>
                <Switch
                  checked={values.pluginsEnabled}
                  onCheckedChange={(checked) => set("pluginsEnabled", checked)}
                  aria-label="Enable plugin support"
                />
              </div>
              {values.pluginsEnabled && (
                <FieldGroup>
                  <ProviderHostsNote specJson={values.pluginProviderSpec} />
                  <Field>
                    <FieldLabel htmlFor="bp-plugin-env">
                      Active profile follows env value
                    </FieldLabel>
                    <Select
                      value={values.pluginEnvField}
                      onValueChange={(v) => set("pluginEnvField", v ?? "")}
                    >
                      <SelectTrigger id="bp-plugin-env" className="w-full">
                        <SelectValue placeholder="One profile for all servers" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">One profile for all servers</SelectItem>
                        {envKeys.map((key) => (
                          <SelectItem key={key} value={key}>
                            {key}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      e.g. <span className="font-mono">TYPE</span>: one profile
                      per server software. Values without an enabled profile
                      (e.g. VANILLA) get no plugins tab.
                    </FieldDescription>
                  </Field>

                  <div className="flex flex-col gap-3">
                    {values.pluginEnvField === "" ? (
                      <PluginProfileCard
                        row={values.pluginProfiles.find((r) => r.envValue === "") ?? {
                          enabled: true,
                          envValue: "",
                          label: "",
                          directory: "",
                          projectType: "plugin",
                          loaders: "",
                          gameVersionEnv: "",
                        }}
                        envKeys={envKeys}
                        title="Profile"
                        onChange={(patch) => {
                          const index = values.pluginProfiles.findIndex(
                            (r) => r.envValue === "",
                          );
                          if (index === -1) {
                            setValues((prev) => ({
                              ...prev,
                              pluginProfiles: [
                                ...prev.pluginProfiles,
                                {
                                  enabled: true,
                                  envValue: "",
                                  label: "",
                                  directory: "",
                                  projectType: "plugin" as const,
                                  loaders: "",
                                  gameVersionEnv: "",
                                  ...patch,
                                },
                              ],
                            }));
                          } else {
                            setPluginProfile(index, patch);
                          }
                        }}
                      />
                    ) : (
                      values.pluginProfiles.map((row, index) => (
                        <PluginProfileCard
                          key={row.envValue}
                          row={row}
                          envKeys={envKeys}
                          title={row.envValue}
                          canDisable
                          onChange={(patch) => setPluginProfile(index, patch)}
                        />
                      ))
                    )}
                  </div>

                  <Field>
                    <div className="flex items-center justify-between">
                      <FieldLabel htmlFor="bp-plugin-provider">
                        Provider fetch spec (JSON)
                      </FieldLabel>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          set(
                            "pluginProviderSpec",
                            JSON.stringify(MODRINTH_PROVIDER_SPEC, null, 2),
                          )
                        }
                      >
                        Modrinth preset
                      </Button>
                    </div>
                    <Textarea
                      id="bp-plugin-provider"
                      rows={10}
                      className="font-mono text-xs"
                      placeholder='{"id": "modrinth", "baseUrl": "https://…", …}'
                      value={values.pluginProviderSpec}
                      onChange={(e) => set("pluginProviderSpec", e.target.value)}
                    />
                    <FieldDescription>
                      How to search the catalog, read its responses and where
                      files download from. Validated on save: https public
                      hosts, pinned download hosts, fixed{" "}
                      <span className="font-mono">{"{placeholders}"}</span>{" "}
                      only.
                    </FieldDescription>
                  </Field>
                </FieldGroup>
              )}
            </FieldSet>

            {/* Minimums ------------------------------------------------------ */}
            <FieldSet>
              <FieldLegend>Minimum resources</FieldLegend>
              <FieldDescription>
                Server creation is rejected below these.
              </FieldDescription>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor="bp-min-cpu">CPU (vCPU)</FieldLabel>
                  <Input
                    id="bp-min-cpu"
                    type="number"
                    step="0.1"
                    min={0.1}
                    max={64}
                    required
                    value={values.minCpu}
                    onChange={(e) => set("minCpu", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="bp-min-mem">Memory (MB)</FieldLabel>
                  <Input
                    id="bp-min-mem"
                    type="number"
                    min={128}
                    max={262_144}
                    required
                    value={values.minMemoryMb}
                    onChange={(e) => set("minMemoryMb", e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="bp-min-disk">Disk (MB)</FieldLabel>
                  <Input
                    id="bp-min-disk"
                    type="number"
                    min={256}
                    max={2_000_000}
                    required
                    value={values.minDiskMb}
                    onChange={(e) => set("minDiskMb", e.target.value)}
                  />
                </Field>
              </div>
            </FieldSet>

            {/* Advanced ------------------------------------------------------ */}
            <FieldSeparator />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="bp-profile">Resource profile</FieldLabel>
                <Select
                  value={values.resourceProfile}
                  onValueChange={(v) => {
                    if (v) set("resourceProfile", v as BlueprintResourceProfile);
                  }}
                >
                  <SelectTrigger id="bp-profile" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bursty">Bursty</SelectItem>
                    <SelectItem value="steady-low">Steady (low)</SelectItem>
                    <SelectItem value="steady-high">Steady (high)</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>Baseline for abuse heuristics.</FieldDescription>
              </Field>
              <Field orientation="horizontal">
                <Switch
                  id="bp-root"
                  checked={values.supportsReadonlyRoot}
                  onCheckedChange={(checked) => set("supportsReadonlyRoot", checked)}
                />
                <FieldLabel htmlFor="bp-root">Read-only root filesystem</FieldLabel>
              </Field>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting && <Spinner />}
                {mode === "edit" ? "Save changes" : "Create blueprint"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One install profile: where plugin files land and how the catalog is
 * filtered for it. With an env-driven setup each card is one allowed value of
 * the selecting env field (title = the value); disabled cards mean that value
 * gets no plugins tab.
 */
function PluginProfileCard({
  row,
  envKeys,
  title,
  canDisable,
  onChange,
}: {
  row: PluginProfileRow;
  envKeys: string[];
  title: string;
  canDisable?: boolean;
  onChange: (patch: Partial<PluginProfileRow>) => void;
}) {
  const enabled = row.enabled || !canDisable;
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-medium">{title}</span>
        {canDisable && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Supported
            <Switch
              checked={row.enabled}
              onCheckedChange={(checked) => onChange({ enabled: checked })}
              aria-label={`${title} supports plugins`}
            />
          </label>
        )}
      </div>
      {enabled && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`bp-plugin-label-${title}`}>Tab label</FieldLabel>
            <Input
              id={`bp-plugin-label-${title}`}
              maxLength={32}
              placeholder="Plugins"
              value={row.label}
              onChange={(e) => onChange({ label: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`bp-plugin-dir-${title}`}>Directory</FieldLabel>
            <Input
              id={`bp-plugin-dir-${title}`}
              maxLength={64}
              placeholder="plugins"
              value={row.directory}
              onChange={(e) => onChange({ directory: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`bp-plugin-type-${title}`}>Content type</FieldLabel>
            <Select
              value={row.projectType}
              onValueChange={(v) => {
                if (v) onChange({ projectType: v as PluginProfileRow["projectType"] });
              }}
            >
              <SelectTrigger id={`bp-plugin-type-${title}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="plugin">Plugins</SelectItem>
                <SelectItem value="mod">Mods</SelectItem>
                <SelectItem value="datapack">Datapacks</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`bp-plugin-loaders-${title}`}>Loaders</FieldLabel>
            <Input
              id={`bp-plugin-loaders-${title}`}
              placeholder="paper, spigot"
              value={row.loaders}
              onChange={(e) => onChange({ loaders: e.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`bp-plugin-version-${title}`}>
              Game version env
            </FieldLabel>
            <Select
              value={row.gameVersionEnv || "none"}
              onValueChange={(v) =>
                onChange({ gameVersionEnv: v === "none" ? "" : (v ?? "") })
              }
            >
              <SelectTrigger id={`bp-plugin-version-${title}`} className="w-full">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                {envKeys.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Env key holding the game version the user sets. A concrete value
              filters search and updates by compatibility; a sentinel like
              LATEST leaves them unfiltered and the plugins tab asks the user
              to set a version.
            </FieldDescription>
          </Field>
        </div>
      )}
    </div>
  );
}

/**
 * The review point for a shared blueprint's plugin section: the hosts the
 * panel (and this blueprint's auto-updater) will contact, stated plainly
 * before the blueprint is saved. Parsed best-effort from the spec textarea.
 * Invalid JSON is simply not summarized (save validates fully).
 */
function ProviderHostsNote({ specJson }: { specJson: string }) {
  let baseUrl: unknown;
  let downloadHosts: unknown;
  let id: unknown;
  try {
    const parsed = JSON.parse(specJson) as Record<string, unknown>;
    id = parsed.id;
    baseUrl = parsed.baseUrl;
    downloadHosts = parsed.downloadHosts;
  } catch {
    return null;
  }
  if (typeof baseUrl !== "string" || !Array.isArray(downloadHosts)) return null;

  return (
    <Alert>
      <ShieldAlert />
      <AlertTitle>Network access</AlertTitle>
      <AlertDescription>
        Servers on this blueprint will search and download plugins via{" "}
        <span className="font-mono">{String(baseUrl)}</span>
        {downloadHosts.length > 0 && (
          <>
            {" "}
            (files from{" "}
            <span className="font-mono">
              {downloadHosts.filter((h) => typeof h === "string").join(", ")}
            </span>
            )
          </>
        )}
        . When auto-update is on, new release versions are fetched from these
        hosts before every start, so make sure you trust{" "}
        {typeof id === "string" ? `"${id}"` : "this catalog"} before saving.
      </AlertDescription>
    </Alert>
  );
}
