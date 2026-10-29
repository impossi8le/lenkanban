/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pino resolves its worker relative to the installed package directory.
  serverExternalPackages: ['pino', 'pino-pretty', 'thread-stream'],
  // Self-contained server bundle for the Docker runner stage.
  output: 'standalone',
  async redirects() {
    return [{ source: '/favicon.ico', destination: '/favicon.svg', permanent: true }];
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Allow large file uploads (50MB)
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
  // Force new build ID on every deploy to bust browser cache
  generateBuildId: async () => {
    return `build-${Date.now()}`;
  },
  // Cache control: pages, RSC payloads and API responses carry per-user data,
  // so they must never be stored. Only the build output under /_next/static is
  // cacheable, and it is decided separately below.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Cache-Control',
            value: 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
          },
          {
            key: 'Pragma',
            value: 'no-cache',
          },
          {
            key: 'Expires',
            value: '0',
          },
        ],
      },
      {
        // Must stay after the catch-all rule: when several rules match, a later
        // rule replaces the same header key. `_next/static` only serves build
        // output, never user data, so it can be cached instead of re-downloaded
        // on every navigation.
        //
        // Only Cache-Control is overridden; the catch-all's Pragma/Expires are
        // still sent. That is harmless and unambiguous: a cache MUST ignore
        // Expires when the response carries max-age (RFC 9111 §5.3), and Pragma
        // is defined for requests, not responses (§5.4).
        //
        // Production chunk names embed the content hash, so a cached copy can
        // never be stale under the same URL. The dev server serves stable names
        // (`chunks/app/layout.js`), which must revalidate: ETags make that a
        // 304 instead of a multi-megabyte body.
        source: '/_next/static/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value:
              process.env.NODE_ENV === 'production'
                ? 'public, max-age=31536000, immutable'
                : 'public, max-age=0, must-revalidate',
          },
        ],
      },
    ];
  },
  // Performance optimizations
  compiler: {
    removeConsole: process.env.NODE_ENV === "production" ? {
      exclude: ["error", "warn"],
    } : false,
  },
  // Optimize images
  images: {
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 60,
  },
  // Enable compression
  compress: true,
  // Reduce bundle size
  modularizeImports: {
    "lucide-react": {
      transform: "lucide-react/dist/esm/icons/{{kebabCase member}}",
    },
  },
  // Fix workspace root detection
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
