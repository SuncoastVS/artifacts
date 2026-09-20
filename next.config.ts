import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Local parsing ceiling; hosting platforms can reject smaller requests
      // first. Large artifact uploads are compressed before invoking an action.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
