// Legibility advice returned to agents alongside successful writes. People
// read about 240 words a minute, roughly a fifteenth of the speed agents
// write, so these nudge agents towards short cards, structured visuals and
// writing that reads like a colleague's. Advice never blocks a write.

import { blockLabel } from './canvas';
import { listNames, samePerson } from './format';
import type { Actor, Block } from './types';
import { saying, type Sayer } from './words';

const WORDS_PER_MINUTE = 240;
const NOTE_WORDS = 200;

export function wordCount(text: string | undefined): number {
  return text?.trim() ? text.trim().split(/\s+/).length : 0;
}

export function readingTime(words: number): string {
  const seconds = Math.round((words / WORDS_PER_MINUTE) * 60);
  return seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
}

// Patterns a script can see reliably in text people read. Each is a nudge
// towards how a colleague would write it; a miss costs little, a false nudge
// costs trust, so every rule is narrow.
const WALL_WORDS = 130;
const OPENER_LABELS =
  'Built|Done|Fixed|Added|Implemented|Completed|Shipped|Verified|Tested|Status|Result|Results|Summary|Update|Changes|Building|Ready for review|Blocked|Unblocked|TL;DR';
const LABEL_OPENER = new RegExp(`^\\s*(?:\\*\\*)?(${OPENER_LABELS})(?::\\*\\*|\\*\\*:|:)`, 'i');
const COMMIT_OPENER = /^\s*Committed\s+(?:as|in|at)\s+`?[0-9a-f]{7,40}\b/i;
const RAW_ID = /\[(?:thread )?id: [^\]\s][^\]]*\]/i;
const TALLY_PAIR = /(?<![\w/.-])(\d{2,})\s*\/\s*\1(?![\w/])/;
const TALLY_NEAR = /\b(?:tests?|specs?|pass(?:es|ed|ing)?|green)\b/i;
const TALLY_COUNT = /\b\d{2,}\s+(?:tests?|specs?)\s+(?:pass(?:es|ed)?|green)\b|\b\d{2,}\s+passing\b/i;
const FLATTERY = /^\s*(?:(?:great|excellent|fantastic|wonderful) (?:question|point|catch)\b|you'?re (?:absolutely|totally|completely) right\b)/i;

// Code is quoted, not written: a hash or an id inside it is meant to be there.
function proseOf(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

// `words` is who says the texts that a tool group may add to (`advice.raw-id`, words.ts).
export function peopleTextAdvice(text: string | undefined, what: string, words?: Sayer): string[] {
  if (!text) return [];
  const prose = proseOf(text);
  const advice: string[] = [];
  const first = text.trimStart().split('\n')[0];

  const label = LABEL_OPENER.exec(first);
  const commit = COMMIT_OPENER.exec(first);
  if (label || commit) {
    const opener = label ? `${label[1]}:` : 'Committed as …';
    advice.push(
      `This ${what} opens with a label ("${opener}"). Start with a sentence that says what it means for the person, such as "The retry change is ready for you to review.", then what you did.`,
    );
  }
  if (FLATTERY.test(prose)) {
    advice.push(`This ${what} opens with praise. Start with the answer instead; a person reads the praise as filler.`);
  }
  const id = RAW_ID.exec(prose);
  if (id) {
    advice.push(
      saying(words, 'advice.raw-id', [
        ['id', `This ${what} shows a raw id ("${id[0]}"), which means nothing to a person. Name the thing instead`],
        ['end', '.'],
      ]),
    );
  }
  const tally = tallyIn(prose);
  if (tally) {
    advice.push(
      `This ${what} quotes a test tally ("${tally}"). A person needs to know whether the tests pass, so say that and keep the numbers for the canvas.`,
    );
  }
  const wall = Math.max(...prose.split('\n').map(wordCount));
  if (wall >= WALL_WORDS) {
    advice.push(
      `This ${what} has a paragraph of ${wall} words with no line break. Break it where the thought changes, and put what matters to the person first.`,
    );
  }
  return advice;
}

function tallyIn(prose: string): string | undefined {
  const pair = TALLY_PAIR.exec(prose);
  if (pair && TALLY_NEAR.test(prose.slice(Math.max(0, pair.index - 30), pair.index + pair[0].length + 30))) return pair[0];
  return TALLY_COUNT.exec(prose)?.[0];
}

export function noteAdvice(text: string): string[] {
  const words = wordCount(text);
  if (words <= NOTE_WORDS) return [];
  return [
    `This note is ${words} words (about ${readingTime(words)} to read). Split it into a table, task list or diagram, or trim it to what matters.`,
  ];
}

// Words that mark a version rather than say what a block shows: "Connect
// screen (mock v2)" is the same thing as "Connect screen".
const VERSION_WORDS = new Set([
  'mock', 'mocks', 'mockup', 'mockups', 'new', 'updated', 'revised', 'latest', 'final', 'draft', 'copy', 'version',
]);
const SIMILAR = 0.6;

export function titleWords(title: string): Set<string> {
  const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return new Set(words.filter((w) => w && !VERSION_WORDS.has(w) && !/^v\d+$/.test(w)));
}

// Whether two titles name the same thing: one's words contain the other's, or
// most of their words are shared (Jaccard).
export function similarTitles(a: string, b: string): boolean {
  const [x, y] = [titleWords(a), titleWords(b)];
  if (x.size === 0 || y.size === 0) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  if (shared === Math.min(x.size, y.size)) return true;
  return shared / (x.size + y.size - shared) >= SIMILAR;
}

// An agent iterating on something tends to add each version beside the last,
// so a canvas fills with stale copies. Only the agent's own blocks count.
export function duplicateAdvice(added: Block, blocks: readonly Block[], actor: Actor): string[] {
  if (!added.title) return [];
  const matches = blocks
    .filter((b) => b.id !== added.id && b.type === added.type && b.title)
    .filter((b) => b.author.kind === actor.kind && samePerson(b.author.name, actor.name))
    .filter((b) => similarTitles(b.title!, added.title!))
    .slice(-3)
    .reverse();
  if (matches.length === 0) return [];
  const names = listNames(matches.map((b) => `${blockLabel(b)} [id: ${b.id}]`));
  const which = matches.length === 1 ? 'it, update that block' : 'one of them, update that one';
  return [`You already have ${names} here. If this is a new version of ${which} instead and remove this one with remove_item.`];
}

// Boxes are fractions of the image, so they stay put when it is replaced,
// whether or not what they pointed at moved.
export function replacedImageNotice(boxes: number): string {
  if (boxes === 0) return '';
  return boxes === 1
    ? '1 box is pinned on this image: check it still points at the right part.'
    : `${boxes} boxes are pinned on this image: check they still point at the right parts.`;
}

export function withAdvice(text: string, advice: string[]): string {
  if (advice.length === 0) return text;
  return `${text}\n\nAdvice (nothing was rejected):\n${advice.map((a) => `- ${a}`).join('\n')}`;
}
