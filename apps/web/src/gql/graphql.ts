/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type { DocumentTypeDecoration } from '@graphql-typed-document-node/core';
export type AddCommentInput = {
  /** Shown as "Anonymous" when left out or blank */
  authorName?: string | null | undefined;
  body: string;
  noteId: string | number;
};

export type CreateNoteInput = {
  body: string;
  /** An http or https URL of at most 2000 characters; none when left out or blank */
  sourceUrl?: string | null | undefined;
  title: string;
};

export type AppStatusQueryVariables = Exact<{ [key: string]: never; }>;


export type AppStatusQuery = { readOnly: boolean };

export type NotesQueryVariables = Exact<{
  first?: number | null | undefined;
  after?: string | null | undefined;
}>;


export type NotesQuery = { notes: { edges: Array<{ node: { id: string, title: string, body: string, createdAt: string, commentCount: number } }>, pageInfo: { hasNextPage: boolean, endCursor: string | null } } };

export type NoteQueryVariables = Exact<{
  id: string | number;
}>;


export type NoteQuery = { note: { id: string, title: string, body: string, sourceUrl: string | null, createdAt: string, commentCount: number, comments: Array<{ id: string, authorName: string | null, body: string, createdAt: string }> } | null };

export type CreateNoteMutationVariables = Exact<{
  input: CreateNoteInput;
}>;


export type CreateNoteMutation = { createNote:
    | { __typename: 'MutationCreateNoteSuccess', data: { id: string } }
    | { __typename: 'ValidationError', fieldErrors: Array<{ path: Array<string>, message: string }> }
   };

export type AddCommentMutationVariables = Exact<{
  input: AddCommentInput;
}>;


export type AddCommentMutation = { addComment:
    | { __typename: 'MutationAddCommentSuccess', data: { id: string } }
    | { __typename: 'NotFoundError', id: string, message: string }
    | { __typename: 'ValidationError', fieldErrors: Array<{ path: Array<string>, message: string }> }
   };

export class TypedDocumentString<TResult, TVariables>
  extends String
  implements DocumentTypeDecoration<TResult, TVariables>
{
  __apiType?: NonNullable<DocumentTypeDecoration<TResult, TVariables>['__apiType']>;
  private value: string;
  public __meta__?: Record<string, any> | undefined;

  constructor(value: string, __meta__?: Record<string, any> | undefined) {
    super(value);
    this.value = value;
    this.__meta__ = __meta__;
  }

  override toString(): string & DocumentTypeDecoration<TResult, TVariables> {
    return this.value;
  }
}

export const AppStatusDocument = new TypedDocumentString(`
    query AppStatus {
  readOnly
}
    `) as unknown as TypedDocumentString<AppStatusQuery, AppStatusQueryVariables>;
export const NotesDocument = new TypedDocumentString(`
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
    `) as unknown as TypedDocumentString<NotesQuery, NotesQueryVariables>;
export const NoteDocument = new TypedDocumentString(`
    query Note($id: ID!) {
  note(id: $id) {
    id
    title
    body
    sourceUrl
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
    `) as unknown as TypedDocumentString<NoteQuery, NoteQueryVariables>;
export const CreateNoteDocument = new TypedDocumentString(`
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
    `) as unknown as TypedDocumentString<CreateNoteMutation, CreateNoteMutationVariables>;
export const AddCommentDocument = new TypedDocumentString(`
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
    `) as unknown as TypedDocumentString<AddCommentMutation, AddCommentMutationVariables>;