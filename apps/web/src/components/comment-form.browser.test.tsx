// The "Add a comment" form in real Chromium, with execute() mocked (see note-form.browser.test.tsx).
// Each form has its own copy of the pending, read-only and error handling, so each tests it.
import { toast, Toaster } from '@acme/ui/components/sonner';
import { READ_ONLY } from '@acme/validators/error-codes';
import { NOTE_LIMITS } from '@acme/validators/notes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { AddCommentDocument, type AddCommentMutation } from '../gql/graphql';
import { appStatusOptions } from '../lib/app-status';
import { GraphQLRequestError } from '../lib/graphql/errors';
import { execute } from '../lib/graphql/execute';
import { noteKeys } from '../lib/notes/queries';
import { CommentForm } from './comment-form';

vi.mock('../lib/graphql/execute', () => ({ execute: vi.fn() }));
const executeMock = vi.mocked(execute);

afterEach(() => {
  executeMock.mockReset();
  // a new Toaster shows the toasts still active (sonner's module state): none may leak
  toast.dismiss();
});

const NOTE_ID = '0198f3c0-0000-7000-8000-000000000000';

async function renderForm({ readOnly = false } = {}) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(appStatusOptions().queryKey, { readOnly });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <CommentForm noteId={NOTE_ID} />
      <Toaster />
    </QueryClientProvider>,
  );
  return {
    screen,
    queryClient,
    author: screen.getByRole('textbox', { name: 'Your name (optional)', exact: true }),
    body: screen.getByRole('textbox', { name: 'Comment', exact: true }),
    submit: screen.getByRole('button', { name: /^(Add comment|Adding…)$/ }),
  };
}

const added: AddCommentMutation = {
  addComment: { __typename: 'MutationAddCommentSuccess', data: { id: 'c1' } },
};

describe('CommentForm (browser)', () => {
  it('requires a comment, not a name', async () => {
    const { screen, author, submit } = await renderForm();
    await submit.click();

    await expect.element(screen.getByText('Comment is required')).toBeVisible();
    await expect.element(author).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('alert').elements()).toHaveLength(1);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('sends a blank name as none (shown as "Anonymous"), refetches the note and the board', async () => {
    executeMock.mockResolvedValue({
      addComment: { __typename: 'MutationAddCommentSuccess', data: { id: 'c1' } },
    } satisfies AddCommentMutation);
    const { screen, queryClient, author, body, submit } = await renderForm();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await author.fill('   ');
    await body.fill('Nice note');
    await submit.click();

    await expect.element(screen.getByText('Comment added')).toBeVisible();
    // no authorName ('' or '   ' would fail this; an undefined one is left out of the JSON)
    expect(executeMock).toHaveBeenCalledExactlyOnceWith(AddCommentDocument, {
      input: { noteId: NOTE_ID, body: 'Nice note' },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notes', 'detail', NOTE_ID] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notes', 'list'], refetchType: 'all' });
    await expect.element(body).toHaveValue('');
  });

  it('says so when the note is gone (NotFoundError)', async () => {
    executeMock.mockResolvedValue({
      addComment: { __typename: 'NotFoundError', id: NOTE_ID, message: 'Note not found' },
    } satisfies AddCommentMutation);
    const { screen, body, submit } = await renderForm();
    await body.fill('Hello?');
    await submit.click();

    await expect.element(screen.getByText('This note no longer exists.')).toBeVisible();
    await expect.element(body).toHaveValue('Hello?');
  });

  it('renders disabled while the API is read-only', async () => {
    const { author, body, submit } = await renderForm({ readOnly: true });
    for (const control of [author, body, submit]) await expect.element(control).toBeDisabled();
  });

  it('keeps its fields within the API limits', async () => {
    const { author, body } = await renderForm();
    await expect.element(author).toHaveAttribute('maxlength', String(NOTE_LIMITS.authorNameMax));
    await expect.element(body).toHaveAttribute('maxlength', String(NOTE_LIMITS.commentBodyMax));
  });

  it('is disabled and busy until the comment is added and the note and board refetched', async () => {
    let answer!: (value: AddCommentMutation) => void;
    executeMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { screen, queryClient, body, submit } = await renderForm();
    let refetched!: () => void;
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockReturnValue(
      new Promise((resolve) => {
        refetched = resolve;
      }),
    );
    await body.fill('Nice note');
    await submit.click();

    await expect.element(submit).toHaveAttribute('aria-busy', 'true');
    await expect.element(submit).toHaveTextContent('Adding…');
    await expect.element(body).toBeDisabled();

    answer(added);
    await expect.poll(() => invalidate.mock.calls.length).toBe(2);
    await expect.element(submit).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Comment added').elements()).toEqual([]);

    refetched();
    await expect.element(screen.getByText('Comment added')).toBeVisible();
    await expect.element(submit).toBeEnabled();
  });

  it('refetches the board even while it is off screen, so going back shows the new count', async () => {
    executeMock.mockResolvedValue(added);
    const { screen, queryClient, body, submit } = await renderForm();
    // the board's list, cached by the page the user came from: nothing on this page reads it
    const board = vi.fn(async () => ({ pages: [], pageParams: [] }));
    await queryClient.prefetchQuery({ queryKey: noteKeys.list(20), queryFn: board });
    await body.fill('Nice note');
    await submit.click();

    await expect.element(screen.getByText('Comment added')).toBeVisible();
    expect(board).toHaveBeenCalledTimes(2);
  });

  it("maps the API's ValidationError to the field it names, and refetches nothing", async () => {
    executeMock.mockResolvedValue({
      addComment: {
        __typename: 'ValidationError',
        fieldErrors: [{ path: ['input', 'body'], message: 'Too rude' }],
      },
    } satisfies AddCommentMutation);
    const { queryClient, body, submit } = await renderForm();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await body.fill('Hello');
    await submit.click();

    await expect.element(body).toHaveAccessibleDescription('Too rude');
    await expect.element(body).toHaveAttribute('aria-invalid', 'true');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('disables itself when a write finds the API read-only', async () => {
    executeMock.mockRejectedValue(
      new GraphQLRequestError(200, [{ message: 'read-only', extensions: { code: READ_ONLY } }]),
    );
    const { screen, queryClient, body, submit } = await renderForm();
    await body.fill('Hello');
    await submit.click();

    await expect
      .element(screen.getByText('The board is read-only right now: nothing was saved.'))
      .toBeVisible();
    await expect.element(submit).toBeDisabled();
    expect(queryClient.getQueryData(appStatusOptions().queryKey)).toEqual({ readOnly: true });
  });

  it('says something when the API answers a result this build does not know', async () => {
    // an API deployed ahead of this web build: a union member codegen has not seen yet
    executeMock.mockResolvedValue({ addComment: { __typename: 'SomethingNew' } });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { screen, body, submit } = await renderForm();
    await body.fill('Hello');
    await submit.click();

    await expect
      .element(screen.getByText('Could not save. Check your connection and try again.'))
      .toBeVisible();
    await expect.element(body).toHaveValue('Hello');
    expect(logged).toHaveBeenCalledExactlyOnceWith('[web] unhandled write result', {
      __typename: 'SomethingNew',
    });
    logged.mockRestore();
  });
});
