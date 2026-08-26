"use client";

import * as React from "react";
import { Database, PlugZap } from "lucide-react";

import {
  ApiError,
  adminCreateNode,
  adminProbeNodeConnection,
  type NodeHealthResult,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";

import { ProbeResult, RegisteredView } from "./node-result";
import { BlockingIssues, ErrorNote, StepNav } from "./wizard-ui";

/**
 * Step 5: register the machine that will actually run the game servers.
 *
 * Two phases in one step. First the connection details, with a probe that
 * answers "is the agent there?" before anything is written: a node saved
 * against a typo'd URL looks registered and fails at the first server. Then,
 * once the row exists, the follow-up work that makes the node usable at all,
 * which is the port pool.
 *
 * The optional shared database is disclosed behind a switch rather than shown
 * flat. Most first installs do not need one, and four more credentials fields
 * on the first node form is where operators give up. It is also no longer the
 * normal way to get one: the node page can create the database with one button
 * (see `docs/node-database.md`), so these fields are for adopting a MariaDB the
 * panel did not create.
 */

export interface RegisteredNode {
  id: string;
  name: string;
  health: NodeHealthResult;
  hasPortPool: boolean;
}

export function NodeStep({
  onRegistered,
  onContinue,
  onSkip,
  onBack,
  registered,
}: {
  onRegistered: (node: RegisteredNode) => void;
  onContinue: () => void;
  onSkip: () => void;
  onBack: () => void;
  /** Set once a node exists, so returning to this step shows the result, not a blank form. */
  registered: RegisteredNode | null;
}) {
  const [name, setName] = React.useState("");
  const [hostname, setHostname] = React.useState("");
  const [apiUrl, setApiUrl] = React.useState("");
  const [token, setToken] = React.useState("");
  const [diskGb, setDiskGb] = React.useState("100");

  const [enableDb, setEnableDb] = React.useState(false);
  const [dbHost, setDbHost] = React.useState("");
  const [dbPort, setDbPort] = React.useState("3306");
  const [dbUser, setDbUser] = React.useState("root");
  const [dbPassword, setDbPassword] = React.useState("");

  const [probing, setProbing] = React.useState(false);
  const [probe, setProbe] = React.useState<NodeHealthResult | null>(null);
  const [probeError, setProbeError] = React.useState<string | null>(null);

  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [generatedToken, setGeneratedToken] = React.useState<string | null>(null);

  const issues: string[] = [];
  if (name.trim() === "") issues.push("Give the node a display name.");
  if (hostname.trim() === "") issues.push("Add the hostname players connect to.");
  if (!/^https?:\/\/.+/.test(apiUrl.trim())) {
    issues.push("Add the agent URL, starting with http:// or https://.");
  }
  if (token.trim() !== "" && token.trim().length < 32) {
    issues.push("The agent token must be at least 32 characters.");
  }
  if (!(Number(diskGb) >= 1)) issues.push("Set the disk capacity in GB.");
  if (enableDb) {
    if (dbHost.trim() === "") issues.push("Add the database host.");
    if (dbUser.trim() === "") issues.push("Add the database admin user.");
    if (dbPassword === "") issues.push("Add the database admin password.");
  }

  // A probe needs a token to authenticate with, so it is only offered once one
  // has been typed. The generate-for-me path cannot be pre-tested by design.
  const canProbe = /^https?:\/\/.+/.test(apiUrl.trim()) && token.trim().length >= 32;

  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    setProbeError(null);
    try {
      const health = await adminProbeNodeConnection({
        apiUrl: apiUrl.trim(),
        token: token.trim(),
      });
      setProbe(health);
    } catch (err) {
      setProbeError(
        err instanceof ApiError
          ? err.message
          : "The panel could not run the connection test.",
      );
    } finally {
      setProbing(false);
    }
  };

  const register = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await adminCreateNode({
        name: name.trim(),
        hostname: hostname.trim(),
        apiUrl: apiUrl.trim(),
        token: token.trim() || undefined,
        // The form asks for GB, the friendlier unit. CPU and memory are omitted
        // on purpose: the backend probes them from the agent when reachable and
        // falls back to defaults when it is not, so an offline node registers.
        diskTotalMb: Math.round(Number(diskGb) * 1024),
        ...(enableDb
          ? {
              dbAdminHost: dbHost.trim(),
              dbAdminPort: Number(dbPort) || 3306,
              dbAdminUser: dbUser.trim(),
              dbAdminPassword: dbPassword,
            }
          : {}),
      });
      if (response.token) setGeneratedToken(response.token);
      onRegistered({
        id: response.node.id,
        name: response.node.name,
        health: response.health,
        hasPortPool: false,
      });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "The node could not be registered. Check the details above and try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  if (registered) {
    return (
      <RegisteredView
        node={registered}
        generatedToken={generatedToken}
        onPoolChange={(entries) =>
          onRegistered({ ...registered, hasPortPool: entries.length > 0 })
        }
        onContinue={onContinue}
      />
    );
  }

  return (
    <>
      <CardHeader>
        <CardTitle>Add your first node</CardTitle>
        <CardDescription>
          A node is a machine running the CitadelPanel agent next to Docker. It
          is where game servers actually run. You need one before you can
          provision anything, but you can add it later.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="node-name">Display name</FieldLabel>
            <Input
              id="node-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Aurora 1"
              maxLength={64}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="node-hostname">Hostname</FieldLabel>
            <Input
              id="node-hostname"
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="aurora1.example.com"
              maxLength={255}
            />
            <FieldDescription>
              The address players connect to, not the agent.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="node-api-url">Agent URL</FieldLabel>
            <Input
              id="node-api-url"
              value={apiUrl}
              onChange={(e) => {
                setApiUrl(e.target.value);
                setProbe(null);
                setProbeError(null);
              }}
              placeholder="https://10.0.1.20:8081"
              maxLength={512}
            />
            <FieldDescription>
              Where the node agent listens. Keep it on a private network or
              behind TLS: the token below is root-equivalent for that machine.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="node-token">Agent token</FieldLabel>
            <Input
              id="node-token"
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setProbe(null);
                setProbeError(null);
              }}
              placeholder="Leave blank to generate one"
              autoComplete="off"
              maxLength={512}
            />
            <FieldDescription>
              The agent&apos;s <code className="text-foreground">AGENT_TOKEN</code>.
              Paste the one already set on the node to test the connection now,
              or leave blank to have one generated and shown once.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="node-disk">Disk capacity (GB)</FieldLabel>
            <Input
              id="node-disk"
              type="number"
              min={1}
              value={diskGb}
              onChange={(e) => setDiskGb(e.target.value)}
            />
            <FieldDescription>
              How much of the node&apos;s disk the panel may hand out. CPU and
              memory are read from the agent automatically when it responds.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <div className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <PlugZap className="size-4" />
                Test the connection
              </span>
              <span className="text-xs text-muted-foreground">
                {canProbe
                  ? "Checks the agent answers, and that Docker and its data root are usable."
                  : "Needs the agent URL and the token already set on that machine."}
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={runProbe}
              disabled={!canProbe || probing}
            >
              {probing && <Spinner />}
              Test
            </Button>
          </div>

          {probe && <ProbeResult health={probe} onRetry={runProbe} retrying={probing} />}
          {probeError && (
            <ErrorNote title="The test could not run" onRetry={runProbe} retrying={probing}>
              {probeError}
            </ErrorNote>
          )}
        </div>

        <Separator />

        <Field orientation="horizontal">
          <div className="flex flex-1 flex-col gap-0.5">
            <FieldLabel htmlFor="node-enable-db" className="flex items-center gap-1.5">
              <Database className="size-4" />
              Shared database server on this node
            </FieldLabel>
            <FieldDescription>
              Optional, and only for a database this panel did not create. To
              give the node one, skip this and use <em>Set up database</em> on the
              node&apos;s page afterwards: the agent creates the container and the
              panel keeps the credentials.
            </FieldDescription>
          </div>
          <Switch
            id="node-enable-db"
            checked={enableDb}
            onCheckedChange={setEnableDb}
          />
        </Field>

        {enableDb && (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="node-db-host">Database host</FieldLabel>
              <Input
                id="node-db-host"
                value={dbHost}
                onChange={(e) => setDbHost(e.target.value)}
                placeholder="172.18.0.2"
              />
              <FieldDescription>
                The address the node reaches its database server on, from the
                setup script&apos;s output.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="node-db-port">Port</FieldLabel>
              <Input
                id="node-db-port"
                type="number"
                value={dbPort}
                onChange={(e) => setDbPort(e.target.value)}
                placeholder="3306"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="node-db-user">Admin user</FieldLabel>
              <Input
                id="node-db-user"
                value={dbUser}
                onChange={(e) => setDbUser(e.target.value)}
                placeholder="root"
                autoComplete="off"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="node-db-password">Admin password</FieldLabel>
              <Input
                id="node-db-password"
                type="password"
                value={dbPassword}
                onChange={(e) => setDbPassword(e.target.value)}
                autoComplete="off"
              />
              <FieldDescription>
                Stored encrypted. Used only to create per-server databases and
                their scoped users.
              </FieldDescription>
            </Field>
          </FieldGroup>
        )}

        {error && (
          <ErrorNote title="Could not register the node" onRetry={register} retrying={saving}>
            {error}
          </ErrorNote>
        )}
        <BlockingIssues issues={issues} />

        <StepNav
          onBack={onBack}
          onNext={register}
          loading={saving}
          nextDisabled={issues.length > 0}
          nextLabel="Register node"
          onSkip={onSkip}
          skipLabel="I'll add a node later"
        />
      </CardContent>
    </>
  );
}
