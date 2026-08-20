/**
 * SSRF address-classifier tests.
 *
 * The pull-from-URL guard's job is to keep an owner-supplied URL from reaching
 * the node's own network. These cover the classifier that every host check and
 * redirect hop leans on — the network-dependent DNS/redirect paths are exercised
 * separately; here we pin the pure IP rules that decide "public or not".
 */

import { describe, expect, test } from "bun:test";

const { isPrivateAddress, isPrivateIpv4, isPrivateIpv6 } = await import("./ssrf");

describe("isPrivateIpv4", () => {
  test("blocks loopback, private, link-local, CGNAT, and reserved ranges", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
    ]) {
      expect(isPrivateIpv4(ip)).toBe(true);
    }
  });

  test("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
      expect(isPrivateIpv4(ip)).toBe(false);
    }
  });
});

describe("isPrivateIpv6", () => {
  test("blocks loopback, ULA, link-local, and IPv4-mapped internals", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateIpv6(ip)).toBe(true);
    }
  });

  test("allows a public IPv6 address", () => {
    expect(isPrivateIpv6("2606:4700:4700::1111")).toBe(false);
  });
});

describe("isPrivateAddress", () => {
  test("dispatches on family and ignores non-IP input", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(false);
  });
});
