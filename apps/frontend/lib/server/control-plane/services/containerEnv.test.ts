import { expect, test } from "bun:test";
import { containerEnvFingerprint } from "./containerEnv";

const key = "test-only-panel-encryption-key-000000000000";

test("env ordering does not trigger a recreate", () => {
  expect(containerEnvFingerprint({ B: "2", A: "1" }, key))
    .toBe(containerEnvFingerprint({ A: "1", B: "2" }, key));
});

test("adding, changing and removing flags produce different fingerprints", () => {
  const original = containerEnvFingerprint({ JVM_OPTS: "" }, key);
  expect(containerEnvFingerprint({ JVM_OPTS: "-javaagent:plugins/Nova.jar" }, key)).not.toBe(original);
  expect(containerEnvFingerprint({}, key)).not.toBe(original);
});

test("key/value delimiters and secret keys cannot collide", () => {
  expect(containerEnvFingerprint({ A: "b=c" }, key))
    .not.toBe(containerEnvFingerprint({ "A=b": "c" }, key));
  expect(containerEnvFingerprint({ PASSWORD: "guessable" }, key))
    .not.toBe(containerEnvFingerprint({ PASSWORD: "guessable" }, "another-panel-key"));
});
