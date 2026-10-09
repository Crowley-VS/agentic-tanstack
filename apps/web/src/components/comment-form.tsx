// The note page's "Add a comment" form: the same pattern as note-form.tsx (validate with the shared
// schema, execute(), exhaustive `__typename` switch, invalidate, reset, toast). The author's name
// is optional: left blank, it is not sent and the comment shows "Anonymous".
import { Button } from '@acme/ui/components/button';
import { Field, FieldError, FieldGroup, FieldLabel } from '@acme/ui/components/field';
import { Input } from '@acme/ui/components/input';
import { toast } from '@acme/ui/components/sonner';
import { Textarea } from '@acme/ui/components/textarea';
import { CommentInput, NOTE_LIMITS } from '@acme/validators/notes';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useHydrated } from '@tanstack/react-router';
import { type FormEvent, useId, useState } from 'react';
import { useReadOnly } from '../lib/app-status';
import { fieldErrors, type FieldErrors, unreachable, useWriteError } from '../lib/forms';
import { execute } from '../lib/graphql/execute';
import { AddCommentMutation, noteKeys } from '../lib/notes/queries';

const FIELDS = ['authorName', 'body'] as const;

export function CommentForm({ noteId }: { noteId: string }) {
  const id = useId();
  const readOnly = useReadOnly();
  const hydrated = useHydrated();
  const queryClient = useQueryClient();
  const writeError = useWriteError();
  const [errors, setErrors] = useState<FieldErrors<(typeof FIELDS)[number]>>({});
  const addComment = useMutation({
    mutationFn: async (input: CommentInput) =>
      (await execute(AddCommentMutation, { input })).addComment,
    // the note shows the comment; the board shows the note's comment count. The board is off
    // screen here (inactive): 'all' refetches it too, so going back never shows the old count
    onSuccess: (result) =>
      result.__typename === 'MutationAddCommentSuccess' &&
      Promise.all([
        queryClient.invalidateQueries({ queryKey: noteKeys.detail(noteId) }),
        queryClient.invalidateQueries({ queryKey: noteKeys.lists(), refetchType: 'all' }),
      ]),
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = CommentInput.safeParse({ ...Object.fromEntries(new FormData(form)), noteId });
    if (!input.success) return setErrors(fieldErrors(input.error.issues, FIELDS));
    setErrors({});
    let result;
    try {
      result = await addComment.mutateAsync(input.data);
    } catch (error) {
      return setErrors({ form: writeError(error) });
    }
    switch (result.__typename) {
      case 'MutationAddCommentSuccess':
        form.reset();
        toast.success('Comment added');
        return;
      case 'ValidationError':
        return setErrors(fieldErrors(result.fieldErrors, FIELDS, { argument: 'input' }));
      case 'NotFoundError':
        return setErrors({ form: 'This note no longer exists.' });
      default:
        return setErrors({ form: unreachable(result) });
    }
  }

  const pending = addComment.isPending;
  return (
    <form noValidate aria-label="Add a comment" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={readOnly || pending}>
        <FieldGroup>
          <Field data-invalid={!!errors.authorName}>
            <FieldLabel htmlFor={`${id}-author`}>Your name (optional)</FieldLabel>
            <Input
              id={`${id}-author`}
              name="authorName"
              placeholder="Anonymous"
              maxLength={NOTE_LIMITS.authorNameMax}
              aria-invalid={!!errors.authorName}
              aria-describedby={errors.authorName ? `${id}-author-error` : undefined}
            />
            <FieldError id={`${id}-author-error`}>{errors.authorName}</FieldError>
          </Field>
          <Field data-invalid={!!errors.body}>
            <FieldLabel htmlFor={`${id}-body`}>Comment</FieldLabel>
            <Textarea
              id={`${id}-body`}
              name="body"
              rows={3}
              maxLength={NOTE_LIMITS.commentBodyMax}
              aria-invalid={!!errors.body}
              aria-describedby={errors.body ? `${id}-body-error` : undefined}
            />
            <FieldError id={`${id}-body-error`}>{errors.body}</FieldError>
          </Field>
          <FieldError>{errors.form}</FieldError>
          <Field orientation="horizontal">
            <Button type="submit" disabled={!hydrated} aria-busy={pending}>
              {pending ? 'Adding…' : 'Add comment'}
            </Button>
          </Field>
        </FieldGroup>
      </fieldset>
    </form>
  );
}
