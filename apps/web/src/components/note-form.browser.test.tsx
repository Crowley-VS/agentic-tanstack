// The "New note" form in real Chromium. execute() is mocked (vi.mock below): each test says what
// the API answers. Without the Start compiler execute() would take its server branch, so the
// network is not the seam here; execute.test.ts covers the transport itself.
import { toast, Toaster } from '@acme/ui/components/sonner';
import { RATE_LIMITED, READ_ONLY } from '@acme/validators/error-codes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { type CreateNoteMutation, CreateNoteDocument } from '../gql/graphql';
import { appStatusOptions } from '../lib/app-status';
import { GraphQLRequestError } from '../lib/graphql/errors';
import { execute } from '../lib/graphql/execute';
import { NoteForm } from './note-form';

// a plain factory: importOriginal would load execute.ts, whose server imports need Node
vi.mock('../lib/graphql/execute', () => ({ execute: vi.fn() }));
const executeMock = vi.mocked(execute);

afterEach(() => {
  executeMock.mockReset();
  // a new Toaster shows the toasts still active (sonner's module state): none may leak
  toast.dismiss();
});

/** The form with a fresh QueryClient that already knows whether the API is read-only. */
async function renderForm({ readOnly = false } = {}) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(appStatusOptions().queryKey, { readOnly });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <NoteForm />
      <Toaster />
    </QueryClientProvider>,
  );
  const title = screen.getByRole('textbox', { name: 'Title', exact: true });
  const body = screen.getByRole('textbox', { name: 'Body', exact: true });
  const submit = screen.getByRole('button', { name: /^(Create note|Creating…)$/ });
  return { screen, queryClient, title, body, submit };
}

const created: CreateNoteMutation = {
  createNote: { __typename: 'MutationCreateNoteSuccess', data: { id: 'n1' } },
};

describe('NoteForm (browser)', () => {
  it('shows the shared schema’s messages and sends nothing while fields are invalid', async () => {
    const { screen, title, submit } = await renderForm();
    await submit.click();

    await expect.element(screen.getByText('Title is required')).toBeVisible();
    await expect.element(screen.getByText('Body is required')).toBeVisible();
    await expect.element(title).toHaveAttribute('aria-invalid', 'true');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('sends the trimmed input, then resets, refetches the board and toasts', async () => {
    executeMock.mockResolvedValue(created);
    const { screen, queryClient, title, body, submit } = await renderForm();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await title.fill('  Hello ');
    await body.fill('World');
    await submit.click();

    await expect.element(screen.getByText('Note created')).toBeVisible();
    expect(executeMock).toHaveBeenCalledExactlyOnceWith(CreateNoteDocument, {
      input: { title: 'Hello', body: 'World' },
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['notes', 'list'] });
    await expect.element(title).toHaveValue('');
    await expect.element(body).toHaveValue('');
  });

  it("maps the API's ValidationError to the fields it names, keeping the input", async () => {
    executeMock.mockResolvedValue({
      createNote: {
        __typename: 'ValidationError',
        fieldErrors: [{ path: ['input', 'title'], message: 'Title is taken' }],
      },
    } satisfies CreateNoteMutation);
    const { screen, title, body, submit } = await renderForm();
    await title.fill('Hello');
    await body.fill('World');
    await submit.click();

    await expect.element(screen.getByText('Title is taken')).toBeVisible();
    await expect.element(title).toHaveAttribute('aria-invalid', 'true');
    await expect.element(title).toHaveValue('Hello'); // kept, so it can be fixed
  });

  it('is disabled and busy until the note is created and the board refetched', async () => {
    // Promise.withResolvers is ES2024 (lib es2023 here)
    let answer!: (value: CreateNoteMutation) => void;
    executeMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const { screen, queryClient, title, body, submit } = await renderForm();
    let refetched!: () => void;
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockReturnValue(
      new Promise((resolve) => {
        refetched = resolve;
      }),
    );
    await title.fill('Hello');
    await body.fill('World');
    await submit.click();

    await expect.element(submit).toHaveAttribute('aria-busy', 'true');
    await expect.element(submit).toHaveTextContent('Creating…');
    await expect.element(submit).toBeDisabled();
    await expect.element(title).toBeDisabled();

    // created, but the board is still refetching: the form waits for the new note to show
    answer(created);
    await expect.poll(() => invalidate.mock.calls.length).toBe(1);
    await expect.element(submit).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Note created').elements()).toEqual([]);

    refetched();
    await expect.element(screen.getByText('Note created')).toBeVisible();
    await expect.element(submit).toBeEnabled();
    await expect.element(submit).toHaveAttribute('aria-busy', 'false');
  });

  it('renders disabled while the API is read-only', async () => {
    const { title, body, submit } = await renderForm({ readOnly: true });
    for (const control of [title, body, submit]) await expect.element(control).toBeDisabled();
  });

  it('says how long to wait when the BFF refuses with 429', async () => {
    executeMock.mockRejectedValue(
      new GraphQLRequestError(
        429,
        [{ message: 'Too many writes: try again in 7 s.', extensions: { code: RATE_LIMITED } }],
        { retryAfter: 7 },
      ),
    );
    const { screen, title, body, submit } = await renderForm();
    await title.fill('Hello');
    await body.fill('World');
    await submit.click();

    await expect.element(screen.getByText('Too many writes: try again in 7 s.')).toBeVisible();
    await expect.element(title).toHaveValue('Hello');
    await expect.element(submit).toBeEnabled(); // not read-only: it can be sent again
  });

  it('disables itself when a write finds the API read-only', async () => {
    executeMock.mockRejectedValue(
      new GraphQLRequestError(200, [{ message: 'read-only', extensions: { code: READ_ONLY } }]),
    );
    const { screen, queryClient, title, body, submit } = await renderForm();
    await title.fill('Hello');
    await body.fill('World');
    await submit.click();

    await expect
      .element(screen.getByText('The board is read-only right now: nothing was saved.'))
      .toBeVisible();
    await expect.element(title).toBeDisabled();
    await expect.element(submit).toBeDisabled();
    // the banner and every other form read the same cached status
    expect(queryClient.getQueryData(appStatusOptions().queryKey)).toEqual({ readOnly: true });
  });

  it('shows text as text: markup in an error message is not rendered', async () => {
    executeMock.mockResolvedValue({
      createNote: {
        __typename: 'ValidationError',
        fieldErrors: [{ path: ['input', 'body'], message: '<img src=x onerror=alert(1)>' }],
      },
    } satisfies CreateNoteMutation);
    const { screen, title, body, submit } = await renderForm();
    await title.fill('Hello');
    await body.fill('World');
    await submit.click();

    await expect.element(screen.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
    expect(document.querySelector('img')).toBeNull();
  });
});
