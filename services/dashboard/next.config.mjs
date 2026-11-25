import { LEARNING_FILE_CSP } from './src/lib/learning-file-csp.mjs';

const securityHeaders = [
  // React escapes all rendered text; the CSP is a second layer (Next.js needs inline bootstrap scripts).
  { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // same-origin: no Referer ever leaves the site, but same-origin form POSTs carry a real Origin
  // header. ('no-referrer' made browsers send "Origin: null" on every form POST, which the CSRF
  // origin check rejected.)
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Cache-Control', value: 'no-store' },
];

export default {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      {
        // Apply the sandbox here as well because Next's configured headers take precedence.
        source: '/api/learning-files/:submissionId/:fileId',
        headers: [{ key: 'Content-Security-Policy', value: LEARNING_FILE_CSP }],
      },
    ];
  },
};
