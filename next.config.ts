import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // better-sqlite3 is a native module; keep it external to the server bundle
  serverExternalPackages: ["better-sqlite3"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;