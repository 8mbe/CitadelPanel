import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { Analytics } from "@/components/analytics";
import { BrandingProvider } from "@/components/branding-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { buildSiteMetadata, getSiteSettings } from "@/lib/server/site-settings";
import { buildSiteThemeCss } from "@/lib/site-theme";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Metadata is generated per request rather than exported statically because the
 * site name, description, and indexing policy live in `panel_settings`. An
 * admin renames the panel and every `<title>` follows without a redeploy. See
 * `lib/server/site-settings.ts` for the build and its failure behaviour.
 */
export function generateMetadata(): Promise<Metadata> {
  return buildSiteMetadata();
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { branding, analytics, theme } = await getSiteSettings();
  // The operator's palette is server-rendered rather than fetched: it has to be
  // in the same response as the `site-*` class next-themes puts on <html>, or a
  // visitor whose theme is the site theme gets a frame of the base palette.
  const siteThemeCss = buildSiteThemeCss(theme);

  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistMono.variable, "font-sans", inter.variable)}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        {siteThemeCss && (
          // React hoists this into <head>. The rules outrank both `:root` and
          // `.dark` on specificity (see `buildSiteThemeCss`), so they win
          // wherever the hoist lands relative to the app stylesheet.
          <style
            href="site-theme"
            precedence="high"
            dangerouslySetInnerHTML={{ __html: siteThemeCss }}
          />
        )}
        <ThemeProvider siteThemeBase={theme.base}>
          <BrandingProvider branding={branding}>{children}</BrandingProvider>
        </ThemeProvider>
        <Analytics settings={analytics} />
      </body>
    </html>
  );
}
