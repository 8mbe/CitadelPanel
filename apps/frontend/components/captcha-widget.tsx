"use client";

import * as React from "react";

import type { CaptchaProvider, PublicCaptchaSettings } from "@/lib/api";

/**
 * Renders whichever captcha the panel is configured for, loading that provider's
 * script only when it is actually needed.
 *
 * Dynamic loading rather than three bundled SDKs: the operator picks one provider
 * (or none), so bundling all three would ship two unused third-party scripts to
 * every visitor, and the default configuration is no captcha at all, in which
 * case nothing should be loaded. It also means changing provider in the admin
 * settings takes effect on next page load, with no rebuild.
 *
 * The token is handed up through `onToken`. The parent sends it in the
 * `x-captcha-response` header, and the backend verifies it before the credential
 * handler runs. The widget itself proves nothing.
 */

const SCRIPT_URLS: Record<CaptchaProvider, string> = {
  "cloudflare-turnstile":
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
  "google-recaptcha": "https://www.google.com/recaptcha/api.js?render=explicit",
  // Registers the <cap-widget> custom element. Self-hosted Cap instances can
  // serve this themselves; the CDN is the documented default.
  cap: "https://cdn.jsdelivr.net/npm/cap-widget",
};

/** Minimal shape of the global each hosted provider installs. */
interface RenderableCaptcha {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      "expired-callback"?: () => void;
      "error-callback"?: () => void;
      theme?: string;
    },
  ) => string | number;
  reset: (widgetId?: string | number) => void;
}

declare global {
  interface Window {
    turnstile?: RenderableCaptcha;
    grecaptcha?: RenderableCaptcha;
  }
}

/**
 * Load a script once per page, sharing the promise across callers.
 *
 * Without the cache, React strict-mode double-effects and a remount (switching
 * between the sign-in and sign-up tabs) would each inject another copy of the
 * provider SDK, and both Turnstile and reCAPTCHA misbehave when loaded twice.
 */
const scriptPromises = new Map<string, Promise<void>>();

function loadScript(url: string): Promise<void> {
  const existing = scriptPromises.get(url);
  if (existing) return existing;

  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    // Cap ships as an ES module custom element; the hosted providers are classic
    // scripts and would fail to execute as modules.
    if (url.includes("cap-widget")) script.type = "module";
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      // Drop the cached rejection so a later retry can attempt the load again.
      scriptPromises.delete(url);
      reject(new Error(`Could not load the captcha script from ${url}`));
    });
    document.head.appendChild(script);
  });

  scriptPromises.set(url, promise);
  return promise;
}

/** Poll for the global the script installs; it appears after `load` fires. */
function waitForGlobal<T>(get: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const value = get();
      if (value) return resolve(value);
      if (Date.now() - started > timeoutMs) {
        return reject(new Error("The captcha script loaded but never initialised."));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

export interface CaptchaWidgetProps {
  settings: PublicCaptchaSettings;
  /** Called with a fresh token, or null when it expires and must be re-solved. */
  onToken: (token: string | null) => void;
}

/**
 * Imperative handle exposed by {@link CaptchaWidget}.
 *
 * The one operation a parent needs after a failed submit is `reset()`: captcha
 * tokens are single-use, so the widget must return to its unsolved state for the
 * user to solve again. Clearing the token in parent state alone is not enough,
 * because the hosted widgets keep showing "verified" until their own `reset` is
 * called.
 */
export interface CaptchaWidgetHandle {
  reset: () => void;
}

export const CaptchaWidget = React.forwardRef<CaptchaWidgetHandle, CaptchaWidgetProps>(
  function CaptchaWidget({ settings, onToken }, ref) {
    const containerRef = React.useRef<HTMLDivElement>(null);
    const [error, setError] = React.useState<string | null>(null);

    // The hosted provider's widget id (Turnstile/reCAPTCHA) once rendered, or
    // the Cap custom element, whichever applies, so `reset()` can reach it.
    const widgetIdRef = React.useRef<string | number | undefined>(undefined);
    const capWidgetRef = React.useRef<HTMLElement | null>(null);

    // Held in a ref so the mount effect does not re-run (and re-render the widget)
    // every time the parent passes a new callback identity.
    const onTokenRef = React.useRef(onToken);
    React.useEffect(() => {
      onTokenRef.current = onToken;
    }, [onToken]);

    const { enabled, provider, siteKey, apiEndpoint } = settings;

    React.useImperativeHandle(ref, () => ({
      reset: () => {
        const providerNow = settings.provider;
        if (providerNow === "cap") {
          // Cap's own reset() returns it to unsolved and fires the `reset`
          // event, which the listener below turns into a null token.
          (capWidgetRef.current as { reset?: () => void } | null)?.reset?.();
          return;
        }
        if (widgetIdRef.current !== undefined) {
          const api =
            providerNow === "cloudflare-turnstile"
              ? window.turnstile
              : window.grecaptcha;
          try {
            api?.reset(widgetIdRef.current);
          } catch {
            // Already torn down; nothing to reset.
          }
        }
      },
    }));

    React.useEffect(() => {
      if (!enabled || !provider || !siteKey) return;

      const container = containerRef.current;
      if (!container) return;

      let cancelled = false;

      (async () => {
        try {
          await loadScript(SCRIPT_URLS[provider]);
          if (cancelled) return;

          if (provider === "cap") {
            // Cap is a custom element driven by attributes and DOM events rather
            // than a render() call, so it is constructed directly.
            const widget = document.createElement("cap-widget");
            widget.setAttribute(
              "data-cap-api-endpoint",
              apiEndpoint ?? `/${siteKey}/`,
            );
            widget.addEventListener("solve", (event) => {
              onTokenRef.current(
                (event as CustomEvent<{ token: string }>).detail.token,
              );
            });
            // Cap tokens are single-use; a reset invalidates the one we hold.
            widget.addEventListener("reset", () => onTokenRef.current(null));
            widget.addEventListener("error", () => {
              onTokenRef.current(null);
              setError("The captcha failed to load. Please reload the page.");
            });
            container.replaceChildren(widget);
            capWidgetRef.current = widget;
            return;
          }

          const api = await waitForGlobal(() =>
            provider === "cloudflare-turnstile" ? window.turnstile : window.grecaptcha,
          );
          if (cancelled) return;

          container.replaceChildren();
          widgetIdRef.current = api.render(container, {
            sitekey: siteKey,
            callback: (token) => onTokenRef.current(token),
            // An expired token would be rejected server-side; clearing it lets the
            // parent disable submit rather than fail the request.
            "expired-callback": () => onTokenRef.current(null),
            "error-callback": () => onTokenRef.current(null),
            theme: "auto",
          });
        } catch (loadError) {
          if (cancelled) return;
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load the captcha.",
          );
        }
      })();

      return () => {
        cancelled = true;
        // Tear the widget down on unmount so a remount does not leave a stale
        // iframe behind (both hosted providers leak one otherwise).
        if (widgetIdRef.current !== undefined) {
          try {
            const api =
              provider === "cloudflare-turnstile"
                ? window.turnstile
                : window.grecaptcha;
            api?.reset(widgetIdRef.current);
          } catch {
            // Already torn down by the provider script.
          }
        }
        // Use the node captured when the effect ran, not the live ref, which may
        // already point elsewhere by cleanup time.
        container.replaceChildren();
        widgetIdRef.current = undefined;
        capWidgetRef.current = null;
      };
    }, [enabled, provider, siteKey, apiEndpoint]);

    if (!enabled || !provider || !siteKey) return null;

    return (
      <div className="flex flex-col gap-2">
        <div ref={containerRef} className="flex min-h-[65px] justify-center" />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    );
  },
);

/**
 * Load the panel's public captcha config.
 *
 * Returns `null` while loading so a form can avoid submitting before it knows
 * whether a token is required. On failure it reports captcha as disabled: the
 * backend is the authority and will still reject a missing token, so guessing
 * "enabled" here would only block sign-in on a transient fetch error.
 */
export function usePublicCaptcha(): PublicCaptchaSettings | null {
  const [settings, setSettings] = React.useState<PublicCaptchaSettings | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/settings/public", {
          credentials: "include",
        });
        const data = (await response.json()) as {
          captcha?: PublicCaptchaSettings;
        };
        if (!cancelled) {
          setSettings(
            data.captcha ?? {
              enabled: false,
              provider: null,
              siteKey: null,
              apiEndpoint: null,
            },
          );
        }
      } catch {
        if (!cancelled) {
          setSettings({
            enabled: false,
            provider: null,
            siteKey: null,
            apiEndpoint: null,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return settings;
}
