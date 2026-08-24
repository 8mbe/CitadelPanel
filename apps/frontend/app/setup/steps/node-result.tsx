"use client";

import * as React from "react";
import { Check, ServerCog } from "lucide-react";

import type { NodeHealthResult } from "@/lib/api";
import { agentProblem } from "@/lib/node-health";
import type { NodePortPoolEntry } from "@/lib/types";
import {
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { NodePortPool } from "./node-ports";
import type { RegisteredNode } from "./node-step";
import {
  ErrorNote,
  GeneratedToken,
  StepNav,
  SuccessNote,
  WarningNote,
} from "./wizard-ui";

/**
 * What the node step shows once it has an answer: the connection test's verdict
 * before registration, and the follow-up work after it.
 *
 * Split out of `node-step.tsx` because the outcomes carry as much copy as the
 * form does. Every branch says what happened, why, and what the operator does
 * next, since "the agent did not answer" is useless on its own to someone who
 * has just installed one for the first time.
 */

/** The connection test's three outcomes, each with what to do about it. */
export function ProbeResult({
  health,
  onRetry,
  retrying,
}: {
  health: NodeHealthResult;
  onRetry: () => void;
  retrying: boolean;
}) {
  if (health.unauthorized) {
    return (
      <ErrorNote title="The agent rejected this token" onRetry={onRetry} retrying={retrying}>
        The machine answered, so the URL is right. The token does not match its{" "}
        <code className="text-foreground">AGENT_TOKEN</code>. Copy the value from
        the node&apos;s environment, or leave the field blank to have the panel
        generate one for you to set there.
      </ErrorNote>
    );
  }

  if (!health.reachable) {
    return (
      <ErrorNote title="No answer from the agent" onRetry={onRetry} retrying={retrying}>
        {health.error ?? "The agent did not respond."} Check the agent is
        running on that machine, that the URL and port are right, and that a
        firewall is not in the way.
      </ErrorNote>
    );
  }

  const problem = agentProblem(health);
  if (problem) return <WarningNote>{problem}</WarningNote>;

  return (
    <SuccessNote>
      Agent responded
      {health.dockerVersion ? ` (Docker ${health.dockerVersion})` : ""}
      {health.capacity
        ? `, ${health.capacity.ncpu} CPU and ${Math.round(health.capacity.memTotalMb / 1024)} GB memory detected`
        : ""}
      . Its Docker socket and data root are usable.
    </SuccessNote>
  );
}

/** After registration: the one-time token, any health caveat, and the port pool. */
export function RegisteredView({
  node,
  generatedToken,
  onPoolChange,
  onContinue,
}: {
  node: RegisteredNode;
  generatedToken: string | null;
  onPoolChange: (entries: NodePortPoolEntry[]) => void;
  onContinue: () => void;
}) {
  const problem = node.health.reachable ? agentProblem(node.health) : undefined;

  return (
    <>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Check className="size-5 text-primary" />
          {node.name} registered
        </CardTitle>
        <CardDescription>
          One thing left before it can host anything: a range of ports to hand
          out to servers.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {generatedToken && (
          <GeneratedToken token={generatedToken}>
            Copy this token now. It is stored encrypted and cannot be shown
            again. Set it as <code className="text-foreground">AGENT_TOKEN</code>{" "}
            on the node and restart its agent.
          </GeneratedToken>
        )}

        {!node.health.reachable && (
          <WarningNote>
            The node was saved, but its agent did not answer
            {node.health.error ? `: ${node.health.error}` : "."} Provisioning
            will fail until it does. Start the agent on that machine, then check
            it from <strong>Admin &rarr; Nodes</strong>.
          </WarningNote>
        )}
        {problem && <WarningNote>{problem}</WarningNote>}

        <div className="flex flex-col gap-3">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <ServerCog className="size-4" />
            Ports
          </span>
          <NodePortPool
            nodeId={node.id}
            agentReachable={node.health.reachable}
            onPoolChange={onPoolChange}
          />
        </div>

        <StepNav onNext={onContinue} nextLabel="Continue" />
      </CardContent>
    </>
  );
}
