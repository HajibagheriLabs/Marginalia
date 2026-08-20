import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { env } from "@/lib/env";

import * as schema from "./schema";

/**
 * The Postgres client.
 *
 * Serverless functions are short-lived and can be spun up in large numbers, so
 * the pool is capped at one connection per instance and the connection string
 * points at Neon's POOLER endpoint — Neon multiplexes on its side. Raising
 * `max` here just exhausts the database's connection limit faster.
 *
 * In development, Next.js hot-reloads modules on every edit; without the
 * global cache each reload would open another pool and leak connections.
 */
const globalForDb = globalThis as unknown as {
  connection: ReturnType<typeof postgres> | undefined;
};

const connection =
  globalForDb.connection ??
  postgres(env.DATABASE_URL, {
    max: 1,
    // Neon closes idle connections; don't hold them open.
    idle_timeout: 20,
    connect_timeout: 10,
  });

if (env.NODE_ENV !== "production") globalForDb.connection = connection;

export const db = drizzle(connection, { schema });

export { schema };
export type Db = typeof db;
