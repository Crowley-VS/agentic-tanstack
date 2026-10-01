// The Notes board's operations, query keys and query options: loaders `ensure…()` these options and
// components `useSuspense…()` the same ones. After a write, invalidate by key (noteKeys).
import { NOTE_LIMITS } from '@acme/validators/notes';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { graphql } from '../../gql';
import { execute } from '../graphql/execute';

const NotesQuery = graphql(`
  query Notes($first: Int, $after: String) {
    notes(first: $first, after: $after) {
      edges {
        node {
          id
          title
          body
          createdAt
          commentCount
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`);

const NoteQuery = graphql(`
  query Note($id: ID!) {
    note(id: $id) {
      id
      title
      body
      createdAt
      commentCount
      comments {
        id
        authorName
        body
        createdAt
      }
    }
  }
`);

export const CreateNoteMutation = graphql(`
  mutation CreateNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      __typename
      ... on MutationCreateNoteSuccess {
        data {
          id
        }
      }
      ... on ValidationError {
        fieldErrors {
          path
          message
        }
      }
    }
  }
`);

export const AddCommentMutation = graphql(`
  mutation AddComment($input: AddCommentInput!) {
    addComment(input: $input) {
      __typename
      ... on MutationAddCommentSuccess {
        data {
          id
        }
      }
      ... on ValidationError {
        fieldErrors {
          path
          message
        }
      }
      ... on NotFoundError {
        id
        message
      }
    }
  }
`);

/** Query keys, broad to narrow: invalidating `all` refetches every notes query. */
export const noteKeys = {
  all: ['notes'] as const,
  lists: () => [...noteKeys.all, 'list'] as const,
  list: (pageSize: number) => [...noteKeys.lists(), { pageSize }] as const,
  details: () => [...noteKeys.all, 'detail'] as const,
  detail: (id: string) => [...noteKeys.details(), id] as const,
};

/** The board: newest first, NOTE_LIMITS.pageSize per page, "Load more" fetches the next page. */
export const notesOptions = (pageSize: number = NOTE_LIMITS.pageSize) =>
  infiniteQueryOptions({
    queryKey: noteKeys.list(pageSize),
    queryFn: ({ pageParam, signal }) =>
      execute(NotesQuery, { first: pageSize, after: pageParam }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: ({ notes: { pageInfo } }) =>
      pageInfo.hasNextPage ? pageInfo.endCursor : undefined,
  });

/** One note with its newest comments; `note` is null when no note has this id. */
export const noteOptions = (id: string) =>
  queryOptions({
    queryKey: noteKeys.detail(id),
    queryFn: ({ signal }) => execute(NoteQuery, { id }, { signal }),
  });
