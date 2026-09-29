import type { NextConfig } from "next"

// Every domain below was verified against actual client-side usage in this
// codebase (not guessed from what the app "probably" needs):
//   - Supabase: the browser client (src/lib/supabase/client.ts) used by
//     login/signup and several dashboard components talks to this URL
//     directly for auth + queries.
//   - Cloudinary: every generated creative's <img src> points at
//     res.cloudinary.com.
//   - Shopify CDN: the Products table renders product_images[0].src directly
//     (the raw Shopify-hosted photo), before any creative has been
//     generated for it — cdn.shopify.com is NOT decorative here.
//   - No Google avatar/profile-picture domain is included: nothing in this
//     app renders a user avatar image, so there's nothing to allow.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const cloudName = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ?? ''

const CSP = [
  "default-src 'self'",
  // 'unsafe-inline' is required for layout.tsx's inline <script> that loads
  // App Bridge synchronously (see that file's own comment on why it can't be
  // a regular <script src> or next/script). 'unsafe-eval' is NOT required —
  // Next.js production builds don't eval — so it's dropped here.
  "script-src 'self' 'unsafe-inline' https://cdn.shopify.com https://cdn.shopifycloud.com",
  // No fonts.googleapis.com/gstatic.com here on purpose: layout.tsx's own
  // comment explains next/font self-hosts Fraunces/Manrope at build time
  // specifically so a strict font-src 'self' doesn't need an exception —
  // adding one back would just be dead allowance for a request this app
  // deliberately never makes.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  [
    "connect-src 'self'",
    supabaseUrl,
    'https://res.cloudinary.com',
    'https://api.cloudinary.com',
    'https://upload.cloudinary.com',
    cloudName ? `https://${cloudName}.cloudinary.com` : '',
    'https://cdn.shopify.com',
    'https://cdn.shopifycloud.com',
    'https://*.myshopify.com',
    'https://admin.shopify.com',
  ].filter(Boolean).join(' '),
  [
    "img-src 'self' data: blob:",
    'https://res.cloudinary.com',
    cloudName ? `https://${cloudName}.cloudinary.com` : '',
    'https://cdn.shopify.com',
    'https://cdn.shopifycloud.com',
    'https://*.myshopify.com',
  ].filter(Boolean).join(' '),
  // Shopify Admin embeds the app in an iframe.
  "frame-ancestors https://*.myshopify.com https://admin.shopify.com",
].join('; ')

const nextConfig: NextConfig = {
  serverExternalPackages: ['@napi-rs/canvas'],
  compress: true,
  poweredByHeader: false,

  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },

  async headers() {
    return [
      {
        source: '/_next/static/(.*)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/(.*)\\.(ico|png|jpg|jpeg|webp|svg|woff|woff2|ttf|otf)',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400, stale-while-revalidate=604800' }],
      },
      {
        source: '/(.*)',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: CSP,
          },
          { key: 'X-Frame-Options', value: 'ALLOWALL' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ]
  },
}

export default nextConfig