/**
 * AES-256-GCM encryption for secrets stored at rest.
 *
 * Used for node TLS client certs/keys, per-node database admin passwords,
 * provisioned per-server database passwords, and secret `server_env` values.
 * Plaintext secrets are never written to the database (plan.md section 4).
 *
 * Format of the returned string:
 *   v1.<base64 salt>.<base64 iv>.<base64 authTag>.<base64 ciphertext>
 *
 * The version prefix lets us change the KDF or cipher later without being
 * unable to read old rows.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { env } from "../config/env";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12; // 96-bit nonce, the recommended size for GCM
const AUTH_TAG_LENGTH = 16;

/**
 * Derive a per-ciphertext key from the panel secret and a random salt.
 * A fresh salt per value means identical plaintexts do not share a key.
 */
function deriveKey(salt: Buffer): Buffer {
  return scryptSync(env.encryptionKey, salt, KEY_LENGTH);
}

/** Encrypt a UTF-8 string for storage at rest. */
export function encryptSecret(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(salt);

  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    salt.toString("base64"),
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/**
 * Decrypt a value produced by {@link encryptSecret}.
 *
 * Throws if the payload is malformed or the authentication tag does not
 * verify, which also covers tampering and wrong-key situations.
 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 5) {
    throw new Error("Malformed encrypted payload: expected 5 segments.");
  }

  const [version, saltB64, ivB64, authTagB64, ciphertextB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  if (version !== VERSION) {
    throw new Error(`Unsupported encrypted payload version: ${version}`);
  }

  const salt = Buffer.from(saltB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH) {
    throw new Error("Malformed encrypted payload: bad salt or IV length.");
  }

  const decipher = createDecipheriv(ALGORITHM, deriveKey(salt), iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/** Encrypt only when a value is present, preserving null/undefined. */
export function encryptOptionalSecret(
  plaintext: string | null | undefined,
): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === "") {
    return null;
  }
  return encryptSecret(plaintext);
}

/** Decrypt only when a value is present, preserving null/undefined. */
export function decryptOptionalSecret(
  payload: string | null | undefined,
): string | null {
  if (payload === null || payload === undefined || payload === "") {
    return null;
  }
  return decryptSecret(payload);
}

/**
 * Generate a cryptographically random password suitable for provisioned
 * database users (plan.md section 7.1.2 requires 32+ chars of strong entropy).
 *
 * Uses an alphabet without shell/SQL-hostile characters so the value can be
 * safely embedded in connection strings and game-server config files.
 */
export function generateStrongPassword(length = 40): string {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/** Constant-time string comparison, for comparing tokens/secrets. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
