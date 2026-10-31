#!/usr/bin/env node
// Every relative link in the repository's Markdown files resolves: the file or directory it names
// is in the repository, and its `#anchor` names a heading of the Markdown file it points at
// (GitHub's heading ids). A `pnpm check` gate of its own, run on every check: a change to docs
// alone touches no Nx project, so no project's tests would see it break a link.
//
//   node tools/doc-links.mjs    prints each broken link (file:line) and exits 1, or exits 0
//
// Read: the git-visible `.md` files (tracked, or new and not ignored), but not generated ones
// (`.agents/generated.json`: their sources are checked). Links in code blocks, code spans and
// HTML comments are not links, and neither is a URL with a scheme (`https:`, `mailto:`).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findArtifact, loadManifest } from './lib/generated.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `text` as spaces, its line breaks kept. */
const blank = (text) => text.replace(/[^\n]/g, ' ');

/**
 * `markdown` with fenced code blocks, HTML comments and (unless `spans` is false) code spans
 * blanked out, every line kept in place.
 */
export function withoutCode(markdown, { spans = true } = {}) {
  const lines = markdown.replace(/<!--[\s\S]*?-->/g, blank).split('\n');
  let fence; // the open fence's marker, while inside a fenced block
  return lines
    .map((line) => {
      const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return '';
      }
      if (marker) {
        fence = marker;
        return '';
      }
      // a run of backticks, then text, then a run of the same length
      return spans ? line.replace(/(?<!`)(`+)(?!`)(.*?[^`])\1(?!`)/g, blank) : line;
    })
    .join('\n');
}

/** GitHub's id for a heading's text: lowercased, punctuation dropped, each space a dash. */
export function slug(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // a link or image: its text
    .replace(/<[^>]+>/g, '')
    .replace(/[`*~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/** The ids a Markdown file's headings get on GitHub (a repeated one gets `-1`, `-2`…), and its HTML ids. */
export function anchors(markdown) {
  const ids = new Set();
  const seen = new Map();
  // a heading keeps its code spans' text
  for (const line of withoutCode(markdown, { spans: false }).split('\n')) {
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/)?.[1];
    if (heading !== undefined) {
      const base = slug(heading);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      ids.add(n ? `${base}-${n}` : base);
    }
    for (const m of line.matchAll(/<a\s[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) ids.add(m[1]);
  }
  return ids;
}

/** Each link target in `markdown`, with its 1-based line: inline links, images, reference definitions. */
export function links(markdown) {
  const found = [];
  withoutCode(markdown)
    .split('\n')
    .forEach((line, i) => {
      // `](target)` or `](target "title")`, also inside a link's text (an image in a link)
      for (const m of line.matchAll(
        /\]\(\s*(<[^>]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g,
      ))
        found.push({ target: m[1].replace(/^<|>$/g, ''), line: i + 1 });
      const definition = line.match(/^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/)?.[1];
      if (definition) found.push({ target: definition.replace(/^<|>$/g, ''), line: i + 1 });
      for (const m of line.matchAll(/<(?:a|img)\s[^>]*\b(?:href|src)=["']([^"']+)["']/gi))
        found.push({ target: m[1], line: i + 1 });
    });
  return found;
}

/** The git-visible files of `root` (tracked, or new and not ignored) that exist, as repo paths. */
function visibleFiles(root) {
  const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return [...new Set(out.split('\0').filter(Boolean))].filter((f) => existsSync(join(root, f)));
}

/**
 * The relative links of `root`'s Markdown files: how many files and links were read, and one
 * problem (`file:line: (target) …`) per link that does not resolve.
 */
export function checkDocLinks(root = ROOT) {
  const files = visibleFiles(root);
  const visible = new Set(files);
  const isDirectory = (path) => files.some((f) => f.startsWith(`${path}/`));
  const manifest = loadManifest(root);
  const markdown = files.filter((f) => f.endsWith('.md') && !findArtifact(manifest, f));
  const anchorsOf = new Map();
  const anchorsIn = (file) => {
    if (!anchorsOf.has(file)) anchorsOf.set(file, anchors(readFileSync(join(root, file), 'utf8')));
    return anchorsOf.get(file);
  };
  const problems = [];
  let checked = 0;
  for (const file of markdown) {
    for (const { target, line } of links(readFileSync(join(root, file), 'utf8'))) {
      // a URL (`https:`, `mailto:`) or a protocol-relative one
      if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) continue;
      checked++;
      const where = `${file}:${line}: (${target})`;
      const [pathPart = '', ...rest] = target.split('#');
      let path, anchor;
      try {
        path = decodeURIComponent(pathPart.split('?')[0] ?? '');
        anchor = decodeURIComponent(rest.join('#')).toLowerCase();
      } catch {
        problems.push(`${where} is not a valid URL`);
        continue;
      }
      // GitHub reads `/x` from the repository root, and anything else from the file's directory
      const resolved = path
        ? posix.normalize(
            path.startsWith('/') ? path.slice(1) : posix.join(posix.dirname(file), path),
          )
        : file;
      const repoPath = resolved.replace(/\/+$/, '') || '.';
      if (repoPath === '..' || repoPath.startsWith('../')) {
        problems.push(`${where} points outside the repository`);
        continue;
      }
      if (repoPath !== '.' && !visible.has(repoPath) && !isDirectory(repoPath)) {
        problems.push(
          `${where}: ${repoPath} is not in the repository (renamed, deleted or ignored?)`,
        );
        continue;
      }
      // only a Markdown file has heading ids (`code.ts#L10` is GitHub's line link)
      const isMarkdown = repoPath.endsWith('.md') && visible.has(repoPath);
      if (anchor && isMarkdown && !anchorsIn(repoPath).has(anchor))
        problems.push(`${where}: ${repoPath} has no heading with the id "${anchor}"`);
    }
  }
  return { files: markdown.length, links: checked, problems };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, links: count, problems } = checkDocLinks();
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) {
    console.error(
      `${problems.length} broken Markdown link(s): fix the link, or the heading or file it names`,
    );
    process.exitCode = 1;
  } else {
    console.log(`✓ ${count} relative links in ${files} Markdown files resolve`);
  }
}
