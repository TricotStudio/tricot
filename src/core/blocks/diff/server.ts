// What only REST and MCP need of diff blocks: the fields and schemas they read, and what agents are told.
// The web build leaves this file out (see vite.config.ts), so zod and the advice stay on the server.

import { z } from 'zod';
import type { DiffTypes } from './index';
import { type DiffSide, diffAdvice, DiffError, type DiffFile, countText, diffDigest, diffTotals, lineAt, lineQuote, matchFocus, readPatch, shownLines } from './diff';
import type { AgentHalf, AgentIo, PeopleHalf, ServerHalf } from '../kind';
import { missing } from '../shared';
import { BoardError } from '../../store/errors';
import { blockLabel } from '../../canvas';
import { clip, listNames } from '../../format';
import { LIMITS } from '../../store/validate';
import type { Block } from '../../types';
import { repoPatch } from './repo';

// The files to open first, as the patch names them. Paths it doesn't have are left out.
function focusOn(files: DiffFile[], focus: string[] | undefined): { focus?: string[] } {
  if (!focus) return {};
  if (focus.length > LIMITS.focus) throw new BoardError(`Focus on at most ${LIMITS.focus} files.`);
  const { paths } = matchFocus(files, focus);
  return paths.length ? { focus: paths } : {};
}

// A diff block's content from the patch an agent sent: parsed into files and
// kept within MAX_PATCH, with its focus as the patch names those files.
function diffContent(patch: string, focus: string[] | undefined): { patch: string; files: DiffFile[]; focus?: string[] } {
  try {
    const read = readPatch(patch);
    return { ...read, ...focusOn(read.files, focus) };
  } catch (error) {
    if (error instanceof DiffError) throw new BoardError(error.message);
    throw error;
  }
}

// The fields that name a diff in a repository instead of sending it, the same for add_block and update_block.
const FROM_REPO = {
  repo: z.string().optional().describe("Diff blocks, instead of patch: a git repository's folder on this computer (full path or ~/…, inside your home folder); Tricot runs git diff there"),
  range: z.string().optional().describe('Diff blocks, with repo: commits to compare, A..B or A...B, or one commit for its own changes'),
  against: z.string().optional().describe('Diff blocks, with repo: the commit the working tree is compared to, staged, unstaged and new files together (the default: HEAD)'),
  paths: z.array(z.string()).optional().describe("Diff blocks, with repo: only these files or folders, from the repository's top folder"),
};
const REPO_FIELDS = Object.keys(FROM_REPO);

// The patch for a diff named in a repository, read with git, in place of the fields that named it.
async function fill(args: Record<string, unknown>, io: AgentIo, block?: Block): Promise<Record<string, unknown> | undefined> {
  if (!REPO_FIELDS.some((name) => args[name] !== undefined)) return undefined;
  if (block && block.type !== 'diff') throw new BoardError(`${blockLabel(block)} isn't a diff: repo, range, against and paths make a diff's patch.`);
  if (args.repo === undefined) throw new BoardError("Pass repo with range, against or paths: the repository's folder, for Tricot to diff.");
  if (args.patch !== undefined) throw new BoardError('Send patch or repo, not both.');
  if (!io.localFiles) throw new BoardError('This server is reachable from other machines, so repo is disabled. Send patch.');
  const patch = await repoPatch({ repo: args.repo as string, range: args.range as string | undefined, against: args.against as string | undefined, paths: args.paths as string[] | undefined });
  const { repo: _repo, range: _range, against: _against, paths: _paths, ...rest } = args;
  return { ...rest, patch };
}

export const agent: AgentHalf<DiffTypes> = {
  addShape: {
    patch: z.string().optional().describe('Diff blocks: a unified diff, as git diff or git show prints it'),
    ...FROM_REPO,
    focus: z.array(z.string()).optional().describe('Diff blocks: paths of the files that matter most, opened first'),
  },
  updateShape: {
    patch: z.string().optional().describe('Diff blocks: a new unified diff, replacing the one shown; the old one is kept as a version'),
    ...FROM_REPO,
    focus: z.array(z.string()).optional().describe('Diff blocks: the files to open first'),
  },
  docs: {
    brief: 'diff → repo (Tricot runs git diff) or patch',
    add: "diff → repo (your repository's folder: Tricot diffs it itself, by default your uncommitted work against HEAD) or patch (a unified diff, as git diff or git show prints it), plus optional focus (paths of the files that matter, opened first). People see it file by file and comment on its lines",
    more: 'When you send code work for review, add a diff block too (type diff, with your repository as repo rather than the patch as text), next to the screenshots, with the files that matter as focus.',
    update: 'patch or repo (with range, against, paths), focus',
  },
  fill,
  read(args) {
    if (args.patch === undefined) throw missing('diff', "patch (a unified diff: the output of git diff or git show), or repo (a git repository's folder, for Tricot to diff)");
    const patch = args.patch as string;
    const focus = args.focus as string[] | undefined;
    return () => ({ type: 'diff', patch, focus });
  },
  patch: (args) => ({ patch: args.patch as string | undefined, focus: args.focus as string[] | undefined }),
  adviceAdded: (block, args) => diffAdvice(block.files, args.focus as string[] | undefined),
  adviceUpdated: (block, args) => (args.patch !== undefined || args.focus !== undefined ? diffAdvice(block.files, args.focus as string[] | undefined) : []),
  pinShape: {
    file: z.string().optional().describe("A diff's file, by its path (or the end of it), with line"),
    line: z.number().int().min(1).optional().describe("With file: the line's number in the diff, as the file reads after the change"),
    side: z.enum(['new', 'old']).optional().describe('With file and line: "old" for a removed line, numbered as the file read before (default "new")'),
  },
  pinPart(_block, args) {
    if (args.file === undefined && args.line === undefined && args.side === undefined) return undefined;
    if (args.file === undefined || args.line === undefined) throw new BoardError('Pin a diff line with file and line (and side "old" for a removed line).');
    if (['text', 'item', 'row', 'to_row', 'column', 'to_column', 'node', 'to_node', 'box'].some((name) => args[name] !== undefined)) {
      throw new BoardError('Pin a diff line with file, line and side only.');
    }
    return { kind: 'line', file: args.file as string, line: args.line as number, side: args.side as DiffSide | undefined };
  },
};

// People pin its lines, though they don't add diffs: a line, on its new side
// unless said. A code block's lines are the same (its path as the file, and
// `last` for a range).
export const people: PeopleHalf = {
  parts: {
    line: z.object({ kind: z.literal('line'), file: z.string(), line: z.number().int().min(1), side: z.enum(['new', 'old']).optional(), last: z.number().int().min(1).optional() }),
  },
};

export const server: ServerHalf<DiffTypes> = {
  patchFields: ['patch', 'focus'],

  create: (input) => diffContent(input.patch, input.focus),

  change({ block, patch, restoring }) {
    // A diff's version comes back as it was kept, with any changes left out to fit.
    let content: { patch: string; files: DiffFile[]; focus?: string[] } | undefined;
    if (restoring) content = { patch: restoring.patch, files: restoring.files, focus: restoring.focus };
    else if (patch.patch !== undefined) content = diffContent(patch.patch, patch.focus ?? block.focus);
    else if (patch.focus !== undefined) content = { patch: block.patch, files: block.files, ...focusOn(block.files, patch.focus) };
    if (!content) return undefined;
    const changed = content;
    return {
      apply() {
        block.patch = changed.patch;
        block.files = changed.files;
        if (changed.focus?.length) block.focus = changed.focus;
        else delete block.focus;
      },
    };
  },

  describe(before, after) {
    const parts: string[] = [];
    if (before.patch !== after.patch) {
      const totals = diffTotals(after.files);
      parts.push(`replaced the patch: now ${totals.files} file${totals.files === 1 ? '' : 's'}, ${countText(totals.additions, totals.deletions)}`);
    }
    const focus = after.focus ?? [];
    if ((before.focus ?? []).join('\u0000') !== focus.join('\u0000')) {
      parts.push(focus.length ? `set the files in focus to ${focus.map((f) => clip(f, 60)).join(', ')}` : 'cleared the files in focus');
    }
    return parts;
  },
  snapshot: (block) => ({ patch: block.patch, files: block.files, focus: block.focus }),
  restorePatch: () => ({}), // its patch and files go back as kept, which change sets

  digest: (block, full) => diffDigest(block, full),
  searchText: (block) => block.files.map((file) => file.path), // the files it changes, not every line
  forPeople(block) {
    const { patch: _patch, ...rest } = block;
    return rest;
  },

  anchor(block, part) {
    if (part.kind !== 'line') return undefined;
    const side: DiffSide = part.side === 'old' ? 'old' : 'new';
    const path = matchFocus(block.files, [part.file ?? '']).paths[0];
    const file = block.files.find((f) => f.path === path);
    if (!file) {
      const names = listNames(block.files.slice(0, 20).map((f) => f.path));
      throw new BoardError(`${blockLabel(block)} has no file "${clip(part.file ?? '', 80)}". Its files: ${names}.`);
    }
    if (file.omitted) throw new BoardError(`${file.path} is listed in ${blockLabel(block)} without its changes, left out to fit, so its lines can't be pinned.`);
    const text = Number.isInteger(part.line) ? lineAt(file, side, part.line) : undefined;
    if (text === undefined) {
      const other = side === 'new' ? 'old' : 'new';
      const there = Number.isInteger(part.line) && lineAt(file, other, part.line) !== undefined;
      const shown = shownLines(file, side);
      throw new BoardError(
        `${file.path} has no ${side} line ${part.line} in ${blockLabel(block)}${there ? `, but has ${other === 'old' ? 'an' : 'a'} ${other} one: pass side "${other}"` : ''}. ` +
          (shown ? `The patch shows its ${side} lines ${shown}.` : `The patch shows no ${side} lines of it.`),
      );
    }
    return { anchor: { kind: 'line', file: file.path, line: part.line, side }, quote: lineQuote(text) };
  },

  agent,
  people,
};
