import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { comments, notes } from './schema';
import { SEED, seed } from './seed';
import { testDb } from './testing';

describe('schema (migrated test database)', () => {
  it('stores notes with time-ordered uuidv7 ids', async () => {
    const { db } = testDb();
    const [a] = await db.insert(notes).values({ title: 'A', body: 'x' }).returning();
    const [b] = await db.insert(notes).values({ title: 'B', body: 'y' }).returning();
    expect(a!.id < b!.id).toBe(true); // uuidv7 sorts by creation time
  });

  it('keeps created_at to milliseconds, which a JS Date (a cursor) round-trips exactly', async () => {
    const { db } = testDb();
    const { rows } = await db.execute(sql`
      select table_name, datetime_precision from information_schema.columns
      where column_name = 'created_at' and table_name in ('notes', 'comments')
      order by table_name`);
    expect(rows).toEqual([
      { table_name: 'comments', datetime_precision: 3 },
      { table_name: 'notes', datetime_precision: 3 },
    ]);
  });

  it('deletes a note’s comments with it (foreign key cascade)', async () => {
    const { db } = testDb();
    const [note] = await db.insert(notes).values({ title: 'T', body: 'b' }).returning();
    await db.insert(comments).values({ noteId: note!.id, body: 'c' });
    await db.delete(notes).where(eq(notes.id, note!.id));
    expect(await db.$count(comments, eq(comments.noteId, note!.id))).toBe(0);
  });

  it('rejects a comment on a missing note (23503 on the error cause)', async () => {
    const { db } = testDb();
    const err = await db
      .insert(comments)
      .values({ noteId: '0198f3c0-0000-7000-8000-000000000000', body: 'orphan' })
      .catch((e: unknown) => e);
    expect((err as { cause?: { code?: string } }).cause?.code).toBe('23503');
  });

  it('serves the pagination order from the (created_at, id) index', async () => {
    const { db } = testDb();
    await db.execute(sql`set enable_seqscan = off`);
    const plan = await db.execute(
      sql`explain select id from notes order by created_at desc, id desc limit 5`,
    );
    expect(JSON.stringify(plan.rows)).toMatch(
      /Index (Only )?Scan Backward using notes_created_at_id_idx/,
    );
  });
});

describe('seed', () => {
  it('creates the same data every time, oldest first', async () => {
    const { db } = testDb();
    await seed(db);
    await seed(db); // idempotent: replaces, never duplicates
    const rows = await db.select().from(notes).orderBy(notes.createdAt);
    expect(rows).toHaveLength(SEED.notes);
    expect(rows[0]!.title).toBe('Seed note 01');
    expect(rows.at(-1)!.title).toBe('Seed note 25');
    expect(await db.$count(comments)).toBe(
      Array.from({ length: SEED.notes }, (_, i) => (i + 1) % 4).reduce((a, b) => a + b, 0),
    );
  });

  it('loads notes with their comments in a single statement (relational query)', async () => {
    const { db, statements } = testDb();
    await seed(db);
    statements.length = 0;
    const page = await db.query.notes.findMany({
      orderBy: { createdAt: 'desc', id: 'desc' },
      limit: 4,
      with: { comments: true },
    });
    expect(page.map((n) => n.title)).toEqual([25, 24, 23, 22].map(SEED.title));
    expect(page.map((n) => n.comments.length)).toEqual([1, 0, 3, 2]);
    expect(statements).toHaveLength(1);
  });
});
