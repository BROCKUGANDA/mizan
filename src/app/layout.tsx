import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "@/components/mizan/theme-provider";

export const metadata: Metadata = {
  title: "MIZAN — Continuous HR Policy Assurance",
  description:
    "MIZAN (ميزان, the balance): a census, not a sample. Every HR transaction checked against every written rule by a deterministic engine. Synthetic data only.",
  icons: { icon: "/favicon.ico" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground min-h-screen flex flex-col">
        <ThemeProvider>{children}</ThemeProvider>
        <Toaster />
      </body>
    </html>
  );
}
