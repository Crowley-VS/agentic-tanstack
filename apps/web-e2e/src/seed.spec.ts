// The e2e database starts from the deterministic seed (db:db-seed-e2e runs before api:serve-e2e).
// Other specs add notes at the same time, and the list is newest first, so the seed is found from
// the oldest end (`last`), never assumed to be the first page.
import { expect, gql, SEED, test } from './fixtures';

type SeedNote = { title: string; commentCount: number };

const OldestNotes = /* GraphQL */ `
  query E2EOldestNotes($last: Int!) {
    notes(last: $last) {
      edges {
        node {
          title
          commentCount
        }
      }
    }
  }
`;

test('the API serves the seeded notes, newest first, with their comment counts', async ({
  request,
}) => {
  const { notes } = await gql<{ notes: { edges: { node: SeedNote }[] } }>(request, OldestNotes, {
    last: SEED.notes,
  });
  const expected = Array.from({ length: SEED.notes }, (_, i) => SEED.notes - i); // 25 … 1
  expect(notes.edges.map((e) => e.node.title)).toEqual(expected.map(SEED.title));
  expect(notes.edges.map((e) => e.node.commentCount)).toEqual(expected.map(SEED.comments));
});
