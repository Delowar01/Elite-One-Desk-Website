import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Hostinger VPS (PM2 / systemd).
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Uploads are re-encoded to WebP with fixed derivative widths at upload time
  // (see src/lib/media/process.ts) and served with srcset, so the built-in
  // optimiser would only add a second, slower cache in front of our own.
  images: { unoptimized: true },
  experimental: {
    // Server Actions receive uploads; the media validator enforces the real cap.
    serverActions: { bodySizeLimit: "12mb" },
    // Next 16.3 turned optimistic routing on by default, and with these routes
    // — `[lang]` beside a catch-all, every English address rewritten onto
    // `/en/…` — the router never settled on an Arabic page: it prefetched the
    // language switch's English twin, cancelled and asked again, ~100 times a
    // second for as long as the page was open. Upstream that is a predicted
    // route the server rewrites (vercel/next.js#98345, fixed by #98998 in
    // 16.4.0), and 16.4.1 with the default no longer loops here. Off is how 16.2
    // routed and how this release was qualified; turning it back on is a change
    // of its own. tests/browser/probes/prefetch-bounded.
    optimisticRouting: false,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        source: "/fonts/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/brand/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
