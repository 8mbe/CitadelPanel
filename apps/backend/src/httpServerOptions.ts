/** Transport limits shared by the agent and its streaming HTTP regression tests. */
export const HTTP_SERVER_OPTIONS = {
  // Migration imports stream whole servers into tar. Bun's default 128 MiB
  // ceiling rejects them before the handler can finish; zero rejects all bodies.
  // This is a byte ceiling, not a buffer allocation. File-manager uploads still
  // enforce AGENT_MAX_UPLOAD_BYTES while reading their own stream.
  maxRequestBodySize: Number.MAX_SAFE_INTEGER,
} as const;
