// The shell's home page: proves workspace packages resolve from source (client and SSR) and that
// the page hydrates (the counter). The data layer replaces it.
import { NOTE_LIMITS } from '@acme/validators/notes';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  const [count, setCount] = useState(0);
  return (
    <main>
      <h1>acme-app</h1>
      <p>title max: {NOTE_LIMITS.titleMax}</p>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        clicked {count}
      </button>
    </main>
  );
}
