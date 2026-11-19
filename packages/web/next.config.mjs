import path from "node:path";

const isProd = process.env.NODE_ENV === "production";

/** @type {import('next').NextConfig} */
export default {
  // A self-contained server for the container image.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          // Next.js needs inline scripts and styles without a nonce setup. No external origins.
          ...(isProd
            ? [
                {
                  key: "Content-Security-Policy",
                  value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
                },
              ]
            : []),
        ],
      },
    ];
  },
};
