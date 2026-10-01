// The not-found page: unknown URLs (the router's default) and `throw notFound()` in a loader
// (a route may pass its own message). SSR answers it with HTTP 404.
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export function NotFound({ children = 'This page does not exist.' }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
      <p className="text-muted-foreground">{children}</p>
      <Link to="/" className="text-sm underline underline-offset-4">
        Back to the board
      </Link>
    </div>
  );
}
