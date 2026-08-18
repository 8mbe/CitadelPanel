import type { Metadata } from "next";
import { Inter, Geist_Mono } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";
import { Analytics } from "@/components/analytics";
import { BrandingProvider } from "@/components/branding-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { buildSiteMetadata, getSiteSettings } from "@/lib/server/site-settings";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Metadata is generated per request rather than exported statically because the
 * site name, description, and indexing policy live in `panel_settings` — an
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
  const { branding, analytics } = await getSiteSettings();

  return (
    <html
      lang="en"
      className={cn("h-full", "antialiased", geistMono.variable, "font-sans", inter.variable)}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <BrandingProvider branding={branding}>{children}</BrandingProvider>
        </ThemeProvider>
        <Analytics settings={analytics} />
      </body>
    </html>
  );
}
