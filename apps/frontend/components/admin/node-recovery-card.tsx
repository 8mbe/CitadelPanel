"use client";

import * as React from "react";
import { RotateCw, TriangleAlert } from "lucide-react";

import { adminRecoverNode, ApiError, type NodeRecoveryResult } from "@/lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export function NodeRecoverySummary({
  recovery,
  className,
}: {
  recovery: NodeRecoveryResult;
  className?: string;
}) {
  return (
    <div data-slot="node-recovery-summary" className={cn("flex flex-col gap-3", className)}>
      <Alert>
        <AlertTitle>
          {recovery.warning ? "Server recovery needs attention" : "Server scan complete"}
        </AlertTitle>
        <AlertDescription>
          Found {recovery.discovered} server{recovery.discovered === 1 ? "" : "s"}.
          {" "}{recovery.restored} restored to this panel, {recovery.existing} already registered.
          {recovery.warning && <p className="mt-2">{recovery.warning}</p>}
        </AlertDescription>
      </Alert>
      {recovery.skipped.length > 0 && (
        <Alert>
          <TriangleAlert className="size-4" />
          <AlertTitle>
            {recovery.skipped.length} server{recovery.skipped.length === 1 ? "" : "s"} could not be restored
          </AlertTitle>
          <AlertDescription>
            <ul className="mt-1 flex max-h-48 flex-col gap-2 overflow-y-auto">
              {recovery.skipped.map((server, index) => (
                <li key={`${server.serverId}-${index}`} className="flex flex-col gap-0.5">
                  <code className="break-all text-xs text-foreground">{server.serverId}</code>
                  <span>{server.reason}</span>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

export function NodeRecoveryCard({
  nodeId,
  onChanged,
  className,
}: {
  nodeId: string;
  onChanged: () => void | Promise<void>;
  className?: string;
}) {
  const [scanning, setScanning] = React.useState(false);
  const [result, setResult] = React.useState<NodeRecoveryResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const scan = async () => {
    setScanning(true);
    setError(null);
    setResult(null);
    try {
      const recovery = await adminRecoverNode(nodeId);
      setResult(recovery);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not scan this node for servers.");
    } finally {
      setScanning(false);
    }
  };

  return (
    <Card data-slot="node-recovery-card" className={cn(className)}>
      <CardHeader>
        <CardTitle>Recover existing servers</CardTitle>
        <CardDescription>
          The agent keeps a record of its servers on the node. Scan it to restore
          missing panel records. Servers whose owners cannot be verified are assigned to you.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Registration runs this scan automatically. Run it again after restoring
          panel accounts or reconnecting the agent. Existing server records are kept.
        </p>
        {result && <NodeRecoverySummary recovery={result} />}
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Server scan failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={scan} disabled={scanning}>
          {scanning ? <Spinner data-icon="inline-start" /> : <RotateCw data-icon="inline-start" className="size-4" />}
          {scanning ? "Scanning node…" : "Scan for servers"}
        </Button>
      </CardFooter>
    </Card>
  );
}
