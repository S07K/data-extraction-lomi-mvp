import { execFileSync } from "node:child_process";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestProject } from "vitest/node";

let container: StartedPostgreSqlContainer | undefined;

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** One throwaway Postgres per test run, migrated with the real migrations. */
export async function setup(project: TestProject) {
  let url = process.env["TEST_DATABASE_URL"];
  if (!url) {
    container = await new PostgreSqlContainer("postgres:18-alpine").start();
    url = container.getConnectionUri();
  }
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  project.provide("databaseUrl", url);
}

export async function teardown() {
  await container?.stop();
}
