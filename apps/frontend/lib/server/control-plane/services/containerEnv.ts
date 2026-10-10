import { createHmac } from "node:crypto";

/** Identify the exact env sent to Docker without storing another copy of secrets. */
export function containerEnvFingerprint(
  values: Record<string, string>,
  encryptionKey: string,
): string {
  const entries = Object.entries(values).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return createHmac("sha256", encryptionKey)
    .update("citadel-container-env-v1\0")
    .update(JSON.stringify(entries))
    .digest("hex");
}
