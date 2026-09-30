// Hand-written (not from the registry), as shadcn's dark-mode docs do it: next-themes puts the
// `dark` or `light` class on <html> before hydration (the root needs suppressHydrationWarning),
// following the OS theme unless a `theme` is stored in localStorage. The page and the Toaster
// read the same theme.
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ComponentProps } from 'react';

export function ThemeProvider(props: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    />
  );
}
