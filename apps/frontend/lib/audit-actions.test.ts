/**
 * Unit tests for the audit-log detail renderer, focused on the subuser
 * actions: the invitee's email is the headline, permission flags follow it,
 * and rows recorded before the email was denormalized still render.
 */

import { test, expect } from "bun:test";
import { describeMetadata } from "./audit-actions";

test("subuser.invite shows the email followed by the granted flags", () => {
  expect(
    describeMetadata("subuser.invite", {
      subuserId: "11111111-2222-3333-4444-555555555555",
      subuserEmail: "alice@example.com",
      permissions: { console: true, files: true, settings: false },
    }),
  ).toBe("alice@example.com · console, files");
});

test("subuser.remove shows the email alone (no permission set recorded)", () => {
  expect(
    describeMetadata("subuser.remove", {
      subuserId: "11111111-2222-3333-4444-555555555555",
      subuserEmail: "alice@example.com",
    }),
  ).toBe("alice@example.com");
});

test("subuser.update with every flag revoked shows just the email", () => {
  expect(
    describeMetadata("subuser.update", {
      subuserId: "11111111-2222-3333-4444-555555555555",
      subuserEmail: "alice@example.com",
      permissions: { console: false },
    }),
  ).toBe("alice@example.com");
});

test("legacy subuser rows without an email fall back to flags", () => {
  expect(
    describeMetadata("subuser.invite", {
      subuserId: "11111111-2222-3333-4444-555555555555",
      permissions: { console: true },
    }),
  ).toBe("console");
});

test("a subuser row with neither email nor flags renders no detail", () => {
  expect(describeMetadata("subuser.remove", {})).toBeNull();
});

test("server.reinstall says the files went, and what replaced them", () => {
  expect(
    describeMetadata("server.reinstall", {
      blueprintKey: "minecraft-java",
      nodeId: "11111111-2222-3333-4444-555555555555",
    }),
  ).toBe("all files deleted · reinstalled from minecraft-java");
});

test("server.reinstall without a blueprint still records the deletion", () => {
  expect(describeMetadata("server.reinstall", {})).toBe("all files deleted");
});

test("server.file.delete renders a batch as a comma-separated path list", () => {
  expect(
    describeMetadata("server.file.delete", {
      paths: ["/plugins/old.jar", "/logs/latest.log"],
    }),
  ).toBe("/plugins/old.jar, /logs/latest.log");
});

test("legacy single-path delete rows still render", () => {
  expect(
    describeMetadata("server.file.delete", { path: "/server.properties" }),
  ).toBe("/server.properties");
});

test("server.port.add shows the published port with its protocol", () => {
  expect(
    describeMetadata("server.port.add", { port: 25566, protocol: "tcp" }),
  ).toBe("25566 tcp");
});

test("legacy split host→container port rows fall back to the host side", () => {
  expect(
    describeMetadata("server.port.add", {
      hostPort: 25570,
      containerPort: 25565,
      protocol: "tcp",
    }),
  ).toBe("25570 tcp");
});
