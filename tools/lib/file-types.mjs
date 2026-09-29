// File types the repository's tools lint. What gets FORMATTED is left to oxfmt itself: the edit
// hook, the pre-commit formatter and `pnpm check` all hand it files and let it skip the types it
// does not support, so the three never disagree about a file.
import { extname } from 'node:path';

/** JavaScript and TypeScript sources: what oxlint lints (in projects and outside them). */
export const SCRIPT_EXTENSIONS = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'];

/** Whether `file` is a JavaScript or TypeScript source (see SCRIPT_EXTENSIONS). */
export const isScript = (file) => SCRIPT_EXTENSIONS.includes(extname(file).slice(1));
