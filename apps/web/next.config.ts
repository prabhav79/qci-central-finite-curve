import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@cfc/shared-types"],
  async headers() {
    return [
      {
        source: "/superdoc-workers/:path*",
        headers: [
          {
            key: "Content-Type",
            value: "text/javascript; charset=utf-8",
          },
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    config.module = config.module || {};
    config.module.parser = {
      ...(config.module.parser || {}),
      javascript: {
        exprContextCritical: false,
      },
    };

    if (isServer) {
      const externals = config.externals;
      config.externals = [
        ...(Array.isArray(externals) ? externals : externals ? [externals] : []),
        (
          { request }: { request?: string },
          callback: (err?: Error | null, result?: string) => void,
        ) => {
          if (
            request &&
            (request.startsWith("@superdoc-dev/") ||
              request === "superdoc" ||
              request.startsWith("superdoc/") ||
              request.startsWith("@superdoc/"))
          ) {
            return callback(null, "commonjs " + request);
          }
          callback();
        },
      ];
    } else {
      config.resolve = config.resolve || {};
      config.resolve.fallback = {
        ...(config.resolve.fallback || {}),
        fs: false,
        path: false,
        crypto: false,
      };
    }

    return config;
  },
};

export default nextConfig;