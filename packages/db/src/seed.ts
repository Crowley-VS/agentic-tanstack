import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { comments, notes } from './schema';

/** What the deterministic seed creates; e2e tests rely on these titles. */
export const SEED = {
  notes: 25,
  /** Oldest first: "Seed note 01" … "Seed note 25"; note n gets n % 4 comments. */
  title: (n: number) => `Seed note ${String(n).padStart(2, '0')}`,
  /** Fixed timestamps, one minute apart, so the order never depends on insert timing. */
  epoch: Date.UTC(2026, 0, 1, 9, 0, 0),
} as const;

/** Replace all data with the deterministic seed. Never run this against production. */
export async function seed(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`truncate ${comments}, ${notes}`);
    for (let n = 1; n <= SEED.notes; n++) {
      const createdAt = new Date(SEED.epoch + n * 60_000);
      const [note] = await tx
        .insert(notes)
        .values({ title: SEED.title(n), body: `Body of seed note ${n}.`, createdAt })
        .returning({ id: notes.id });
      if (!note) throw new Error('seed: insert returned no row');
      const count = n % 4;
      if (count > 0)
        await tx.insert(comments).values(
          Array.from({ length: count }, (_, i) => ({
            noteId: note.id,
            authorName: i % 2 === 0 ? `Reader ${i + 1}` : null,
            body: `Comment ${i + 1} on seed note ${n}.`,
            createdAt: new Date(createdAt.getTime() + (i + 1) * 1000),
          })),
        );
    }
  });
}
