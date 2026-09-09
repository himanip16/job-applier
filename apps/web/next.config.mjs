/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  transpilePackages: ['@ja/shared'],
  experimental: {
    /**
     * The rewrite proxy below gives up after 30s by default and destroys the
     * socket, which surfaces as `Failed to proxy ... socket hang up` in the
     * dev server log and a bare 500 in the browser - not an error from our
     * API at all, and impossible to tell apart from one in the UI.
     *
     * Discovery legitimately runs for minutes: a dozen Firecrawl searches,
     * then a board API pull per company found, then an LLM read of the top
     * leads. Ten minutes is the ceiling that lets those finish; the server
     * itself sets no request timeout, so this is the only wall.
     */
    proxyTimeout: 10 * 60 * 1000,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:8787/api/:path*',
      },
    ];
  },
};
