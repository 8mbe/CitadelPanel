/**
 * Docker socket diagnosis tests.
 *
 * The failure these cover is the one that actually happened on a dev host: the
 * agent's user had been added to the `docker` group, but the shell the agent was
 * launched from predated the change, so every Docker call failed with a bare
 * `connect EACCES /var/run/docker.sock` and the stack trace named dockerode
 * rather than the fix. What matters is that the message distinguishes "not in
 * the group" from "in the group and still refused", and that it says a *new
 * login session* is what applies the membership.
 *
 * Only the explanation is unit-tested: `probeDockerSocket` needs a real daemon
 * to say anything meaningful, and mocking dockerode would only assert that the
 * two functions are wired together.
 */

import { describe, expect, test } from "bun:test";

process.env.AGENT_TOKEN ??= "test-agent-token-that-is-long-enough-0123456789";

const { explainDockerSocketError, readSocketContext } = await import("./socket");

const SOCKET = "/var/run/docker.sock";

/** A process that is not in the socket's group. */
const outsider = {
  uid: 1000,
  groups: [1000, 998],
  socketGid: 955,
  socketGroupName: "docker",
};

describe("explainDockerSocketError", () => {
  test("names the missing group and the groups the process actually has", () => {
    const message = explainDockerSocketError({ code: "EACCES" }, SOCKET, outsider);

    expect(message).toContain("uid 1000");
    expect(message).toContain("group docker (gid 955)");
    expect(message).toContain("1000, 998");
    expect(message).toContain("usermod -aG docker");
  });

  test("says a new login session is what applies the membership", () => {
    const message = explainDockerSocketError({ code: "EACCES" }, SOCKET, outsider);

    // The whole point: `usermod` alone leaves a running agent, and any shell
    // opened before it, with the old group set.
    expect(message).toContain("NEW login session");
    expect(message).toContain("setfacl");
  });

  test("EPERM is treated as EACCES", () => {
    expect(explainDockerSocketError({ code: "EPERM" }, SOCKET, outsider)).toContain(
      "usermod -aG docker",
    );
  });

  test("blames policy, not membership, when the process is already in the group", () => {
    const message = explainDockerSocketError({ code: "EACCES" }, SOCKET, {
      uid: 1000,
      groups: [1000, 955],
      socketGid: 955,
      socketGroupName: "docker",
    });

    expect(message).toContain("AppArmor/SELinux");
    expect(message).not.toContain("do not include it");
  });

  test("falls back to the numeric gid when the group has no name", () => {
    const message = explainDockerSocketError({ code: "EACCES" }, SOCKET, {
      uid: 0,
      groups: [0],
      socketGid: 955,
    });

    expect(message).toContain("group 955 (gid 955)");
  });

  test("a missing socket points at the daemon and DOCKER_SOCKET, not at permissions", () => {
    const message = explainDockerSocketError({ code: "ENOENT" }, SOCKET, {
      uid: 1000,
      groups: [1000],
    });

    expect(message).toContain("does not exist");
    expect(message).toContain("DOCKER_SOCKET");
    expect(message).not.toContain("usermod");
  });

  test("a refused connection is a stopped daemon", () => {
    const message = explainDockerSocketError({ code: "ECONNREFUSED" }, SOCKET, {
      uid: 1000,
      groups: [1000],
    });

    expect(message).toContain("not");
    expect(message).toContain("systemctl start docker");
  });

  test("an unknown error still carries the path and the original message", () => {
    const message = explainDockerSocketError(
      { code: "EPROTO", message: "bad handshake" },
      SOCKET,
      { uid: 1000, groups: [1000] },
    );

    expect(message).toContain(SOCKET);
    expect(message).toContain("bad handshake");
  });
});

describe("readSocketContext", () => {
  test("reports this process's own credentials", async () => {
    const context = await readSocketContext(SOCKET);

    expect(context.uid).toBe(process.getuid?.() ?? 0);
    expect(context.groups).toEqual(process.getgroups?.() ?? []);
  });

  test("leaves the socket ownership unset when the path does not exist", async () => {
    const context = await readSocketContext("/var/run/citadel-no-such.sock");

    expect(context.socketGid).toBeUndefined();
    expect(context.socketGroupName).toBeUndefined();
  });
});
