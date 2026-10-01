/* eslint-disable */
import * as types from './graphql';



/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
    "\n  query AppStatus {\n    readOnly\n  }\n": typeof types.AppStatusDocument,
    "\n  query Notes($first: Int, $after: String) {\n    notes(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          title\n          body\n          createdAt\n          commentCount\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n": typeof types.NotesDocument,
    "\n  query Note($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      body\n      createdAt\n      commentCount\n      comments {\n        id\n        authorName\n        body\n        createdAt\n      }\n    }\n  }\n": typeof types.NoteDocument,
};
const documents: Documents = {
    "\n  query AppStatus {\n    readOnly\n  }\n": types.AppStatusDocument,
    "\n  query Notes($first: Int, $after: String) {\n    notes(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          title\n          body\n          createdAt\n          commentCount\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n": types.NotesDocument,
    "\n  query Note($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      body\n      createdAt\n      commentCount\n      comments {\n        id\n        authorName\n        body\n        createdAt\n      }\n    }\n  }\n": types.NoteDocument,
};

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query AppStatus {\n    readOnly\n  }\n"): typeof import('./graphql').AppStatusDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Notes($first: Int, $after: String) {\n    notes(first: $first, after: $after) {\n      edges {\n        node {\n          id\n          title\n          body\n          createdAt\n          commentCount\n        }\n      }\n      pageInfo {\n        hasNextPage\n        endCursor\n      }\n    }\n  }\n"): typeof import('./graphql').NotesDocument;
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Note($id: ID!) {\n    note(id: $id) {\n      id\n      title\n      body\n      createdAt\n      commentCount\n      comments {\n        id\n        authorName\n        body\n        createdAt\n      }\n    }\n  }\n"): typeof import('./graphql').NoteDocument;


export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}
