/**
 * Transfer tests: the two halves of a node-to-node move.
 *
 * The properties worth pinning are the ones a migration's safety rests on:
 * an export must be a faithful copy of the directory (a truncated world that
 * extracts cleanly is the worst possible outcome), an import must refuse to
 * land on top of existing data rather than merge two servers, and both must
 * stay inside the containment boundary `paths.ts` draws.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = (await import("../test-setup")).testRoot;

const {
  dataRootSpace,
  exportServerData,
  importServerData,
  measureServerData,
  parseCompress,
} = await import("./transfer");

const SOURCE_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const DEST_ID = "bbbbbbbb-1111-2222-3333-444444444444";
const OCCUPIED_ID = "cccccccc-1111-2222-3333-444444444444";
const MISSING_ID = "dddddddd-1111-2222-3333-444444444444";

/** A small tree that looks like a game server's directory. */
beforeAll(async () => {
  await mkdir(join(root, SOURCE_ID, "world", "region"), { recursive: true });
  await mkdir(join(root, SOURCE_ID, "plugins"), { recursive: true });
  await writeFile(join(root, SOURCE_ID, "server.properties"), "server-port=25565\n");
  await writeFile(join(root, SOURCE_ID, "world", "level.dat"), "x".repeat(4096));
  await writeFile(
    join(root, SOURCE_ID, "world", "region", "r.0.0.mca"),
    Buffer.alloc(8192, 7),
  );
  await writeFile(join(root, SOURCE_ID, "plugins", ".hidden-config"), "kept\n");

  await mkdir(join(root, OCCUPIED_ID), { recursive: true });
  await writeFile(join(root, OCCUPIED_ID, "someone-elses-world.dat"), "do not merge");
});

/** Drain a stream into one buffer. Only for archives small enough to hold. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("parseCompress", () => {
  test("absent and the falsey spellings mean no compression", () => {
    expect(parseCompress(null)).toBe(false);
    expect(parseCompress("")).toBe(false);
    expect(parseCompress("0")).toBe(false);
    expect(parseCompress("false")).toBe(false);
  });

  test("accepts the truthy spellings", () => {
    expect(parseCompress("1")).toBe(true);
    expect(parseCompress("true")).toBe(true);
  });

  test("rejects anything else rather than guessing", () => {
    // A typo that silently meant "no compression" would show up as a slow
    // transfer nobody could explain.
    expect(() => parseCompress("yes")).toThrow();
  });
});

describe("measureServerData", () => {
  test("reports a size that accounts for the whole tree", async () => {
    const bytes = await measureServerData(SOURCE_ID);
    // 4096 + 8192 + the two small files, plus directory entries.
    expect(bytes).toBeGreaterThan(12_000);
  });

  test("a server that is not on this node is a 404, not a zero", async () => {
    // Zero would read as "an empty server", and a migration would then happily
    // conclude it had transferred everything.
    await expect(measureServerData(MISSING_ID)).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("export -> import round trip", () => {
  test("every file, including hidden ones, arrives with its contents", async () => {
    const { body } = await exportServerData(SOURCE_ID);
    const archive = await collect(body);
    expect(archive.byteLength).toBeGreaterThan(0);

    const result = await importServerData(DEST_ID, streamOf(archive));

    expect(
      await readFile(join(root, DEST_ID, "server.properties"), "utf8"),
    ).toBe("server-port=25565\n");
    expect(
      (await readFile(join(root, DEST_ID, "world", "region", "r.0.0.mca"))).byteLength,
    ).toBe(8192);
    // A dotfile is a real config file (`.hidden-config`, and in the wild
    // `.fabric`, `.mixin.out`): `tar -C dir .` picks them up, a glob would not.
    expect(await readFile(join(root, DEST_ID, "plugins", ".hidden-config"), "utf8")).toBe(
      "kept\n",
    );

    // The size the destination reports is what the panel compares against the
    // source measurement to catch a truncated transfer.
    expect(result.sizeBytes).toBeGreaterThan(12_000);
  });

  test("the archive does not carry the server id as a path segment", async () => {
    // Members are relative to the data directory, which is what lets the
    // destination extract into its own root without the two nodes agreeing on
    // any path.
    const { body } = await exportServerData(SOURCE_ID);
    const archive = await collect(body);
    expect(Buffer.from(archive).includes(SOURCE_ID)).toBe(false);
  });

  test("compressed transfers round-trip too", async () => {
    const id = "eeeeeeee-1111-2222-3333-444444444444";
    const { body, contentType } = await exportServerData(SOURCE_ID, { compress: true });
    expect(contentType).toBe("application/gzip");

    await importServerData(id, streamOf(await collect(body)), { compressed: true });
    expect(await readFile(join(root, id, "server.properties"), "utf8")).toBe(
      "server-port=25565\n",
    );
    await rm(join(root, id), { recursive: true, force: true });
  });
});

describe("importServerData refuses to merge", () => {
  test("a destination that already holds data is a 409", async () => {
    const { body } = await exportServerData(SOURCE_ID);
    const archive = await collect(body);

    await expect(
      importServerData(OCCUPIED_ID, streamOf(archive)),
    ).rejects.toMatchObject({ status: 409 });

    // And the file that was there is untouched: a refused import must not be a
    // partial one.
    expect(
      await readFile(join(root, OCCUPIED_ID, "someone-elses-world.dat"), "utf8"),
    ).toBe("do not merge");
  });
});

describe("dataRootSpace", () => {
  test("reports real numbers for a filesystem that exists", async () => {
    const space = await dataRootSpace();
    expect(space.totalBytes).toBeGreaterThan(0);
    expect(space.freeBytes).toBeGreaterThan(0);
    expect(space.freeBytes!).toBeLessThanOrEqual(space.totalBytes!);
  });
});
