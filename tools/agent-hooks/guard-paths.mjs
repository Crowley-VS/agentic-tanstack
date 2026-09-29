#!/usr/bin/env node
// Claude Code PreToolUse hook (Edit|Write|MultiEdit|NotebookEdit).
// Blocks edits to generated files listed in .agents/generated.json and tells the
// agent which command regenerates them. Exit 2 = block (stderr is shown to Claude).
// Fails CLOSED on malformed input: a broken hook must not silently allow edits.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { findArtifact, isTracked, loadManifest, repoRoot, toRepoPath } from '../lib/generated.mjs';

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch (err) {
  block(`guard-paths: could not parse hook input (${err.message}); refusing the edit to be safe.`);
}

const toolInput = input?.tool_input ?? {};
const filePath = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
if (typeof filePath !== 'string' || filePath.length === 0) process.exit(0);

const cwd = typeof input.cwd === 'string' && existsSync(input.cwd) ? input.cwd : process.cwd();
const absPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
// Resolve the root from the file's nearest existing directory (handles worktrees and Writes
// that create new directories).
let probeDir = dirname(absPath);
while (!existsSync(probeDir) && dirname(probeDir) !== probeDir) probeDir = dirname(probeDir);
const root = repoRoot(probeDir);

let manifest;
try {
  manifest = loadManifest(root);
} catch (err) {
  block(`guard-paths: .agents/generated.json is invalid (${err.message}). Fix it before editing.`);
}

const repoPath = toRepoPath(root, absPath);
const artifact = findArtifact(manifest, repoPath);
if (!artifact) process.exit(0);

if (artifact.protect === 'tracked' && !isTracked(root, repoPath)) {
  // e.g. a freshly generated, not-yet-committed migration may still be edited.
  process.exit(0);
}

block(
  [
    `BLOCKED: ${repoPath} is generated (${artifact.id}) and must not be edited by hand.`,
    artifact.description ? `What it is: ${artifact.description}` : '',
    `Change its source instead, then regenerate with: ${artifact.regen}`,
  ]
    .filter(Boolean)
    .join('\n'),
);
