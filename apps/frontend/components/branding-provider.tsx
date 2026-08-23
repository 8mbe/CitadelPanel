"use client";

import * as React from "react";

import type { BrandingSettings } from "@/lib/api";

/**
 * The configured site name, shared with every client component.
 *
 * The value is read from `panel_settings` by the root layout, a server
 * component, and handed down through this context. Client components that
 * render the name (the panel header, the sign-in page, the error pages) read it
 * from here rather than fetching `/api/settings/public` themselves, so the name
 * is in the first HTML response and there is never a frame of the wrong brand.
 *
 * The default matches the settings service's own default, so a component
 * rendered outside the provider (a stray test, a future root) still shows
 * something sensible rather than an empty header.
 */
const DEFAULT_BRANDING: BrandingSettings = {
  siteName: "CitadelPanel",
  tagline: "Self-hosted game server management.",
};

const BrandingContext = React.createContext<BrandingSettings>(DEFAULT_BRANDING);

export function BrandingProvider({
  branding,
  children,
}: {
  branding: BrandingSettings;
  children: React.ReactNode;
}) {
  return (
    <BrandingContext.Provider value={branding}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding(): BrandingSettings {
  return React.useContext(BrandingContext);
}
