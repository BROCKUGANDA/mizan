import type { NextConfig } from "next";

/**
 * Security headers (SECURITY.md): every response carries the hardening set.
 * CSP allows inline/eval styles+scripts because the Next.js dev/sandbox
 * runtime needs them; production builds tighten script-src to nonces via the
 * reverse proxy (Caddyfile) — see docs/SECURITY.md for the header runbook.
 *
 * Frame protection (X-Frame-Options / frame-ancestors) is environment-aware:
 * the sandbox Preview Panel embeds this app in an iframe, so embedding is
 * allowed while NODE_ENV !== "production" (or when MIZAN_ALLOW_EMBED=true).
 * Production deployments keep the strict DENY / 'none' posture — set
 * MIZAN_ALLOW_EMBED=true explicitly if a trusted host must frame the app.
 */
const allowEmbedding =
  process.env.NODE_ENV !== "production" || process.env.MIZAN_ALLOW_EMBED === "true";

const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      ...(allowEmbedding ? [] : ["frame-ancestors 'none'"]),
    ].join("; "),
  },
  ...(allowEmbedding ? [] : [{ key: "X-Frame-Options", value: "DENY" }]),
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
