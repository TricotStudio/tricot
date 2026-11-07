import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { columns, fit } from '../src/cli/switcher/strip';
import { wrapLine } from '../src/cli/switcher/threadsView';

// Wrapping and cutting text in the terminal measure each character once, its
// columns added to those before it (T26), where they measured the whole line
// again for each character. The cuts must be the same: the old ways are kept
// here as they were, and both run on the same lines (prose, long words, URLs,
// code, list items, CJK, emoji with joiners, variation selectors and skin
// tones, flags, combining accents, other spaces, control characters, lone
// surrogates) at every width from 1 to 120.

// ---- the old ways, as they were before T26 ---------------------------------------------

function oldColumns(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || (code >= 0x300 && code < 0x370) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) continue;
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
  }
  return width;
}

function oldFit(text: string, room: number): string {
  if (oldColumns(text) <= room) return text;
  if (room <= 0) return '';
  let out = '';
  for (const ch of text) {
    if (oldColumns(out + ch) > room - 1) break;
    out += ch;
  }
  return `${out}…`;
}

// Undefined where it never returned: at a width of 2, a wide character right
// after a pad of one column left the row empty and the rest as it was.
function oldWrapLine(line: string, width: number): string[] | undefined {
  const out: string[] = [];
  const hang = /^ *(?:[-*+]|\d+[.)]) +/.exec(line)?.[0] ?? /^ */.exec(line)![0];
  const pad = ' '.repeat(Math.min(hang.length, Math.floor(width / 2)));
  let rest = line.trimEnd();
  while (oldColumns(rest) > width) {
    let head = '';
    let space = -1;
    for (const ch of rest) {
      if (oldColumns(head + ch) > width) break;
      if (ch === ' ') space = head.length;
      head += ch;
    }
    const cut = rest[head.length] === ' ' ? head.length : space > pad.length ? space : head.length || String.fromCodePoint(rest.codePointAt(0)!).length;
    out.push(rest.slice(0, cut).trimEnd());
    const remainder = rest.slice(cut).trimStart();
    if (!remainder) return out;
    if (pad + remainder === rest) return undefined;
    rest = pad + remainder;
  }
  out.push(rest);
  return out;
}

// ---- the lines -------------------------------------------------------------------------

const PIECES = [
  'The quick brown fox jumps over the lazy dog.',
  'Should the export include closed cards, and in which order should the columns of each be written?',
  'Pneumonoultramicroscopicsilicovolcanoconiosis',
  'x'.repeat(130),
  'https://github.com/example/tricot/blob/main/src/cli/switcher/threadsView.ts?plain=1#L130-L152',
  'const cut = rest[head.length] === " " ? head.length : space > pad.length ? space : head.length;',
  '中文的段落没有空格所以只能在字中间切开。',
  '日本語のテキストとカタカナ、ひらがな。',
  '한국어 문장은 띄어쓰기가 있습니다',
  'ＡＢＣ１２３ halfwidth ｶﾀｶﾅ',
  '👩‍💻 at work 👨‍👩‍👧‍👦 and 🏳️‍🌈',
  '👍🏽👋🏿 waves ✋🏻',
  '❤️ ☺️ ✔️ ⚠️ with VS16, ︎text︎ with VS15',
  '🇫🇷🇯🇵🇺🇸 flags 🇬🇧',
  'Café résumé Ångström',
  'Z̤͔ͧ̑̓ä͖̭̈̇lͮ̒ͫǧ̗͚̚o',
  'non breaking spaces and thin ones',
  '中　文　ideographic　spaces',
  'zero​width​space and ﻿bom',
  'tabs\tand\tcontrol \u001b[31mred\u001b[0m \u0007 bell',
  '␉ ␛ ␇ pictures of control characters �',
  'lone \ud800 high and \udc00 low surrogates \ud83d',
  '𠀀𠀁𠀂 supplementary ideographs 𪚥',
  'a    b     c      d',
  '  ',
  '',
];

const LEADS = ['', ' ', '  ', '    ', '        ', '- ', '* ', '+ ', '  - ', '1. ', '12) ', '-', '-   ', '　'];
const SEPARATORS = [' ', ' ', ' ', '', '  ', ' ', '‍', '́', '️'];

// The same lines on every run.
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpus(): string[] {
  const next = random(26);
  const pick = <T>(list: T[]): T => list[Math.floor(next() * list.length)];
  const words = PIECES.flatMap((piece) => piece.split(' ')).filter(Boolean);
  const lines = [...PIECES, ...LEADS.flatMap((lead) => PIECES.map((piece) => lead + piece))];
  for (let i = 0; i < 200; i++) {
    let line = pick(LEADS);
    const count = 1 + Math.floor(next() * 24);
    for (let w = 0; w < count; w++) line += (w ? pick(SEPARATORS) : '') + pick(words);
    lines.push(next() < 0.2 ? `${line}   ` : line);
  }
  return lines;
}

const LINES = corpus();
const WIDTHS = Array.from({ length: 120 }, (_, i) => i + 1);

describe('measuring text in the terminal', () => {
  it('counts the columns as it did, of every character and of every line', () => {
    for (let code = 0; code <= 0x10ffff; code++) {
      const ch = String.fromCodePoint(code);
      if (columns(ch) !== oldColumns(ch)) assert.fail(`U+${code.toString(16)}`);
    }
    for (const line of LINES) assert.equal(columns(line), oldColumns(line), JSON.stringify(line));
  });
});

describe('wrapping a line', () => {
  it('cuts every line where it did, at every width from 1 to 120', () => {
    let compared = 0;
    for (const line of LINES) {
      for (const width of [0, ...WIDTHS]) {
        const old = oldWrapLine(line, width);
        if (!old) continue; // never returned: the next test
        assert.deepEqual(wrapLine(line, width), old, `${JSON.stringify(line)} at ${width}`);
        compared++;
      }
    }
    assert.ok(compared > 50_000, `compared ${compared}`);
  });

  it('cuts long paragraphs where it did', () => {
    const next = random(126);
    const words = LINES.flatMap((line) => line.split(' ')).filter(Boolean);
    for (const lead of ['', '    ', '- ', '12) ']) {
      let paragraph = lead;
      while (paragraph.length < 3_000) paragraph += `${words[Math.floor(next() * words.length)]} `;
      for (const width of [1, 3, 7, 20, 40, 79, 115, 120]) assert.deepEqual(wrapLine(paragraph, width), oldWrapLine(paragraph, width), `${JSON.stringify(lead)} at ${width}`);
    }
  });

  it('puts one character after the pad where a wide one does not fit beside it, where it went on forever', () => {
    assert.equal(oldWrapLine('- 中文', 2), undefined);
    assert.deepEqual(wrapLine('- 中文', 2), ['-', ' 中', ' 文']);
    assert.deepEqual(wrapLine('  中文', 2), ['', ' 中', ' 文'], 'the first row as it was');
    let hung = 0;
    for (const line of LINES) {
      if (oldWrapLine(line, 2)) continue;
      hung++;
      const rows = wrapLine(line, 2);
      assert.ok(
        rows.slice(1).every((row) => /^ \S/u.test(row) || !row.startsWith(' ')),
        `each row after the first holds a character after the pad: ${JSON.stringify(line)} ${JSON.stringify(rows)}`,
      );
      assert.equal(rows.join('').replace(/\s/g, ''), line.replace(/\s/g, ''), `nothing lost: ${JSON.stringify(line)}`);
    }
    assert.ok(hung > 0);
  });
});

describe('cutting text to fit', () => {
  it('gives what it gave, byte for byte, at every room', () => {
    for (const line of LINES) {
      for (const room of [Number.NaN, -2, -1, 0, ...WIDTHS, 130]) assert.equal(fit(line, room), oldFit(line, room), `${JSON.stringify(line)} in ${room}`);
    }
  });
});
