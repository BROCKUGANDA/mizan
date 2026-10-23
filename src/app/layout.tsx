import type { Metadata, Viewport } from "next";
import "./globals.css";

/* Self-hosted IBM Plex (§28): Sans covers Latin, Sans Arabic covers the Arabic
 * glyphs via unicode-range, Mono covers hashes/ids. No external font CDN at
 * runtime — files are bundled and served from /_next/static (offline-safe). */
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-sans/700.css";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

import { Toaster } from "@/components/ui/toaster";
import { MizanThemeProviders } from "@/components/mizan/theme-provider";

export const metadata: Metadata = {
  title: "MIZAN — Continuous HR Policy Assurance",
  description:
    "MIZAN (ميزان, the balance): a census, not a sample. Every HR transaction checked against every written rule by a deterministic engine. Synthetic data only.",
  applicationName: "MIZAN",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf7f0" },
    { media: "(prefers-color-scheme: dark)", color: "#1d1916" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground min-h-screen flex flex-col">
        <MizanThemeProviders>{children}</MizanThemeProviders>
        <Toaster />
      </body>
    </html>
  );
}
