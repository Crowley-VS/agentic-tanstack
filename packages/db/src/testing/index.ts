// Test helpers for projects whose tests use the database. Configure Vitest with
// `dbTestConfig()` (./vitest.ts); then, in a test file: `const { db, statements } = testDb();`
import { createDb, type Db } from '../client';

let current: { db: Db; statements: string[]; close: () => Promise<void> } | undefined;

/** This test file's own database (a fresh clone of the migrated template). */
export function testDb(): { db: Db; statements: string[] } {
  if (!current) {
    const url = process.env.TEST_FILE_DATABASE_URL;
    if (!url) throw new Error('testDb(): spread dbTestConfig() (./vitest.ts) into vitest.config');
    const statements: string[] = [];
    const { db, close } = createDb({ url, max: 4, onQuery: (sql) => statements.push(sql) });
    current = { db, statements, close };
  }
  return current;
}

/** Called by the setup file after each test file. */
export async function closeTestDb(): Promise<void> {
  await current?.close();
  current = undefined;
}
