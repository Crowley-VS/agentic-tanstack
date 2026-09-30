// Start's router entry (it must be src/router.tsx exporting getRouter). Start calls getRouter()
// for every server request (SSR and /api/* alike) and once in the browser: keep it free of I/O.
// Route types need no `declare module` here: routeTree.gen.ts registers the router with Start.
import { createRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultNotFoundComponent: () => <p>Not found.</p>,
  });
}
