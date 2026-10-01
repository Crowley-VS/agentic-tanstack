// The "Add a comment" form in real Chromium, with execute() mocked (see note-form.browser.test.tsx,
// which covers the states both forms share: pending, read-only, 429).
import { toast, Toaster } from '@acme/ui/components/sonner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { AddCommentDocument, type AddCommentMutation } from '../gql/graphql';
import { appStatusOptions } from '../lib/app-status';
import { execute } from '../lib/graphql/execute';
import { CommentForm } from './comment-form';

vi.mock('../lib/graphql/execute', () => ({ execute: vi.fn() }));
const executeMock = vi.mocked(execute);

afterEach(() => {
  executeMock.mockReset();
  // a new Toaster shows the toasts still active (sonner's module state): none may leak
  toast.dismiss();
});

const NOTE_ID = '0198f3c0-0000-7000-8000-000000000000';

async function renderForm() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(appStatusOptions().queryKey, { readOnly: false });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <CommentForm noteId={NOTE_ID} />
      <Toaster />
    </QueryClientProvider>,
  );
  return {
    screen,
    queryClient,
    author: screen.getByRole('textbox', { name: 'Your name (optional)' }),
    body: screen.getByRole('textbox', { name: 'Comment' }),
    submit: screen.getByRole('button', { name: 'Add comment' }),
  };
}

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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notes', 'list'] });
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
});
