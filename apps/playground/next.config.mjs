/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    "@agentforge/core",
    "@agentforge/models",
    "@agentforge/observability",
    "@agentforge/storage",
    "@agentforge/tools",
    "@agentforge/workflows",
  ],
  experimental: { typedRoutes: true },
};

export default nextConfig;
