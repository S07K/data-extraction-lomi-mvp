import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Not needed for `prisma generate`; required for migrate.
    url: process.env["DATABASE_URL"] ?? "postgresql://lomi:lomi@localhost:55432/lomi",
  },
});
