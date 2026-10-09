// The board's "New note" form: the pattern every write in this app follows (docs/web.md).
// 1. Validate in the browser with the API's own Zod schema (@acme/validators): same rules, same
//    messages, and nothing is sent while a field is invalid.
// 2. Send it with execute() through useMutation (the pending state). Expected failures come back
//    as union members, handled by an exhaustive `__typename` switch; a write that throws
//    (read-only, rate limited, the network) shows one message under the form (useWriteError).
// 3. On success: invalidate the queries that show the new data, reset the form, toast.
import { Button } from '@acme/ui/components/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@acme/ui/components/field';
import { Input } from '@acme/ui/components/input';
import { toast } from '@acme/ui/components/sonner';
import { Textarea } from '@acme/ui/components/textarea';
import { NOTE_LIMITS, NoteInput } from '@acme/validators/notes';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useHydrated } from '@tanstack/react-router';
import { type FormEvent, useId, useState } from 'react';
import { useReadOnly } from '../lib/app-status';
import { fieldErrors, type FieldErrors, unreachable, useWriteError } from '../lib/forms';
import { execute } from '../lib/graphql/execute';
import { CreateNoteMutation, noteKeys } from '../lib/notes/queries';

const FIELDS = ['title', 'body'] as const;

export function NoteForm() {
  const id = useId();
  const readOnly = useReadOnly();
  // before hydration a submit would be a native GET with the note in the URL: wait for React
  const hydrated = useHydrated();
  const queryClient = useQueryClient();
  const writeError = useWriteError();
  const [errors, setErrors] = useState<FieldErrors<(typeof FIELDS)[number]>>({});
  const createNote = useMutation({
    mutationFn: async (input: NoteInput) =>
      (await execute(CreateNoteMutation, { input })).createNote,
    // returned, so the form stays pending until the board has refetched: the new note is there
    // when the form is back (mutateAsync waits for this onSuccess, not for a per-call one)
    onSuccess: (result) =>
      result.__typename === 'MutationCreateNoteSuccess' &&
      queryClient.invalidateQueries({ queryKey: noteKeys.lists() }),
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    // read now: once pending, the disabled fieldset leaves its fields out of FormData
    const input = NoteInput.safeParse(Object.fromEntries(new FormData(form)));
    if (!input.success) return setErrors(fieldErrors(input.error.issues, FIELDS));
    setErrors({});
    let result;
    try {
      result = await createNote.mutateAsync(input.data);
    } catch (error) {
      return setErrors({ form: writeError(error) });
    }
    switch (result.__typename) {
      case 'MutationCreateNoteSuccess':
        form.reset();
        toast.success('Note created');
        return;
      case 'ValidationError':
        return setErrors(fieldErrors(result.fieldErrors, FIELDS, { argument: 'input' }));
      default:
        return setErrors({ form: unreachable(result) });
    }
  }

  const pending = createNote.isPending;
  return (
    <form noValidate aria-label="New note" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={readOnly || pending}>
        <FieldGroup>
          <Field data-invalid={!!errors.title}>
            <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
            <Input
              id={`${id}-title`}
              name="title"
              maxLength={NOTE_LIMITS.titleMax}
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? `${id}-title-error` : undefined}
            />
            <FieldError id={`${id}-title-error`}>{errors.title}</FieldError>
          </Field>
          <Field data-invalid={!!errors.body}>
            <FieldLabel htmlFor={`${id}-body`}>Body</FieldLabel>
            <Textarea
              id={`${id}-body`}
              name="body"
              rows={3}
              maxLength={NOTE_LIMITS.bodyMax}
              aria-invalid={!!errors.body}
              aria-describedby={errors.body ? `${id}-body-error` : undefined}
            />
            <FieldError id={`${id}-body-error`}>{errors.body}</FieldError>
          </Field>
          <FieldError>{errors.form}</FieldError>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!hydrated} aria-busy={pending}>
              {pending ? 'Creating…' : 'Create note'}
            </Button>
          </Field>
        </FieldGroup>
      </fieldset>
    </form>
  );
}
