// Vitest setupFiles entry: runs in the worker before EACH test file and gives it a fresh database
// cloned from test_template. `testDb()` (./index.ts) returns a handle to it.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, inject } from 'vitest';
import { closeTestDb } from './index';

const { adminUrl, template, runId } = inject('testDb');
const name = `t_${runId}_${process.env.VITEST_POOL_ID ?? 0}_${randomBytes(3).toString('hex')}`;

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`create database "${name}" template ${template}`);
process.env.TEST_FILE_DATABASE_URL = Object.assign(new URL(adminUrl), {
  pathname: `/${name}`,
}).toString();

afterAll(async () => {
  await closeTestDb();
  // Not `with (force)`: pool.end() resolves before server backends exit, and FORCE would kill a
  // still-closing connection (FATAL 57P01 as an unhandled error). A plain DROP waits for them.
  await admin.query(`drop database if exists "${name}"`).catch(async (err) => {
    if (err.code !== '55006') throw err; // object_in_use: something leaked a connection
    await admin.query(`drop database if exists "${name}" with (force)`);
  });
  await admin.end();
});
