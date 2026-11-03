// Deletions kept aside, so a block, group, link or pin removed from a canvas
// can be put back as it was, with the same id: references to it and pins on
// it resolve again. So can earlier versions a person deleted from a block,
// and a thread a person deleted, with all it said.
// A board keeps its last 50 deletions for 30 days. Pure: the store keeps the
// list and logs; this says what to keep, whether and how it goes back, and
// what to prune.

import { blockLabel, MAX_VERSIONS } from './canvas';
import { clip, listNames } from './format';
import { pinPart } from './pins';
import type { Actor, Block, BlockVersion, Canvas, Group, Link, Pin, Thread } from './types';

export const KEEP_DELETIONS = 50; // per board
export const KEEP_DAYS = 30;
const KEEP_MS = KEEP_DAYS * 24 * 60 * 60 * 1000;

export type DeletedKind = 'block' | 'group' | 'link' | 'pin' | 'version' | 'thread';

// What a deletion took off the canvas, to put back.
export interface Kept {
  block?: Block; // a removed block; its earlier versions stay in their table until its deletion lapses
  index?: number; // where a removed block was among the canvas's blocks, which sets what it's drawn over, or a thread among the board's
  group?: Group; // a removed group, or the group a removed block was in
  members?: string[]; // a removed group's blocks, which stayed on the canvas
  links?: Link[]; // a removed link, or a removed block's
  pins?: Pin[]; // a removed pin, or a removed block's, with their comment threads
  versions?: BlockVersion[]; // earlier versions deleted from a block, oldest first
  thread?: Thread; // a deleted thread, with its messages
}

export interface Deletion {
  id: string; // the item's id, which it keeps when restored; versions' is their block's and revs: b12@v7, b12@v1-v9
  kind: DeletedKind;
  blockId?: string; // versions: the block they're of
  label: string; // as history names it: note "Where things stand"
  on: { decisionId?: string; taskId?: string }; // the canvas it was on; neither for the board context, and for a thread
  by: Actor;
  at: string;
  seq: number; // the event that logged it
  kept?: Kept; // let go once it's restored; people's copy goes without
  restored?: { by: Actor; at: string };
}

// A deletion as people's copy of the board carries it: what, by whom, when.
export type DeletionSummary = Omit<Deletion, 'kept'>;

// What removing an item takes with it, read before anything changes: a block
// its links and pins (and its group, for where it was), a group the blocks it
// held, which stay. Null if there's no such item on the canvas.
export function keepItem(canvas: Canvas, itemId: string): Pick<Deletion, 'kind' | 'label' | 'kept'> | null {
  const block = canvas.blocks.find((b) => b.id === itemId);
  if (block) {
    const { versionCount: _count, ...held } = block;
    const kept: Kept = {
      block: held as Block,
      index: canvas.blocks.indexOf(block),
      group: canvas.groups.find((g) => g.id === block.groupId),
      links: canvas.links.filter((l) => l.from === itemId || l.to === itemId),
      pins: canvas.pins.filter((p) => p.blockId === itemId),
    };
    return { kind: 'block', label: blockLabel(block), kept: structuredClone(kept) };
  }
  const group = canvas.groups.find((g) => g.id === itemId);
  if (group) {
    const members = canvas.blocks.filter((b) => b.groupId === itemId).map((b) => b.id);
    return { kind: 'group', label: `group "${clip(group.title, 50)}"`, kept: structuredClone({ group, members }) };
  }
  const link = canvas.links.find((l) => l.id === itemId);
  if (link) {
    const [from, to] = [link.from, link.to].map((id) => canvas.blocks.find((b) => b.id === id));
    const label = from && to ? `link ${blockLabel(from)} → ${blockLabel(to)}` : 'link';
    return { kind: 'link', label, kept: { links: [structuredClone(link)] } };
  }
  const pin = canvas.pins.find((p) => p.id === itemId);
  if (pin) {
    const pinned = canvas.blocks.find((b) => b.id === pin.blockId);
    const what = pin.discussion?.thread ? 'comment thread on' : 'pin on';
    const label = `${what} ${pinPart(pin, pinned)}${pinned ? ` in ${blockLabel(pinned)}` : ''}`;
    return { kind: 'pin', label, kept: { pins: [structuredClone(pin)] } };
  }
  return null;
}

// What deleting earlier versions of a block takes: `versions`, which the store
// read, oldest first, before anything changes. One is named by its rev, several by count.
export function keepVersions(block: Block, versions: readonly BlockVersion[]): Pick<Deletion, 'id' | 'kind' | 'label' | 'blockId' | 'kept'> {
  const [first, last] = [versions[0].rev, versions.at(-1)!.rev];
  const one = versions.length === 1;
  return {
    id: `${block.id}@v${first}${one ? '' : `-v${last}`}`,
    kind: 'version',
    label: `${one ? `v${first}` : `${versions.length} earlier versions`} of ${blockLabel(block)}`,
    blockId: block.id,
    kept: { versions: structuredClone([...versions]) },
  };
}

export function isRestorable(deletion: DeletionSummary, now = Date.now()): boolean {
  return !deletion.restored && now - Date.parse(deletion.at) < KEEP_MS;
}

// The last deletion of an item, which is the one that can come back.
export function deletionOf(deletions: readonly Deletion[] | undefined, itemId: string): Deletion | undefined {
  return deletions?.findLast((d) => d.id === itemId);
}

// Expired deletions go, then the oldest past the last 50.
export function pruneDeletions(deletions: readonly Deletion[], now = Date.now()): Deletion[] {
  return deletions.filter((d) => now - Date.parse(d.at) < KEEP_MS).slice(-KEEP_DELETIONS);
}

// Why a deletion can't be put back on its canvas, or null if it can: it was
// restored already, it's past 30 days, or the block a link, pin or version
// is of is gone.
// `deletions` are the board's, for whether a missing block can come back first.
export function restoreRefusal(canvas: Canvas, deletion: Deletion, deletions: readonly Deletion[], now = Date.now()): string | null {
  const { label } = deletion;
  if (deletion.restored) {
    return `${capital(label)} was already restored by ${deletion.restored.by.name}, ${ago(deletion.restored.at, now)}.`;
  }
  if (!isRestorable(deletion, now)) {
    return `${capital(label)} was deleted ${ago(deletion.at, now)}; deletions are kept for ${KEEP_DAYS} days, so it can't be restored.`;
  }
  const kept = deletion.kept;
  if (!kept) return `Nothing of ${label} was kept to restore.`;
  const onCanvas = (id: string) => canvas.blocks.some((b) => b.id === id);
  if (deletion.kind === 'link' || deletion.kind === 'pin' || deletion.kind === 'version') {
    const needed =
      deletion.kind === 'link' ? [kept.links![0].from, kept.links![0].to] : deletion.kind === 'pin' ? [kept.pins![0].blockId] : [deletion.blockId!];
    const gone = needed.filter((id) => !onCanvas(id));
    if (gone.length) {
      const away = gone.map((id) => awaiting(deletions, id, now));
      const names = gone.map((id, i) => away[i]?.label ?? 'a block that was deleted');
      const verb = gone.length === 1 ? 'is' : 'are';
      const after = away.every(Boolean) ? ` Restore ${gone.length === 1 ? 'it' : 'them'} first.` : '';
      return `Can't restore ${label}: ${listNames(names)} ${verb} gone.${after}`;
    }
  }
  if (deletion.kind === 'link') {
    const link = kept.links![0];
    if (canvas.links.some((l) => l.from === link.from && l.to === link.to)) return `Can't restore ${label}: those blocks are linked again already.`;
  }
  return null;
}

// Puts a deletion back on its canvas, as it was and with the same ids, once
// restoreRefusal has passed it. Says what couldn't come back. A link to a
// block that was deleted too is handed to that block's deletion, so it comes
// back when that block does.
export function putBack(canvas: Canvas, deletion: Deletion, deletions: readonly Deletion[], now = Date.now()): { ids: string[]; notes: string[] } {
  const kept = structuredClone(deletion.kept!);
  const ids: string[] = [];
  const notes: string[] = [];
  const has = (list: { id: string }[], id: string) => list.some((item) => item.id === id);

  if (deletion.kind === 'block') {
    const block = kept.block!;
    if (block.groupId && !has(canvas.groups, block.groupId)) {
      // Its place was in its group; it keeps that place on the canvas.
      block.x += kept.group?.x ?? 0;
      block.y += kept.group?.y ?? 0;
      delete block.groupId;
      notes.push(`its group${kept.group ? ` "${clip(kept.group.title, 40)}"` : ''} is gone, so it's back outside it`);
    }
    canvas.blocks.splice(kept.index ?? canvas.blocks.length, 0, block);
    ids.push(block.id);
    for (const pin of kept.pins ?? []) {
      if (has(canvas.pins, pin.id)) continue;
      canvas.pins.push(pin);
      ids.push(pin.id);
    }
    for (const link of kept.links ?? []) {
      if (has(canvas.links, link.id) || canvas.links.some((l) => l.from === link.from && l.to === link.to)) continue;
      const other = link.from === block.id ? link.to : link.from;
      if (has(canvas.blocks, other)) {
        canvas.links.push(link);
        ids.push(link.id);
        continue;
      }
      const away = awaiting(deletions, other, now);
      if (away) {
        if (!has(away.kept!.links ?? [], link.id)) away.kept!.links = [...(away.kept!.links ?? []), link];
        notes.push(`its link to ${away.label} comes back if that is restored`);
      } else {
        notes.push('its link to a block that is gone can\'t come back');
      }
    }
  } else if (deletion.kind === 'group') {
    const group = kept.group!;
    canvas.groups.push(group);
    ids.push(group.id);
    let gone = 0;
    const waiting: string[] = [];
    const elsewhere: string[] = [];
    for (const id of kept.members ?? []) {
      const member = canvas.blocks.find((b) => b.id === id);
      const away = member ? undefined : awaiting(deletions, id, now);
      if (away && !away.kept!.block!.groupId) {
        // Deleted since: it comes back into the group, where it was.
        const block = away.kept!.block!;
        Object.assign(block, { groupId: group.id, x: block.x - group.x, y: block.y - group.y });
        away.kept!.group = group;
        waiting.push(away.label);
      } else if (!member) gone++;
      else if (member.groupId) elsewhere.push(blockLabel(member));
      else {
        member.groupId = group.id;
        member.x -= group.x;
        member.y -= group.y;
      }
    }
    if (waiting.length) notes.push(`${listNames(waiting)} ${waiting.length === 1 ? 'comes' : 'come'} back into it if restored`);
    if (gone) notes.push(`${gone} of its blocks ${gone === 1 ? 'is' : 'are'} gone`);
    if (elsewhere.length) {
      const one = elsewhere.length === 1;
      notes.push(`${listNames(elsewhere)} ${one ? 'is' : 'are'} in another group now, so ${one ? 'it stays' : 'they stay'} there`);
    }
  } else if (deletion.kind === 'link') {
    canvas.links.push(kept.links![0]);
    ids.push(kept.links![0].id);
  } else {
    canvas.pins.push(kept.pins![0]);
    ids.push(kept.pins![0].id);
  }
  return { ids, notes };
}

// Versions a person deleted from a block, back among its own: `have` are the
// revs it has now, `kept` what was deleted. A block keeps its last 50, so
// versions made since may leave no room for the oldest: `add` are the ones
// that fit, and the notes say of those that don't.
export function versionsBack(have: readonly number[], kept: readonly BlockVersion[]): { add: BlockVersion[]; notes: string[] } {
  const back = kept.filter((v) => !have.includes(v.rev));
  const fits = new Set([...have, ...back.map((v) => v.rev)].sort((a, b) => a - b).slice(-MAX_VERSIONS));
  const add = back.filter((v) => fits.has(v.rev));
  const lost = back.length - add.length;
  if (lost === 0) return { add, notes: [] };
  const which = back.length === 1 ? 'it is' : `${lost} of them ${lost === 1 ? 'is' : 'are'}`;
  return { add, notes: [`${which} older than the last ${MAX_VERSIONS} versions a block keeps, so ${lost === 1 ? 'it' : 'they'} can't come back`] };
}

// People's copy: what was deleted, by whom and when, without what was kept.
export function deletionSummaries(deletions: readonly Deletion[] | undefined): DeletionSummary[] {
  return (deletions ?? []).map(({ kept: _kept, ...summary }) => summary);
}

// For get_canvas: what was deleted from this canvas lately and can come back,
// newest first, in a line. Empty if nothing.
// A thread's is the board's, for get_board: pass kind 'thread'.
export function deletedLately(deletions: readonly Deletion[] | undefined, on: Deletion['on'], now = Date.now(), max = 5, kind?: 'thread'): string {
  const here = (deletions ?? [])
    .filter((d) => (d.kind === 'thread') === (kind === 'thread') && d.on.decisionId === on.decisionId && d.on.taskId === on.taskId)
    .filter((d) => isRestorable(d, now) && d.kept)
    .reverse();
  if (here.length === 0) return '';
  const shown = here.slice(0, max).map((d) => `${d.label} by ${d.by.name}, ${ago(d.at, now)} [id: ${d.id}]`);
  const more = here.length > shown.length ? `; and ${here.length - shown.length} more` : '';
  return `Deleted lately: ${shown.join('; ')}${more}. restore_item puts one back.`;
}

// The restorable deletion of a block that is off its canvas, if there is one.
function awaiting(deletions: readonly Deletion[], blockId: string, now: number): Deletion | undefined {
  const deletion = deletionOf(deletions, blockId);
  return deletion?.kind === 'block' && deletion.kept && isRestorable(deletion, now) ? deletion : undefined;
}

export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, now - Date.parse(iso)) / 60_000;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// A version keeps its name: v7.
export function capital(text: string): string {
  return /^v\d/.test(text) ? text : text.charAt(0).toUpperCase() + text.slice(1);
}
