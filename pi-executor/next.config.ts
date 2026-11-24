import type { NextConfig } from "next";
import { dirname } from "path";
import { fileURLToPath } from "url";
import upstream from "./upstream.json";

const configDir = dirname(fileURLToPath(import.meta.url));

// GitHub Pages serves a project site from /<repo>/. The workflow passes the
// prefix in PAGES_BASE_PATH; local builds and `next dev` run at the root.
const basePath = (process.env.PAGES_BASE_PATH ?? "").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  trailingSlash: true,
  outputFileTracingRoot: configDir,
  turbopack: { root: configDir },
  images: { unoptimized: true },
  // Next writes AGENTS.md / CLAUDE.md into the project on `next dev` otherwise.
  agentRules: false,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  env: {
    NEXT_PUBLIC_APP_VERSION: upstream.piWebVersion,
    NEXT_PUBLIC_PI_VERSION: upstream.piSdkVersion,
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
