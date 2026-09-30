import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg, { type Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { config } from './config.js';

export interface Database {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
  transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class PostgresDatabase implements Database {
  private readonly pool: Pool;

  constructor(connectionString = config.DATABASE_URL) {
    this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }

  query<R extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<R>(text, values);
  }

  async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async migrate(): Promise<void> {
    const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
    await this.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(migrationsDir)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
    for (const name of files) {
      const alreadyApplied = await this.query('SELECT version FROM schema_migrations WHERE version = $1', [name]);
      if (alreadyApplied.rows.length) continue;
      const sql = await readFile(path.join(migrationsDir, name), 'utf8');
      await this.transaction(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [name]);
      });
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
