// Home's conversation in the Tricot tab, drawn (homeStream.ts gathers it,
// chatView.ts lays it out and scrolls it): each item's lines, and the yarn in
// a narrow column at their left.
//
//    │   ── Today ─────────────────────────────────────
//    •   You · 2:14 PM
//    │       Fix sign-in on mobile, the button hides.
//    ├─╮     ↳ Sign-in on mobile · sent on to Claude  ■ At work
//    • │   Router  agent · 2:15 PM
//    │ │       I sent it on to Claude, who is on it.
//    │ │   ── Since you were last here ──────────────────
//    │ •   ■ Sign-in on mobile · Claude asks you · 2:20 PM
//    │ │       Which tablets: iPads alone, or Android too?
//    │ ●   ■ Sign-in on mobile · Done · 2:31 PM
//    │         Fixed on phones and iPads.
//
// What was said is who said it (You, a person, or an agent's name with
// "agent" after it), where it was asked on its thread's first message, and
// the time in the person's own clock, the day being said between them; under
// it, its text as a thread's messages are drawn (threadsView.ts messageRows).
// A card under an ask names the thread it was sent on to and its agent (or
// that its agent took the ask's own thread on), the title giving way first,
// and where its work stands after a square in that colour. A relay is led by
// a square in where its thread stands now and its thread's name (a part's
// card by its number, its page linked), with what it says of it: an agent's
// question in full, the person's answer once there is one, work waiting for
// their review with its summary in full and where the verdict is given (the
// board: a reply here is a plain reply, which leaves it waiting), folding to
// the verdict once there is one, a thread's latest word (a reply) in two lines
// at most, folding as a question does once answered, and so an agent's latest
// word in a pairing, led by the piece and where it is, a thread done with the
// first line of its summary, a card blocked with what holds it.
// Relays that came while the person was away sit under one head, by group,
// one line each, a question in full once chosen. ❯ marks the item chosen.
//
// The yarn: the conversation's strand runs down the first column, with a
// stitch at each message. Each thread an agent owns has a lane beside it, in
// the colour of where its work stands, which knits off the conversation's at
// the card that sent it on (├─╮), stitches into each of its relays (•) and is
// tied off with a knot (●) where its work was done; a strand still at work
// runs to the foot, and one begun before the first item runs from the top.
// The lanes are core/homeConversation.ts's, by when each ran. A stream too
// narrow for them, or for the lanes it has, keeps one column of marks beside
// the conversation's strand instead: where a thread knits off, a relay and a
// knot, each in its colour.
//
// Colours: where the terminal draws 24-bit colour, the page's status colours
// (where work stands: to do, in progress, in review, blocked, done) for the
// terminal's light or dark background; elsewhere the nearest of the 256.
// Where it draws none (NO_COLOR), the yarn and the squares are plain
// characters, each lane's character saying where its work stands (| at work
// or done, ! waiting on a person or their review, : not started), and words
// say the rest.
import { samePerson } from '../../core/format';
import { answeredWords, earlierWords, firstLine, ownName, relayWords, sentStateWords, verdictWords, type Strand, type StrandTone } from '../../core/homeConversation';
import { columns, fit, type Rgb } from './strip';
import { BOLD, DIM, alertOf, cutParts, type Part } from './tabView';
import type { Divider, StreamItem } from './homeStream';
import { messageRows, safe, type CardLink } from './threadsView';

// How much colour the terminal draws: 24-bit, the 256, or none at all (NO_COLOR).
export type Colours = 'true' | '256' | 'none';

export interface Look {
  colours: Colours;
  light: boolean; // the terminal's background is light
}

type Tone = StrandTone | 'blocked';

// The page's status colours (web/themes/light.css and dark.css, styles/base.css --status-*): in progress, in review
// (waiting on a person, a question or their review), to do, done and blocked, for a light and a dark background, and
// the nearest of the 256 to each.
const IN_REVIEW: { light: [Rgb, number]; dark: [Rgb, number] } = { light: [[0x7a, 0x4f, 0xc9], 98], dark: [[0xa9, 0x88, 0xe6], 141] };
const TONES: Record<Tone, { light: [Rgb, number]; dark: [Rgb, number] }> = {
  working: { light: [[0x3b, 0x6f, 0xd6], 68], dark: [[0x7a, 0xa2, 0xf0], 111] },
  waiting: IN_REVIEW,
  review: IN_REVIEW,
  todo: { light: [[0x9a, 0x9a, 0x93], 247], dark: [[0x85, 0x85, 0x7f], 244] },
  done: { light: [[0x2f, 0x8a, 0x57], 29], dark: [[0x5c, 0xc0, 0x8a], 78] },
  blocked: { light: [[0xa3, 0x39, 0x2c], 124], dark: [[0xf2, 0x96, 0x8a], 210] },
};

// A tone's colour as an SGR foreground, or none where the terminal draws none.
export function toneSgr(tone: Tone, look: Look): string | undefined {
  if (look.colours === 'none') return undefined;
  const [rgb, n] = TONES[tone][look.light ? 'light' : 'dark'];
  return look.colours === 'true' ? `38;2;${rgb.join(';')}` : `38;5;${n}`;
}

const FANCY = { trunk: '│', stitch: '•', branch: '├', across: '─', knit: '╮', knot: '●', mark: '╴', square: '■', card: '↳', rule: '─', check: '✓ ' };
const PLAIN = { trunk: '|', stitch: '*', branch: '+', across: '-', knit: '.', knot: 'o', mark: '-', square: '', card: '->', rule: '-', check: '' };
const glyphsOf = (look: Look) => (look.colours === 'none' ? PLAIN : FANCY);

// A lane in plain characters says where its work stands.
const PLAIN_LANE: Record<Tone, string> = { working: '|', waiting: '!', review: '!', todo: ':', done: '|', blocked: '!' };

// Where a review's verdict is given: on the board, as the terminal has no buttons and a reply is a plain one.
export const REVIEW_HINT = 'Approve it or send it back on the board: a reply here leaves it waiting.';

// The alert colour, or bold where the terminal draws no colour.
const alert = (look: Look) => (look.colours === 'none' ? BOLD : alertOf(look.light));

// The time in the person's own clock: "2:14 PM", or "14:14".
export const clock = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// ---- an item's lines --------------------------------------------------------------------

// A square in a tone's colour, then a space: none in plain characters.
function square(tone: Tone, look: Look): Part[] {
  const g = glyphsOf(look);
  return g.square ? [[g.square, toneSgr(tone, look)], [' ']] : [];
}

// A rule across the stream with a label in it: "── Today ────…".
function ruled(label: string, width: number, sgr: string | undefined, look: Look): Part[] {
  const g = glyphsOf(look);
  const lead = `  ${g.rule.repeat(2)} ${label} `;
  return [[lead, sgr], [g.rule.repeat(Math.max(0, width - 1 - columns(lead))), sgr]];
}

function dividerRow(divider: Divider, width: number, look: Look): Part[] {
  if (divider.kind === 'day') return ruled(divider.label, width, DIM, look);
  if (divider.kind === 'since') return ruled('Since you were last here', width, alert(look), look);
  if (divider.kind === 'away') {
    const [from, to] = [clock(divider.from), clock(divider.to)];
    const when = from === to ? from : `${from} – ${to}`;
    return cutParts([[`  ${divider.head}`, BOLD], [` · ${when}`, DIM]], Math.max(1, width - 1));
  }
  return [[`  ${divider.label}`, divider.needsYou ? `${BOLD};${alert(look)}` : DIM], [` · ${divider.count}`, DIM]];
}

// The columns parts take.
const used = (parts: Part[]) => parts.reduce((sum, [text]) => sum + columns(text), 0);

export interface HomeLineInput {
  width: number;
  me: string;
  sending: boolean; // on its way: its time says so
  selected: boolean;
  look: Look;
  card?: CardLink;
}

// An item's lines: what is written before it, then the item.
export function homeLines(item: StreamItem, { width, me, sending, selected, look, card }: HomeLineInput): Part[][] {
  const lines: Part[][] = (item.before ?? []).map((divider) => dividerRow(divider, width, look));
  const home = item.home!;
  const room = Math.max(1, width - 1);
  const mark: Part = selected ? ['❯ ', BOLD] : ['  '];
  const g = glyphsOf(look);
  if (home.kind === 'said') {
    const mine = item.author.kind === 'human' && samePerson(item.author.name, me);
    const head: Part[] = [mark, [mine ? 'You' : safe(item.author.name), BOLD], ...(item.author.kind === 'agent' ? ([['  agent', DIM]] as Part[]) : []), ...(home.tag ? ([[` · ${safe(home.tag)}`, DIM]] as Part[]) : []), [` · ${sending ? 'sending…' : clock(item.at)}`, DIM]];
    lines.push(cutParts(head, room), ...messageRows(item.body, item.reactions, width, me, card));
    return lines;
  }
  if (home.kind === 'sent') {
    // The ask's own thread is named by the ask above it, so its card says who took it on; a thread it was sent on to, by its
    // title and its agent. The title gives way before the agent does.
    const agent = home.to.owner ? ownName(safe(home.to.owner)) : undefined;
    const lead: Part[] = [mark, [`  ${g.card} `]];
    const state: Part[] = [['  '], ...square(home.tone, look), [sentStateWords(home.tone), home.tone === 'waiting' || home.tone === 'review' ? alert(look) : undefined]];
    const words = home.taken && agent ? `Taken on by ${agent}` : safe(shownOf(item));
    // Where there is no room for both, the title keeps the room and who it went to goes, so where its work stands shows.
    const sentTo: Part[] = home.taken || !agent ? [] : [[` · sent on to ${agent}`, DIM]];
    const by = room - used(lead) - used(state) - used(sentTo) >= Math.min(12, columns(words)) ? sentTo : [];
    const left = room - used(lead) - used(state) - used(by);
    lines.push(cutParts([...lead, [fit(words, Math.max(4, left)), BOLD], ...by, ...state], room));
    return lines;
  }
  const { relay, stacked, link } = home;
  const tone: Tone = relay.tone;
  const linked = (text: string): Part => (link ? [text, BOLD, link] : [text, BOLD]);
  const title: Part[] = [...(relay.label ? [linked(`${safe(relay.label)} `)] : []), linked(safe(relay.title))];
  const asking = relay.kind === 'question' && relay.needsYou;
  const replied = relay.kind === 'reply' && !relay.answer;
  const answered = (relay.kind === 'question' && !relay.needsYou) || (relay.kind === 'reply' && Boolean(relay.answer));
  const reviewing = relay.kind === 'review' && relay.needsYou;
  const verdict = relay.kind === 'review' ? verdictWords(relay, me) : undefined;
  const when: Part = [` · ${clock(relay.at)}`, DIM];
  if (stacked) {
    // One line: what it is, when, and what it says, which is cut first; a question or a review chosen shows in full under it.
    const what: Part[] = asking
      ? [[' · ', DIM], ['Asks: ', `${BOLD};${alert(look)}`], [safe(firstLine(relay.body))]]
      : reviewing
        ? [[' · ', DIM], ['Waits for your review: ', `${BOLD};${alert(look)}`], [safe(firstLine(relay.body))]]
        : relay.kind === 'blocked'
          ? [[' · ', DIM], ['Blocked: ', `${BOLD};${toneSgr('blocked', look) ?? alert(look)}`], [safe(firstLine(relay.body))]]
          : verdict
            ? [[` · ${safe(verdict)}`, DIM]]
            : answered
              ? [[` · ${safe(answeredWords(relay, me))}`, DIM]]
              : replied
                ? [[' · ', DIM], [safe(firstLine(relay.body))]]
                : [[` · ${safe(firstLine(relay.body))}`, DIM]];
    lines.push(cutParts([mark, ['  '], ...square(tone, look), ...title, when, ...what], room));
    if ((asking || reviewing) && selected) lines.push(...messageRows(relay.body, item.reactions, width, me, card));
    if (replied && selected) lines.push(...shortRows(relay.body, width, me, card));
    if (reviewing && selected) lines.push(cutParts([[`    ${REVIEW_HINT}`, DIM]], room));
    return lines;
  }
  const words = relayWords(relay);
  const earlier: Part[] = replied && relay.earlier ? [[` · ${earlierWords(relay)}`, DIM]] : [];
  lines.push(cutParts([mark, ...square(tone, look), ...title, [' · ', DIM], [words, asking || reviewing ? `${BOLD};${alert(look)}` : relay.kind === 'blocked' ? toneSgr('blocked', look) : DIM], when, ...earlier], room));
  if (replied) lines.push(...shortRows(relay.body, width, me, card));
  else if (asking || reviewing) {
    lines.push(...messageRows(relay.body, item.reactions, width, me, card));
    if (reviewing) lines.push(cutParts([[`    ${REVIEW_HINT}`, DIM]], room));
  } else if (verdict) lines.push(cutParts([[`    ${g.check}${safe(verdict)}`, DIM]], room));
  else if (answered) lines.push(cutParts([[`    ${g.check}${safe(answeredWords(relay, me))}`, DIM]], room));
  else lines.push(cutParts([[`    ${safe(firstLine(relay.body))}`, relay.kind === 'done' ? DIM : undefined]], room));
  return lines;
}

// A thread's latest word, in two lines at most, the second ending in … where the thread holds more.
function shortRows(body: string, width: number, me: string, card?: CardLink): Part[][] {
  const rows = messageRows(body, undefined, width, me, card).filter((row) => row.some(([text]) => text.trim()));
  if (rows.length <= 2) return rows;
  const second = cutParts(rows[1], Math.max(1, width - 3));
  return [rows[0], second.map(([text]) => text).join('').endsWith('…') ? second : [...second, [' …', DIM]]];
}

// The title of the thread a card leads to, as its place names it.
const shownOf = (item: StreamItem): string => (item.place.kind === 'thread' ? item.place.title : '');

// The line of an item its stitch, knot or knit is on: its first, after what is written before it.
export const headOf = (item: StreamItem): number => item.before?.length ?? 0;

// ---- the yarn ---------------------------------------------------------------------------

// A strand beside the conversation: its lane, its tone, and the items it runs
// from (where it knits off; -1 above the first) and to (where it is tied off;
// Infinity while its work goes on).
interface YarnStrand {
  id: string;
  lane: number;
  tone: StrandTone;
  start: number;
  end: number;
}

export interface HomeYarn {
  lanes: number;
  strands: YarnStrand[];
}

// Where each strand runs among the items: from the card that sent its thread
// on (or the first item said after it began), to its thread's Done (or the
// first item after its work was done).
export function homeYarn(items: readonly StreamItem[], strands: readonly Strand[], lanes: ReadonlyMap<string, number>): HomeYarn {
  const laid: YarnStrand[] = [];
  for (const strand of strands) {
    const lane = lanes.get(strand.id);
    if (lane === undefined) continue;
    let start = items.findIndex((item) => item.home?.kind === 'sent' && item.home.to.id === strand.id);
    if (start < 0) start = !items.length || strand.from < items[0].at ? -1 : items.findIndex((item) => item.at >= strand.from);
    if (start < 0 && items.length && strand.from >= items[0].at) start = items.length; // begun after the last: not in sight yet
    let end = Infinity;
    if (strand.to) {
      const knot = items.findIndex((item) => item.home?.kind === 'relay' && item.home.relay.kind === 'done' && item.home.relay.thread?.id === strand.id);
      const after = items.findIndex((item, i) => i >= start && item.at >= strand.to!);
      end = Math.max(start, knot >= 0 ? knot : after >= 0 ? after : items.length - 1);
    }
    laid.push({ id: strand.id, lane, tone: strand.tone, start, end });
  }
  return { lanes: laid.length ? Math.max(...laid.map((s) => s.lane)) + 1 : 0, strands: laid };
}

// From this many columns of stream a lane each shows; and the yarn takes a quarter of it at most.
export const LANES_FROM = 60;

// The columns the yarn takes of a stream `width` wide, and whether it shows a lane each: the conversation's strand, then
// a lane each, or a column of marks.
export function yarnWidth(yarn: HomeYarn | undefined, width: number): { width: number; full: boolean } {
  if (!yarn) return { width: 0, full: false };
  if (!yarn.lanes) return { width: 3, full: true };
  const full = width >= LANES_FROM && 3 + 2 * yarn.lanes <= Math.floor(width / 4);
  return { width: full ? 3 + 2 * yarn.lanes : 4, full };
}

type Cell = [text: string, sgr?: string];

// What a strand draws in its lane on line `line` of item `index`, whose head is line `head`.
function laneAt(strand: YarnStrand, item: StreamItem, index: number, line: number, head: number): 'lane' | 'knit' | 'knot' | 'stitch' | undefined {
  if (index < strand.start || index > strand.end) return undefined;
  if (index === strand.start && index === strand.end) return line === head ? (Number.isFinite(strand.end) ? 'knot' : 'knit') : line > head && !Number.isFinite(strand.end) ? 'lane' : undefined;
  if (index === strand.start) return line < head ? undefined : line === head ? 'knit' : 'lane';
  if (index === strand.end) return line < head ? 'lane' : line === head ? 'knot' : undefined;
  const relay = item.home?.kind === 'relay' && (item.home.relay.thread?.id ?? item.home.relay.pairing?.thread) === strand.id && item.home.relay.kind !== 'done';
  return relay && line === head ? 'stitch' : 'lane';
}

// The yarn's cells beside line `line` of item `index`, `full` with a lane each, else a column of marks.
export function yarnParts(yarn: HomeYarn, items: readonly StreamItem[], index: number, line: number, full: boolean, look: Look): Part[] {
  const g = glyphsOf(look);
  const item = items[index];
  const head = headOf(item);
  const width = full ? (yarn.lanes ? 3 + 2 * yarn.lanes : 3) : yarn.lanes ? 4 : 3;
  const cells: Cell[] = Array.from({ length: width }, () => [' ']);
  const said = line === head && item.home?.kind === 'said';
  cells[1] = said ? [g.stitch] : [g.trunk, DIM];
  const glyph = (strand: YarnStrand, what: 'lane' | 'knit' | 'knot' | 'stitch'): Cell => {
    const sgr = toneSgr(what === 'knot' ? 'done' : strand.tone, look);
    if (what === 'lane') return [look.colours === 'none' ? PLAIN_LANE[strand.tone] : g.trunk, sgr];
    return [what === 'knit' ? g.knit : what === 'knot' ? g.knot : g.stitch, sgr];
  };
  if (full) {
    for (const strand of yarn.strands) {
      const what = laneAt(strand, item, index, line, head);
      if (what) cells[3 + 2 * strand.lane] = glyph(strand, what);
    }
    // Where a thread knits off: from the conversation's strand across to its lane, under any lane that runs between.
    for (const strand of yarn.strands) {
      if (strand.start !== index || line !== head) continue;
      const col = 3 + 2 * strand.lane;
      cells[1] = [g.branch, DIM];
      for (let x = 2; x < col; x++) if (cells[x][0] === ' ') cells[x] = [g.across, toneSgr(strand.tone, look)];
    }
  } else if (line === head) {
    // A column of marks: where a thread knits off, a relay, and a knot.
    const home = item.home;
    const knitting = yarn.strands.find((s) => s.start === index);
    const tied = yarn.strands.find((s) => s.end === index && Number.isFinite(s.end));
    if (knitting && home?.kind === 'sent') {
      cells[1] = [g.branch, DIM];
      cells[2] = [g.mark, toneSgr(knitting.tone, look)];
    } else if (tied) cells[2] = [g.knot, toneSgr('done', look)];
    else if (home?.kind === 'relay') cells[2] = [g.stitch, toneSgr(home.relay.tone, look)];
  }
  return cells.map(([text, sgr]) => (sgr ? [text, sgr] : [text]));
}
