import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // Monorepo: trace workspace packages from the repo root into the standalone build.
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),
  transpilePackages: ["@lomi/contracts"],
};

export default config;
