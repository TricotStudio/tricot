// Legibility advice returned to agents alongside successful writes. People
// read about 240 words a minute, roughly a fifteenth of the speed agents
// write, so these nudge agents towards short cards, structured visuals and
// writing that reads like a colleague's. Advice never blocks a write.

import { blockLabel } from './canvas';
import { listNames, samePerson } from './format';
import type { Actor, Block, Decision } from './types';

const WORDS_PER_MINUTE = 240;
const CONTEXT_WORDS = 120;
const NOTE_WORDS = 200;
const DESCRIPTION_WORDS = 60;
const FINDING_WORDS = 150;

export function wordCount(text: string | undefined): number {
  return text?.trim() ? text.trim().split(/\s+/).length : 0;
}

function readingTime(words: number): string {
  const seconds = Math.round((words / WORDS_PER_MINUTE) * 60);
  return seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
}

function list(items: string[]): string {
  return items.map((item) => `"${item}"`).join(', ');
}

export function decisionAdvice(input: {
  context?: string;
  options?: { label: string; description?: string }[];
  recommend?: string;
}): string[] {
  const advice: string[] = [];
  const contextWords = wordCount(input.context);
  if (contextWords > CONTEXT_WORDS) {
    advice.push(
      `The context is ${contextWords} words (about ${readingTime(contextWords)} to read). Keep the card to what changes the decision, and move detail onto the decision canvas as a table, diagram or note.`,
    );
  }
  const options = input.options ?? [];
  if (options.length === 0) {
    advice.push('There are no options. Offer 2–4 concrete ones so a person can answer with a click.');
  } else if (options.length > 4) {
    advice.push(`${options.length} options is a lot to weigh at once. Keep the 2–4 strongest.`);
  }
  if (options.length >= 2 && !input.recommend) {
    advice.push('Add a recommendation with a reason, so people can see where you lean and why.');
  }
  if (options.some((o) => wordCount(o.description) > DESCRIPTION_WORDS)) {
    advice.push('Some option descriptions are long. Put trade-offs in pros and cons instead.');
  }
  advice.push(...peopleTextAdvice(input.context, 'context'));
  return advice;
}

// People judge faster from what they can see than from what they read.
export function emptyCanvasAdvice(): string[] {
  return [
    'Its canvas is empty. Put what the person needs to see to decide on it: the options side by side, screenshots, tables or diagrams, each pinned to its option (add_block with decision_id and option, or blocks on post_decision next time).',
  ];
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

export function peopleTextAdvice(text: string | undefined, what: string): string[] {
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
      `This ${what} shows a raw id ("${id[0]}"), which means nothing to a person. Name the thing instead, or write #N for a decision and TN for a task so the board links it.`,
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

// Findings on different options only line up in the comparison when they
// report the same metric names.
export function findingAdvice(
  decision: Decision,
  finding: { optionId?: string; summary: string; metrics?: Record<string, string | number> },
): string[] {
  const advice: string[] = [];
  if (wordCount(finding.summary) > FINDING_WORDS) {
    advice.push('This finding is long. Lead with the result in a sentence or two, and put the data in metrics or a canvas table.');
  }
  if (!finding.optionId) return advice;

  const others = new Set(
    decision.findings
      .filter((f) => f.optionId && f.optionId !== finding.optionId && f.metrics)
      .flatMap((f) => Object.keys(f.metrics!)),
  );
  if (others.size === 0) return advice;
  const reported = Object.keys(finding.metrics ?? {});
  if (reported.length === 0) {
    advice.push(
      `Other options report ${list([...others])}. Report the same metrics for option ${finding.optionId} so they line up in the comparison.`,
    );
    return advice;
  }
  const missing = [...others].filter((key) => !reported.includes(key));
  const unmatched = reported.filter((key) => !others.has(key));
  if (missing.length) {
    advice.push(`Option ${finding.optionId} is missing ${list(missing)}, which other options report.`);
  }
  if (unmatched.length) {
    advice.push(
      `${list(unmatched)} won't line up with the other options' metrics (${list([...others])}). Reuse their names where they mean the same thing.`,
    );
  }
  return advice;
}

// Names are matched loosely, so a misspelt name just waits forever.
export function askAdvice(names: string[], people: string[]): string[] {
  const known = new Set(people.map((p) => p.trim().toLowerCase()));
  const unknown = names.filter((name) => !known.has(name.trim().toLowerCase()));
  if (unknown.length === 0) return [];
  const here = people.length ? `People here: ${people.join(', ')}.` : 'Nobody has acted on this board yet.';
  return [
    `${list(unknown)} ${unknown.length === 1 ? 'has' : 'have'} not acted on this board yet. ${here} Check the spelling; they'll see the question under Needs you once they open the board under that name.`,
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
