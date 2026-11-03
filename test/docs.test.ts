import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  alignParagraphs,
  applyChanges,
  buildRequests,
  draftRows,
  newDraft,
  readDocument,
  rebaseDraft,
  resolveConflict,
  savedIds,
  textChange,
  type DocParagraph,
  type DocRequest,
  type GoogleDocument,
  type PulledDoc,
} from '../src/core/connectors/google/doc';
import { placePin } from '../src/core/pins';
import { Store } from '../src/core/store';
import type { Actor, Block, DocDraft, PinAnchor } from '../src/core/types';
import { createApp } from '../src/server/app';
import { Connectors } from '../src/server/connectors';
import { DOCS_SCOPE, DRIVE_FILE, DRIVE_METADATA, FakeDoc, FakeGoogleServer } from './fakeDocs';
import { eventsOf } from './tables';

const wassim: Actor = { kind: 'human', name: 'Wassim' };
const planner: Actor = { kind: 'agent', name: 'Planner' };

// A documents.get answer as Google sends it (indexes in UTF-16 code units,
// startIndex left out when 0): a title, a heading, styled text with a link,
// two lists, a table, an image, a line break, a suggestion and a smart chip.
const GOOGLE_DOC: GoogleDocument = {
  documentId: '1AbCdEfGhIjKlMnOp',
  title: 'Launch plan',
  revisionId: 'ALm37BV-rev-1',
  body: {
    content: [
      { endIndex: 1, sectionBreak: { sectionStyle: {} } } as never,
      { startIndex: 1, endIndex: 13, paragraph: { elements: [{ startIndex: 1, endIndex: 13, textRun: { content: 'Launch plan\n' } }], paragraphStyle: { namedStyleType: 'TITLE' } } },
      { startIndex: 13, endIndex: 19, paragraph: { elements: [{ startIndex: 13, endIndex: 19, textRun: { content: 'Goals\n' } }], paragraphStyle: { namedStyleType: 'HEADING_1' } } },
      {
        startIndex: 19,
        endIndex: 43,
        paragraph: {
          elements: [
            { startIndex: 19, endIndex: 28, textRun: { content: 'Ship the ' } },
            { startIndex: 28, endIndex: 32, textRun: { content: 'beta', textStyle: { bold: true } } as never },
            { startIndex: 32, endIndex: 36, textRun: { content: ' by ' } },
            { startIndex: 36, endIndex: 41, textRun: { content: 'March', textStyle: { link: { url: 'https://example.com' } } } as never },
            { startIndex: 41, endIndex: 43, textRun: { content: '.\n' } },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
      {
        startIndex: 43,
        endIndex: 57,
        paragraph: { elements: [{ startIndex: 43, endIndex: 57, textRun: { content: 'Design review\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, bullet: { listId: 'kix.a' } },
      },
      {
        startIndex: 57,
        endIndex: 70,
        paragraph: { elements: [{ startIndex: 57, endIndex: 70, textRun: { content: 'Pricing page\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, bullet: { listId: 'kix.a', nestingLevel: 1 } },
      },
      {
        startIndex: 70,
        endIndex: 81,
        paragraph: { elements: [{ startIndex: 70, endIndex: 81, textRun: { content: 'First step\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, bullet: { listId: 'kix.b' } },
      },
      {
        startIndex: 81,
        endIndex: 120,
        table: {
          rows: 2,
          columns: 2,
          tableRows: [
            { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Owner\n' } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: 'Date\n' } }] } }] }] },
            { tableCells: [{ content: [] }, { content: [] }] },
          ],
        },
      },
      {
        startIndex: 120,
        endIndex: 122,
        paragraph: {
          elements: [
            { startIndex: 120, endIndex: 121, inlineObjectElement: { inlineObjectId: 'kix.img1' } },
            { startIndex: 121, endIndex: 122, textRun: { content: '\n' } },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
      { startIndex: 122, endIndex: 140, paragraph: { elements: [{ startIndex: 122, endIndex: 140, textRun: { content: 'Line one\u000bline two\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } },
      {
        startIndex: 140,
        endIndex: 152,
        paragraph: {
          elements: [{ startIndex: 140, endIndex: 152, textRun: { content: 'Maybe later\n', suggestedInsertionIds: ['suggest.1'] } }],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
      {
        startIndex: 152,
        endIndex: 161,
        paragraph: {
          elements: [
            { startIndex: 152, endIndex: 159, textRun: { content: 'Owner: ' } },
            { startIndex: 159, endIndex: 160, person: { personProperties: { email: 'a@example.com' } } },
            { startIndex: 160, endIndex: 161, textRun: { content: '\n' } },
          ],
          paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
        },
      },
      { startIndex: 161, endIndex: 162, paragraph: { elements: [{ startIndex: 161, endIndex: 162, textRun: { content: '\n' } }], paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } },
    ],
  },
  lists: {
    'kix.a': { listProperties: { nestingLevels: [{ glyphType: 'GLYPH_TYPE_UNSPECIFIED', glyphSymbol: '●' }, { glyphSymbol: '○' }] } },
    'kix.b': { listProperties: { nestingLevels: [{ glyphType: 'DECIMAL' }] } },
  },
};

describe('Reading a Google Doc as paragraphs', () => {
  it('keeps headings, lists and text, and makes tables, images, chips and suggestions read-only', () => {
    const { revision, title, paragraphs } = readDocument(GOOGLE_DOC);
    assert.equal(revision, 'ALm37BV-rev-1');
    assert.equal(title, 'Launch plan');
    const brief = paragraphs.map(({ id, text, style, list, locked, detail, block, start, end }) => ({ id, text, style, list, locked, detail, block, start, end }));
    assert.deepEqual(brief, [
      { id: 'p1', text: 'Launch plan', style: 'TITLE', list: undefined, locked: undefined, detail: undefined, block: undefined, start: 1, end: 13 },
      { id: 'p2', text: 'Goals', style: 'HEADING_1', list: undefined, locked: undefined, detail: undefined, block: undefined, start: 13, end: 19 },
      { id: 'p3', text: 'Ship the beta by March.', style: 'NORMAL_TEXT', list: undefined, locked: undefined, detail: undefined, block: undefined, start: 19, end: 43 },
      { id: 'p4', text: 'Design review', style: 'NORMAL_TEXT', list: { id: 'kix.a', level: 0, ordered: false }, locked: undefined, detail: undefined, block: undefined, start: 43, end: 57 },
      { id: 'p5', text: 'Pricing page', style: 'NORMAL_TEXT', list: { id: 'kix.a', level: 1, ordered: false }, locked: undefined, detail: undefined, block: undefined, start: 57, end: 70 },
      { id: 'p6', text: 'First step', style: 'NORMAL_TEXT', list: { id: 'kix.b', level: 0, ordered: true }, locked: undefined, detail: undefined, block: undefined, start: 70, end: 81 },
      { id: 'p7', text: 'Owner · Date', style: 'NORMAL_TEXT', list: undefined, locked: 'Table', detail: '2 rows × 2 columns', block: true, start: 81, end: 120 },
      { id: 'p8', text: '', style: 'NORMAL_TEXT', list: undefined, locked: 'Image', detail: undefined, block: undefined, start: 120, end: 122 },
      { id: 'p9', text: 'Line one\nline two', style: 'NORMAL_TEXT', list: undefined, locked: undefined, detail: undefined, block: undefined, start: 122, end: 140 },
      { id: 'p10', text: 'Maybe later', style: 'NORMAL_TEXT', list: undefined, locked: 'Suggested edits', detail: undefined, block: undefined, start: 140, end: 152 },
      { id: 'p11', text: 'Owner: ', style: 'NORMAL_TEXT', list: undefined, locked: 'Smart chip', detail: undefined, block: undefined, start: 152, end: 161 },
      { id: 'p12', text: '', style: 'NORMAL_TEXT', list: undefined, locked: undefined, detail: undefined, block: undefined, start: 161, end: 162 },
    ]);
  });
});

// The doc the batchUpdate tests edit, in the fake: formatting, a comment, a
// list, a table and an image, so what must survive can be checked.
function launchPlan(id = '1LaunchPlanDocId0001'): FakeDoc {
  return new FakeDoc(
    id,
    'Q1 launch plan',
    [
      { runs: [{ text: 'Q1 launch plan' }], style: 'TITLE' },
      { runs: [{ text: 'Goals' }], style: 'HEADING_1' },
      { runs: [{ text: 'Ship', comment: 'c-ship' }, { text: ' the ' }, { text: 'beta', bold: true }, { text: ' by February.' }], alignment: 'JUSTIFIED' },
      { runs: [{ text: 'Design review' }], bullet: { listId: 'kix.list1' } },
      { runs: [{ text: 'Pricing page' }], bullet: { listId: 'kix.list1' } },
      { table: { rows: 3, columns: 2, header: ['Owner', 'Date'] } },
      { runs: [{ text: 'Budget: see the ' }, { text: 'sheet', link: { url: 'https://example.com/sheet' } }, { text: '.' }] },
      { runs: [{ image: 'kix.chart' }] },
      { runs: [{ text: 'Risks' }], style: 'HEADING_1' },
      { runs: [{ text: 'Hiring is slow.' }] },
      { runs: [{ text: 'Old note to remove.' }] },
    ],
    { 'kix.list1': { ordered: false } },
  );
}

function pulled(doc: FakeDoc): PulledDoc {
  const read = readDocument(doc.toJSON() as GoogleDocument);
  return { fileId: doc.id, revision: read.revision!, title: read.title, paragraphs: read.paragraphs, pulledAt: '2026-10-30T12:00:00.000Z' };
}

// Where an insert or delete acts.
function at(request: DocRequest): number | undefined {
  const r = request as { insertText?: { location: { index: number } }; deleteContentRange?: { range: { startIndex: number } } };
  return r.insertText?.location.index ?? r.deleteContentRange?.range.startIndex;
}

describe('Saving only what changed', () => {
  it('replaces only the changed part of a paragraph, keeping the rest and its style', () => {
    assert.deepEqual(textChange('Ship the beta by February.', 'Ship the beta by March, with docs.'), { from: 17, to: 25, insert: 'March, with docs' });
    assert.deepEqual(textChange('abc', 'abc'), { from: 3, to: 3, insert: '' });
    assert.deepEqual(textChange('', 'New'), { from: 0, to: 0, insert: 'New' });
    // Never splits an emoji's surrogate pair.
    const change = textChange('Go 😀 now', 'Go 😃 now');
    assert.equal(change.from, 3);
    assert.equal(change.to, 5);
    assert.equal(change.insert, '😃');
  });

  it('builds one batchUpdate from the end of the doc: changed, added and removed paragraphs, styles and lists kept', () => {
    const doc = launchPlan();
    const base = pulled(doc);
    const ids = Object.fromEntries(base.paragraphs.map((p) => [p.text || p.locked, p.id]));
    let { draft } = applyChanges(base.paragraphs, newDraft(base), [{ kind: 'text', id: ids['Ship the beta by February.'], text: 'Ship the beta by March, with docs.' }], wassim);
    ({ draft } = applyChanges(
      base.paragraphs,
      draft,
      [
        { kind: 'add', after: ids['Goals'], text: 'Ten teams use it weekly.' }, // after a heading: plain text
        { kind: 'add', after: ids['Pricing page'], text: 'Onboarding emails', list: 'bullet' }, // continues the list
        { kind: 'add', after: ids['Pricing page'], text: 'Launch post', list: 'bullet' }, // after the one before, in one call
        { kind: 'add', after: ids['Risks'], text: 'Vendors may slip.', style: 'normal' },
        { kind: 'delete', id: ids['Hiring is slow.'] },
        { kind: 'delete', id: ids['Old note to remove.'] }, // the last paragraph: emptied, its newline stays
      ],
      planner,
    ));
    assert.equal(draft.edits.length, 7);
    assert.deepEqual(
      draftRows(base.paragraphs, draft).map((r) => `${r.state}:${r.locked || r.text}`),
      [
        'same:Q1 launch plan',
        'same:Goals',
        'added:Ten teams use it weekly.',
        'changed:Ship the beta by March, with docs.',
        'same:Design review',
        'same:Pricing page',
        'added:Onboarding emails',
        'added:Launch post',
        'same:Table',
        'same:Budget: see the sheet.',
        'same:Image',
        'same:Risks',
        'added:Vendors may slip.',
        'removed:Hiring is slow.',
        'removed:Old note to remove.',
      ],
    );

    const requests = buildRequests(base.paragraphs, draft);
    // Inserts and deletes go from the end of the doc to the start.
    const positions = requests.map(at).filter((p): p is number => p !== undefined);
    assert.deepEqual(positions, [...positions].sort((a, b) => b - a));
    // No insert or delete touches the table or the image. (Since they run from
    // the end, their indexes are the doc's as pulled; the style fixes after an
    // insert are in the doc as it is then.)
    const locked = base.paragraphs.filter((p) => p.locked);
    for (const request of requests) {
      const r = request as { deleteContentRange?: { range: { startIndex: number; endIndex: number } }; insertText?: { location: { index: number } } };
      for (const p of locked) {
        const range = r.deleteContentRange?.range;
        if (range) assert.ok(range.endIndex <= p.start || range.startIndex >= p.end, `${JSON.stringify(request)} touches ${p.locked}`);
        const index = r.insertText?.location.index;
        if (index !== undefined) assert.ok(index < p.start || index >= p.end || (!p.block && index === p.end - 1), `${JSON.stringify(request)} goes into ${p.locked}`);
      }
    }
    const p = (text: string) => base.paragraphs.find((x) => x.text === text)!;
    // The changed paragraph: only "February" goes, at its own index.
    const ship = p('Ship the beta by February.');
    assert.deepEqual(
      requests.filter((r) => at(r) === ship.start + 17),
      [
        { deleteContentRange: { range: { startIndex: ship.start + 17, endIndex: ship.start + 25 } } },
        { insertText: { location: { index: ship.start + 17 }, text: 'March, with docs' } },
      ],
    );
    // The last paragraph is emptied; the one before it goes with its newline.
    const last = p('Old note to remove.');
    assert.ok(requests.some((r) => JSON.stringify(r) === JSON.stringify({ deleteContentRange: { range: { startIndex: last.start, endIndex: last.end - 1 } } })));
    const hiring = p('Hiring is slow.');
    assert.ok(requests.some((r) => JSON.stringify(r) === JSON.stringify({ deleteContentRange: { range: { startIndex: hiring.start, endIndex: hiring.end } } })));
    // New paragraphs after the heading: as if pressing Enter at its end, then made plain text.
    const goals = p('Goals');
    const i = requests.findIndex((r) => at(r) === goals.end - 1);
    assert.deepEqual(requests.slice(i, i + 3), [
      { insertText: { location: { index: goals.end - 1 }, text: '\nTen teams use it weekly.' } },
      { updateParagraphStyle: { range: { startIndex: goals.end, endIndex: goals.end + 25 }, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType' } },
      { updateTextStyle: { range: { startIndex: goals.end, endIndex: goals.end + 24 }, textStyle: {}, fields: '*' } },
    ]);
    assert.ok(!requests.some((r) => 'createParagraphBullets' in r), 'the new items join the list they follow');

    // Google applies it, and what wasn't edited is as it was.
    doc.batchUpdate({ requests, writeControl: { requiredRevisionId: base.revision } });
    const after = doc.paragraphs();
    assert.deepEqual(
      after.map((x) => `${x.style}${x.list ? `/${x.list}` : ''}: ${x.text}`),
      [
        'TITLE: Q1 launch plan',
        'HEADING_1: Goals',
        'NORMAL_TEXT: Ten teams use it weekly.',
        'NORMAL_TEXT: Ship the beta by March, with docs.',
        'NORMAL_TEXT/bullet: Design review',
        'NORMAL_TEXT/bullet: Pricing page',
        'NORMAL_TEXT/bullet: Onboarding emails',
        'NORMAL_TEXT/bullet: Launch post',
        'TABLE: [table Owner|Date]',
        'NORMAL_TEXT: Budget: see the sheet.',
        'NORMAL_TEXT: [image]',
        'HEADING_1: Risks',
        'NORMAL_TEXT: Vendors may slip.',
        'NORMAL_TEXT: ',
      ],
    );
    const ship2 = after.find((x) => x.text.startsWith('Ship'))!;
    assert.equal(ship2.bold, 'beta', 'formatting outside the edit survives');
    assert.deepEqual(ship2.comments, ['c-ship'], 'so do comments');
    assert.equal(ship2.alignment, 'JUSTIFIED', 'and the paragraph style');
    assert.equal(after.find((x) => x.text.startsWith('Budget'))!.links, 'sheet');
    assert.deepEqual(after.find((x) => x.images.length)!.images, ['kix.chart']);
    assert.equal(after.find((x) => x.text === 'Onboarding emails')!.listId, 'kix.list1');
    assert.equal(after.find((x) => x.text === 'Ten teams use it weekly.')!.bold, '');
  });

  it("starts a list, or leaves one, when a new paragraph's kind differs from where it is typed", () => {
    const doc = launchPlan();
    const base = pulled(doc);
    const id = (text: string) => base.paragraphs.find((p) => p.text === text)!.id;
    const { draft } = applyChanges(
      base.paragraphs,
      newDraft(base),
      [
        { kind: 'add', after: id('Pricing page'), text: 'Not a list item' },
        { kind: 'add', after: id('Hiring is slow.'), text: 'Step one', list: 'numbered' },
        { kind: 'add', after: id('Hiring is slow.'), text: 'Step two', list: 'numbered' },
        { kind: 'add', after: '', text: 'Draft, do not share', style: 'subtitle' },
      ],
      wassim,
    );
    const requests = buildRequests(base.paragraphs, draft);
    assert.equal(requests.filter((r) => 'createParagraphBullets' in r).length, 1, 'one list for both steps');
    assert.equal(requests.filter((r) => 'deleteParagraphBullets' in r).length, 1);
    doc.batchUpdate({ requests });
    const after = doc.paragraphs();
    assert.equal(after[0].text, 'Draft, do not share');
    assert.equal(after[0].style, 'SUBTITLE');
    assert.equal(after[1].style, 'TITLE', 'the old first paragraph keeps its style');
    assert.equal(after.find((x) => x.text === 'Not a list item')!.list, undefined);
    const steps = after.filter((x) => x.text.startsWith('Step'));
    assert.deepEqual(steps.map((x) => x.list), ['numbered', 'numbered']);
    assert.equal(steps[0].listId, steps[1].listId);
  });

  it('never changes or removes a read-only part, and refuses paragraphs between two tables', () => {
    const doc = new FakeDoc('1TwoTablesDocId000', 'Tables', [
      { runs: [{ text: 'Intro' }] },
      { table: { rows: 1, columns: 1, header: ['A'] } },
      { table: { rows: 1, columns: 1, header: ['B'] } },
      { runs: [{ text: 'End' }] },
    ]);
    const base = pulled(doc);
    const [, first, second] = base.paragraphs;
    assert.equal(first.locked, 'Table');
    assert.throws(() => applyChanges(base.paragraphs, newDraft(base), [{ kind: 'text', id: first.id, text: 'x' }], wassim), /a table: Tricot can't change it/);
    assert.throws(() => applyChanges(base.paragraphs, newDraft(base), [{ kind: 'delete', id: second.id }], wassim), /can't change it/);
    assert.throws(() => applyChanges(base.paragraphs, newDraft(base), [{ kind: 'add', after: first.id, text: 'x' }], wassim), /two tables meet/);
    // After the second table there's a paragraph to add to.
    const { draft } = applyChanges(base.paragraphs, newDraft(base), [{ kind: 'add', after: second.id, text: 'Between' }], wassim);
    doc.batchUpdate({ requests: buildRequests(base.paragraphs, draft) });
    assert.deepEqual(doc.paragraphs().map((p) => p.text), ['Intro', '[table A]', '[table B]', 'Between', 'End']);
  });
});

describe('When the doc changed in Google meanwhile', () => {
  it('carries over what nobody else touched, and leaves the rest to a person', () => {
    const doc = launchPlan();
    const base = pulled(doc);
    const id = (text: string) => base.paragraphs.find((p) => p.text === text)!.id;
    let { draft } = applyChanges(
      base.paragraphs,
      newDraft(base),
      [
        { kind: 'text', id: id('Ship the beta by February.'), text: 'Ship the beta by March.' },
        { kind: 'text', id: id('Hiring is slow.'), text: 'Hiring is slow; two roles open.' },
        { kind: 'delete', id: id('Design review') },
        { kind: 'add', after: id('Risks'), text: 'Vendors may slip.' },
      ],
      wassim,
    );
    // Meanwhile in Google: a new first paragraph, "Ship…" reworded, "Design review" removed.
    doc.change((d) => {
      d.batchUpdate({ requests: [{ insertText: { location: { index: 1 }, text: 'Confidential\n' } }] });
      const latest = pulled(d);
      const ship = latest.paragraphs.find((p) => p.text.startsWith('Ship'))!;
      d.batchUpdate({ requests: [{ insertText: { location: { index: ship.end - 1 }, text: ' Maybe sooner.' } }] });
      const design = pulled(d).paragraphs.find((p) => p.text === 'Design review')!;
      d.batchUpdate({ requests: [{ deleteContentRange: { range: { startIndex: design.start, endIndex: design.end } } }] });
    });
    const latest = pulled(doc);
    assert.notEqual(latest.revision, base.revision);
    const pairs = alignParagraphs(base.paragraphs, latest.paragraphs);
    assert.equal(pairs.get(id('Goals')), latest.paragraphs.find((p) => p.text === 'Goals')!.id);

    draft = rebaseDraft(base.paragraphs, latest, draft, '2026-10-30T12:05:00.000Z');
    assert.equal(draft.revision, latest.revision);
    assert.equal(draft.conflicts?.length, 1);
    assert.deepEqual(
      { was: draft.conflicts![0].was, theirs: draft.conflicts![0].theirs, mine: draft.conflicts![0].mine },
      { was: 'Ship the beta by February.', theirs: 'Ship the beta by February. Maybe sooner.', mine: 'Ship the beta by March.' },
    );
    // The other changes moved onto the new ids; removing what they removed too is no change.
    const rows = draftRows(latest.paragraphs, draft);
    assert.deepEqual(
      rows.filter((r) => r.state !== 'same').map((r) => `${r.state}:${r.text}`),
      ['added:Vendors may slip.', 'changed:Hiring is slow; two roles open.'],
    );
    assert.equal(draft.rebased?.theirs, 3);
    assert.throws(() => rebaseDraft(latest.paragraphs, latest, draft), /Settle the open conflicts/);

    const mine = resolveConflict(latest.paragraphs, draft, 'c1', 'mine');
    assert.equal(mine.conflicts, undefined);
    assert.ok(mine.edits.some((e) => e.op === 'edit' && e.text === 'Ship the beta by March.' && e.was === 'Ship the beta by February. Maybe sooner.'));
    const theirs = resolveConflict(latest.paragraphs, draft, 'c1', 'theirs');
    assert.ok(!theirs.edits.some((e) => e.op === 'edit' && e.text === 'Ship the beta by March.'));

    doc.batchUpdate({ requests: buildRequests(latest.paragraphs, mine), writeControl: { requiredRevisionId: latest.revision } });
    assert.deepEqual(
      doc.paragraphs().map((p) => p.text).filter((t) => /Confidential|Ship|Hiring|Vendors|Design/.test(t)),
      ['Confidential', 'Ship the beta by March.', 'Vendors may slip.', 'Hiring is slow; two roles open.'],
    );
  });

  it('puts the draft back as a new paragraph when Google removed the one it changed', () => {
    const doc = launchPlan();
    const base = pulled(doc);
    const hiring = base.paragraphs.find((p) => p.text === 'Hiring is slow.')!;
    const { draft } = applyChanges(base.paragraphs, newDraft(base), [{ kind: 'text', id: hiring.id, text: 'Hiring is fine now.' }], wassim);
    doc.change((d) => {
      const h = pulled(d).paragraphs.find((p) => p.text === 'Hiring is slow.')!;
      d.batchUpdate({ requests: [{ deleteContentRange: { range: { startIndex: h.start, endIndex: h.end } } }] });
    });
    const latest = pulled(doc);
    const rebased = rebaseDraft(base.paragraphs, latest, draft);
    assert.equal(rebased.conflicts?.[0].theirs, undefined);
    const kept = resolveConflict(latest.paragraphs, rebased, 'c1', 'mine');
    assert.deepEqual(draftRows(latest.paragraphs, kept).filter((r) => r.state === 'added').map((r) => r.text), ['Hiring is fine now.']);
    doc.batchUpdate({ requests: buildRequests(latest.paragraphs, kept), writeControl: { requiredRevisionId: latest.revision } });
    assert.deepEqual(doc.paragraphs().slice(-3).map((p) => p.text), ['Risks', 'Hiring is fine now.', 'Old note to remove.']);
  });
});

// ---- end to end: the app, the connector, and a fake Google ------------------------

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const DOC_ID = '1LaunchPlanDocId0001';

describe('Google Docs in Tricot, end to end', () => {
  let dir: string;
  let google: FakeGoogleServer;
  let server: Server;
  let base: string;
  let store: Store;
  let doc: FakeDoc;
  let boardId: string;
  let blockId: string;
  let agent: Client;

  const get = async (route: string) => {
    const response = await fetch(`${base}${route}`);
    return { status: response.status, json: await response.json(), text: '' };
  };
  const post = async (route: string, body: unknown = {}) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  const signIn = async (permissions?: string[]) => {
    const started = await post('/api/connectors/google/start', permissions ? { permissions } : {});
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const back = new URL(google.approve(started.json.url));
    const page = await fetch(`${base}${back.pathname}${back.search}`);
    assert.equal(page.status, 200);
    return new URL(started.json.url);
  };
  const route = () => `/api/connectors/google/docs/${blockId}`;
  const block = () => store.blockOf(blockId) as Extract<Block, { type: 'link' }>;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await agent.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const noSecrets = (text: string) => {
    for (const token of [...google.tokens.keys(), 'fake-refresh']) assert.ok(!text.includes(token), `leaked ${token}`);
  };

  before(async () => {
    google = new FakeGoogleServer(CLIENT_ID);
    await google.start();
    doc = google.add(launchPlan(DOC_ID));
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-docs-'));
    writeFileSync(
      path.join(dir, 'google-client.json'),
      JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: 'fake-secret', redirect_uris: ['http://localhost'] } }),
    );
    store = new Store(dir);
    store.load();
    const connectors = new Connectors({ dataDir: dir, google: { endpoints: google.endpoints() } });
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    boardId = (await post('/api/boards', { actor: 'Wassim', title: 'Launch' })).json.id;
    const added = await post('/api/canvas/blocks', { actor: 'Wassim', boardId, content: { type: 'link', url: `https://docs.google.com/document/d/${DOC_ID}/edit` } });
    blockId = added.json.id;
    agent = new Client({ name: 'test-agent', version: '1.0.0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
  });

  after(async () => {
    await agent.close();
    server.closeAllConnections();
    server.close();
    google.stop();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks only for the docs a person chooses, and opens a doc once it has been chosen in the Picker', async () => {
    const before = await get(route());
    assert.equal(before.status, 409);
    assert.equal(before.json.code, 'not_connected');
    const refused = await call('read_google_doc', { block_id: blockId });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Google isn't connected/);

    // Signing in asks for who they are and drive.file: not every file's name, not every doc.
    const asked = await signIn();
    assert.deepEqual(asked.searchParams.get('scope')!.split(' ').sort(), ['email', 'openid', DRIVE_FILE].sort());
    assert.ok(!asked.searchParams.get('scope')!.includes(DOCS_SCOPE));
    assert.ok(!asked.searchParams.get('scope')!.includes(DRIVE_METADATA));
    assert.equal((await post('/api/connectors/google/start', { permissions: ['docs'] })).status, 400, 'no separate Docs permission any more');

    // A doc nobody chose in the Picker: said as a thing to do, not as an error.
    const notChosen = await get(route());
    assert.equal(notChosen.status, 403);
    assert.equal(notChosen.json.code, 'not_picked');
    assert.equal(notChosen.json.error, 'Choose this doc in Google once to let Tricot open it.');
    const agentRefused = await call('read_google_doc', { block_id: blockId });
    assert.equal(agentRefused.isError, true);
    assert.match(agentRefused.content[0].text, /hasn't been let into this Google Doc yet: a person has to choose it in Google once/);
    assert.match(agentRefused.content[0].text, /don't retry until they have/);
    const agentEdit = await call('edit_google_doc', { block_id: blockId, edits: [{ paragraph_id: 'p2', text: 'x' }] });
    assert.equal(agentEdit.isError, true);
    assert.match(agentEdit.content[0].text, /a person has to choose it in Google once/);
    assert.equal(block().docDraft, undefined);
    // Google answering 403 instead of 404 for a doc not chosen reads the same.
    google.hidden = 403;
    assert.equal((await get(route())).json.code, 'not_picked');
    google.hidden = 404;

    // What the browser's Picker is given: a token for Google's Picker (this test client has no project number or key), no secret.
    const config = await post('/api/connectors/google/picker');
    assert.equal(config.status, 200);
    assert.deepEqual(Object.keys(config.json), ['accessToken']);
    assert.ok(google.tokens.has(config.json.accessToken));
    assert.ok(!JSON.stringify(config.json).includes('fake-refresh') && !JSON.stringify(config.json).includes('fake-secret'));

    // The person chooses it in the Picker (which talks to Google); Tricot is told which, and opens it.
    google.pick(DOC_ID);
    assert.equal((await post('/api/connectors/google/chosen', { fileIds: ['bad id'] })).status, 400);
    assert.equal((await post('/api/connectors/google/chosen', { fileIds: [DOC_ID] })).status, 200);

    const status = (await get('/api/connectors')).json[0];
    assert.equal(status.state, 'connected');
    assert.equal(status.notice, undefined, 'signed in the new way: nothing to switch');
    assert.ok(status.account.scopes.includes(DRIVE_FILE));
    assert.deepEqual(status.access.find((a: { scope: string }) => a.scope === DRIVE_FILE), {
      scope: DRIVE_FILE,
      label: 'See and edit the Google Docs you choose, and only those',
      granted: true,
    });
    assert.ok(!status.access.some((a: { scope: string }) => a.scope === DOCS_SCOPE || a.scope === DRIVE_METADATA));
    // A later sign-in from the Connectors page asks for the same.
    const again = new URL((await post('/api/connectors/google/start')).json.url);
    assert.deepEqual(again.searchParams.get('scope')!.split(' ').sort(), ['email', 'openid', DRIVE_FILE].sort());

    const opened = await get(route());
    assert.equal(opened.status, 200);
    assert.equal(opened.json.doc.title, 'Q1 launch plan');
    assert.equal(opened.json.doc.revision, doc.revisionId);
    assert.equal(opened.json.draft, undefined);
    noSecrets(JSON.stringify(opened.json));
    // The version is kept on this computer, for this user only.
    const kept = path.join(dir, 'connectors', 'google-docs', `${DOC_ID}.json`);
    assert.equal(statSync(kept).mode & 0o777, 0o600);
    assert.deepEqual(store.listBoards().length, 1, 'kept versions are not boards');
  });

  it("lets agents read the doc and change the draft only, marked as theirs; Google isn't touched", async () => {
    const { tools } = await agent.listTools();
    const edit = tools.find((t) => t.name === 'edit_google_doc')!;
    assert.match(edit.description!, /Only the draft changes, never the doc in Google/);
    assert.match(edit.description!, /You never save to Google: a person reviews the draft, where your changes are marked with your name, and presses Save\./);
    assert.match(edit.description!, /reply in the request's thread with comment\(pin_id\), saying what you changed\. A person resolves it\. Words they only commented on are a note, not a request\./);

    const read = await call('read_google_doc', { block_id: blockId });
    assert.ok(!read.isError, read.content[0].text);
    const text = read.content[0].text;
    assert.match(text, /# Google Doc "Q1 launch plan" \[block id: .+\] · revision rev-/);
    assert.match(text, /- p2 \[Heading 1\] "Goals"/);
    assert.match(text, /- p4 • "Design review"/);
    assert.match(text, /- p6 \[Table · 3 rows × 2 columns · Owner · Date: read-only, edit in Google\]/);
    assert.match(text, /- p8 \[Image: read-only, edit in Google\]/);
    assert.match(text, /Draft: no changes yet\./);

    const calls = google.calls.length;
    const before = JSON.stringify(doc.toJSON());
    const edited = await call('edit_google_doc', {
      block_id: blockId,
      edits: [
        { paragraph_id: 'p10', text: 'Hiring is slow; two roles are open.' },
        { after: 'p9', text: 'Vendors may slip.' },
        { delete: 'p11' },
      ],
    });
    assert.ok(!edited.isError, edited.content[0].text);
    assert.match(edited.content[0].text, /reworded 1, added n1, removed 1\. The draft has 3 paragraphs changed\. Nothing was sent to Google/);
    assert.ok(google.calls.slice(calls).every((c) => c.method === 'GET'), 'no batchUpdate');
    assert.equal(JSON.stringify(doc.toJSON()), before, 'the doc in Google is unchanged');

    // The draft is kept with the block: only the changes, each with who made it.
    const draft = block().docDraft!;
    assert.equal(draft.revision, doc.revisionId);
    assert.deepEqual(
      draft.edits.map((e) => ({ op: e.op, id: e.id, by: e.by.name })),
      [
        { op: 'edit', id: 'p10', by: 'Planner' },
        { op: 'add', id: 'n1', by: 'Planner' },
        { op: 'delete', id: 'p11', by: 'Planner' },
      ],
    );
    const board = await get(`/api/boards/${boardId}`);
    const sent = board.json.canvas.blocks.find((b: { id: string }) => b.id === blockId);
    assert.ok(JSON.stringify(sent.docDraft).length < 800, 'compact');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^edited the draft of Google Doc "Q1 launch plan" in the board context$/);

    const reread = (await call('read_google_doc', { block_id: blockId })).content[0].text;
    assert.match(reread, /Draft: 3 paragraphs changed \(3 by Planner \(agent\)\)\. Not saved to Google yet/);
    assert.match(reread, /- p10 "Hiring is slow; two roles are open\." \(changed by Planner \(agent\); the doc has "Hiring is slow\."\)/);
    assert.match(reread, /- n1 "Vendors may slip\." \(added by Planner \(agent\)\)/);
    assert.match(reread, /- p11 "Old note to remove\." \(removed by Planner \(agent\)\)/);
    const canvas = (await call('get_canvas', { board_id: boardId })).content[0].text;
    assert.match(canvas, /draft: 3 paragraphs changed, not saved; read_google_doc/);

    // Refused clearly: a table, an id that isn't there, a link that isn't a doc.
    const table = await call('edit_google_doc', { block_id: blockId, edits: [{ paragraph_id: 'p6', text: 'x' }] });
    assert.equal(table.isError, true);
    assert.match(table.content[0].text, /p6 is a table: Tricot can't change it\. Edit it in Google\./);
    assert.match((await call('edit_google_doc', { block_id: blockId, edits: [{ paragraph_id: 'p99', text: 'x' }] })).content[0].text, /no paragraph "p99"/);
    assert.match((await call('edit_google_doc', { block_id: blockId, edits: [{ text: 'x' }] })).content[0].text, /each edit is/);
    const other = await post('/api/canvas/blocks', { actor: 'Wassim', boardId, content: { type: 'link', url: 'https://example.com' } });
    assert.match((await call('read_google_doc', { block_id: other.json.id })).content[0].text, /isn't a link to a Google Doc/);
    assert.ok(!(await agent.listTools()).tools.some((t) => /save/.test(t.name)), 'agents have no way to save');
  });

  it("saves people's and agents' changes to Google in one batchUpdate, only those paragraphs", async () => {
    const edited = await post(`${route()}/draft`, {
      actor: 'Wassim',
      revision: doc.revisionId,
      changes: [{ kind: 'text', id: 'p3', text: 'Ship the beta by March.' }],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.json));
    assert.equal(edited.json.draft.edits.length, 4);
    assert.equal(eventsOf(store, boardId).filter((e) => e.summary.startsWith('edited the draft')).length, 2, 'one line per person or agent');
    const stale = await post(`${route()}/draft`, { actor: 'Wassim', revision: 'rev-old', changes: [{ kind: 'text', id: 'p3', text: 'x' }] });
    assert.equal(stale.status, 409);

    const calls = google.calls.length;
    const saved = await post(`${route()}/save`, { actor: 'Wassim' });
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual(saved.json, { outcome: 'saved', paragraphs: 4, revision: doc.revisionId });
    const updates = google.calls.slice(calls).filter((c) => c.path.endsWith(':batchUpdate'));
    assert.equal(updates.length, 1);
    const body = updates[0].body as { writeControl: { requiredRevisionId: string }; requests: unknown[] };
    assert.equal(body.writeControl.requiredRevisionId, edited.json.draft.revision);
    assert.deepEqual(
      doc.paragraphs().map((p) => p.text).slice(2),
      ['Ship the beta by March.', 'Design review', 'Pricing page', '[table Owner|Date]', 'Budget: see the sheet.', '[image]', 'Risks', 'Vendors may slip.', 'Hiring is slow; two roles are open.', ''],
    );
    assert.equal(doc.paragraphs()[2].bold, 'beta');
    assert.equal(block().docDraft, undefined, 'the draft is done');
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, 'saved 4 paragraphs to Google, in Google Doc "Q1 launch plan" in the board context');
    assert.equal((await post(`${route()}/save`, { actor: 'Wassim' })).status, 400, 'nothing left to save');
  });

  it("stops when someone changed the doc in Google, shows both versions, and saves after a person chooses", async () => {
    const opened = (await get(route())).json;
    const id = (text: string) => opened.doc.paragraphs.find((p: DocParagraph) => p.text === text).id;
    await post(`${route()}/draft`, {
      actor: 'Wassim',
      revision: opened.doc.revision,
      changes: [
        { kind: 'text', id: id('Goals'), text: 'Goals for Q1' },
        { kind: 'text', id: id('Risks'), text: 'Risks and mitigations' },
      ],
    });
    await call('edit_google_doc', { block_id: blockId, edits: [{ paragraph_id: id('Pricing page'), text: 'Pricing page and FAQ' }] });
    // Someone edits "Goals" and "Design review" in Google.
    doc.change((d) => {
      const goals = pulled(d).paragraphs.find((p) => p.text === 'Goals')!;
      d.batchUpdate({ requests: [{ insertText: { location: { index: goals.end - 1 }, text: ' and non-goals' } }] });
      const design = pulled(d).paragraphs.find((p) => p.text === 'Design review')!;
      d.batchUpdate({ requests: [{ insertText: { location: { index: design.end - 1 }, text: ' (done)' } }] });
    });
    const before = JSON.stringify(doc.toJSON());

    const stopped = await post(`${route()}/save`, { actor: 'Wassim' });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.outcome, 'conflict');
    assert.equal(stopped.json.conflicts, 1);
    assert.equal(JSON.stringify(doc.toJSON()), before, "nothing overwritten: Google refused the stale revision");
    const refusedSave = google.calls.filter((c) => c.path.endsWith(':batchUpdate')).at(-1)!;
    assert.equal((refusedSave.body as { writeControl: { requiredRevisionId: string } }).writeControl.requiredRevisionId, opened.doc.revision);

    const view = (await get(route())).json;
    assert.equal(view.draft.revision, doc.revisionId, 'the draft moved onto the new version');
    assert.deepEqual(
      view.draft.conflicts.map((c: { theirs: string; mine: string; by: Actor }) => ({ theirs: c.theirs, mine: c.mine, by: c.by.name })),
      [{ theirs: 'Goals and non-goals', mine: 'Goals for Q1', by: 'Wassim' }],
    );
    const rows = draftRows(view.doc.paragraphs, view.draft as DocDraft);
    assert.deepEqual(rows.filter((r) => r.state !== 'same').map((r) => `${r.text} (${r.by!.name})`), ['Pricing page and FAQ (Planner)', 'Risks and mitigations (Wassim)']);
    assert.ok(rows.some((r) => r.text === 'Design review (done)'), 'their other change is in');
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /stopped saving Google Doc "Q1 launch plan" in the board context: it changed in Google, and 1 paragraph changed on both sides/);
    assert.match((await call('read_google_doc', { block_id: blockId })).content[0].text, /Saving stopped: the doc changed in Google[^]*- c1: Google has "Goals and non-goals"; the draft has "Goals for Q1"/);
    assert.equal((await post(`${route()}/save`, { actor: 'Wassim' })).status, 409, 'not until a person chooses');

    const resolved = await post(`${route()}/resolve`, { actor: 'Wassim', conflict: 'c1', keep: 'mine' });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
    assert.equal(resolved.json.draft.conflicts, undefined);
    const saved = await post(`${route()}/save`, { actor: 'Wassim' });
    assert.equal(saved.json.outcome, 'saved');
    assert.equal(saved.json.paragraphs, 3);
    const texts = doc.paragraphs().map((p) => p.text);
    assert.ok(texts.includes('Goals for Q1'));
    assert.ok(texts.includes('Design review (done)'), "their edit stays");
    assert.ok(texts.includes('Pricing page and FAQ'));
    assert.ok(texts.includes('Risks and mitigations'));
  });

  it('discards a draft, and moves a draft onto the latest version when the one it started from is gone', async () => {
    const opened = (await get(route())).json;
    await post(`${route()}/draft`, { actor: 'Wassim', revision: opened.doc.revision, changes: [{ kind: 'add', after: 'p1', text: 'A new line' }] });
    assert.ok(block().docDraft);
    assert.equal((await post(`${route()}/discard`, { actor: 'Wassim' })).status, 200);
    assert.equal(block().docDraft, undefined);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^discarded the draft of Google Doc "Q1 launch plan"/);

    // A draft whose version this computer lost (and Google moved on): found again by text.
    await post(`${route()}/draft`, { actor: 'Wassim', revision: opened.doc.revision, changes: [{ kind: 'text', id: 'p2', text: 'Objectives' }] });
    rmSync(path.join(dir, 'connectors', 'google-docs'), { recursive: true, force: true });
    const connectors = new Connectors({ dataDir: dir, google: { endpoints: google.endpoints() } });
    const fresh = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors });
    const second: Server = await new Promise((resolve) => {
      const s = fresh.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      doc.change((d) => d.batchUpdate({ requests: [{ insertText: { location: { index: 1 }, text: 'Top\n' } }] }));
      const url = `http://127.0.0.1:${(second.address() as AddressInfo).port}${route()}`;
      const view = await (await fetch(url)).json();
      assert.equal(view.draft.revision, doc.revisionId);
      const changed = draftRows(view.doc.paragraphs, view.draft).filter((r) => r.state === 'changed');
      assert.deepEqual(changed.map((r) => [r.text, r.was]), [['Objectives', 'Goals for Q1']]);
    } finally {
      second.closeAllConnections();
      second.close();
    }
    assert.ok(readdirSync(path.join(dir, 'connectors', 'google-docs')).length > 0);
    assert.ok(readFileSync(path.join(dir, 'connectors', 'google.json'), 'utf8').includes('fake-refresh'));
  });

  it('says plainly when the Docs API is off in the Google Cloud project', async () => {
    google.docsApiOff = true;
    try {
      const response = await get(route());
      assert.equal(response.json.code, 'docs_api_off');
      assert.match(response.json.error, /Turn it on \(APIs & Services → Library → Google Docs API\)/);
    } finally {
      google.docsApiOff = false;
    }
  });
});

describe("Asking agents to edit a doc's paragraph", () => {
  let dir: string;
  let google: FakeGoogleServer;
  let server: Server;
  let base: string;
  let store: Store;
  let doc: FakeDoc;
  let boardId: string;
  let blockId: string;
  let agent: Client;

  const get = async (route: string) => {
    const response = await fetch(`${base}${route}`);
    return { status: response.status, json: await response.json() };
  };
  const post = async (route: string, body: unknown = {}) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  const route = (id = blockId) => `/api/connectors/google/docs/${id}`;
  const call = async (name: string, args: Record<string, unknown>) =>
    (await agent.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const pinOf = (id: string) => store.canvasOf(id).canvas.pins.find((p) => p.id === id)!;
  const cursor = () => store.getBoard(boardId).seq;
  // A person selecting words in the editor, then asking (or commenting).
  const ask = async (paragraph: string, quote: string, body: string, options: { ask?: boolean; id?: string } = {}) => {
    const view = (await get(route(options.id))).json;
    const text: string = draftRows(view.doc.paragraphs, view.draft).find((r) => r.id === paragraph)!.text;
    const start = text.indexOf(quote);
    return post(`${route(options.id)}/pins`, {
      actor: 'Wassim',
      paragraph,
      revision: view.doc.revision,
      quote,
      prefix: text.slice(Math.max(0, start - 32), start),
      suffix: text.slice(start + quote.length, start + quote.length + 32),
      body,
      ask: options.ask ?? true,
    });
  };

  before(async () => {
    google = new FakeGoogleServer(CLIENT_ID);
    await google.start();
    doc = google.add(launchPlan(DOC_ID));
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-doc-asks-'));
    writeFileSync(
      path.join(dir, 'google-client.json'),
      JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: 'fake-secret', redirect_uris: ['http://localhost'] } }),
    );
    store = new Store(dir);
    store.load();
    const connectors = new Connectors({ dataDir: dir, google: { endpoints: google.endpoints() } });
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    boardId = (await post('/api/boards', { actor: 'Wassim', title: 'Launch' })).json.id;
    blockId = (await post('/api/canvas/blocks', { actor: 'Wassim', boardId, content: { type: 'link', url: `https://docs.google.com/document/d/${DOC_ID}/edit` } })).json.id;
    const started = await post('/api/connectors/google/start');
    const back = new URL(google.approve(started.json.url));
    assert.equal((await fetch(`${base}${back.pathname}${back.search}`)).status, 200);
    google.pick(DOC_ID);
    agent = new Client({ name: 'test-agent', version: '1.0.0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Claude`)));
  });

  after(async () => {
    await agent.close();
    server.closeAllConnections();
    server.close();
    google.stop();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pins the words to their paragraph with the request, in a thread', async () => {
    const asked = await ask('p10', 'Hiring is slow', 'make this shorter');
    assert.equal(asked.status, 201, JSON.stringify(asked.json));
    const pin = asked.json.pin;
    assert.equal(pin.blockId, blockId);
    assert.equal(pin.quote, 'Hiring is slow');
    assert.deepEqual(pin.anchor, { kind: 'doc', paragraph: 'p10', revision: doc.revisionId, prefix: '', suffix: '.', title: 'Q1 launch plan' });
    assert.deepEqual(
      pin.discussion.thread.map((c: { author: Actor; body: string; ask?: boolean }) => [c.author.name, c.body, c.ask]),
      [['Wassim', 'make this shorter', true]],
    );
    assert.equal(asked.json.comment.ask, true);
    const event = eventsOf(store, boardId).at(-1)!;
    assert.equal(event.summary, 'asked agents to edit "Hiring is slow" in Google Doc "Q1 launch plan" (board context): "make this shorter"');
    assert.equal(event.itemId, pin.id);
    assert.equal(block().docDraft, undefined, 'asking changes no draft');

    // Refused: words not in the paragraph, a table, a version the doc has moved on from.
    const missing = await post(`${route()}/pins`, { actor: 'Wassim', paragraph: 'p10', revision: doc.revisionId, quote: 'Vendors', body: 'x', ask: true });
    assert.equal(missing.status, 409);
    assert.match(missing.json.error, /aren't in the paragraph/);
    const table = await post(`${route()}/pins`, { actor: 'Wassim', paragraph: 'p6', revision: doc.revisionId, quote: 'Owner', body: 'x', ask: true });
    assert.equal(table.status, 400);
    assert.match(table.json.error, /a table: pin words in a paragraph of text/);
    const stale = await post(`${route()}/pins`, { actor: 'Wassim', paragraph: 'p10', revision: 'rev-old', quote: 'Hiring', body: 'x', ask: true });
    assert.equal(stale.status, 409);
    assert.equal((await post(`/api/canvas/blocks/${blockId}/pins/comment`, { actor: 'Wassim', part: { kind: 'doc', paragraph: 'p1' }, body: 'x' })).status, 400, "the canvas's routes don't take doc parts");
  });

  it("tells agents what to change and how to answer, in their updates and in read_google_doc", async () => {
    const pin = store.getBoard(boardId).canvas.pins.find((p) => p.anchor.kind === 'doc')!;
    const request = `Wassim asked you to edit "Q1 launch plan" (draft), paragraph p10 "Hiring is slow": "make this shorter". Change the draft with edit_google_doc (block_id: ${blockId}), then reply in the thread with comment (pin_id: ${pin.id}).`;
    const updates = (await call('get_updates', { board_id: boardId, since: 0 })).content[0].text;
    assert.ok(updates.includes(`Wassim (human) asked agents to edit "Hiring is slow" in Google Doc "Q1 launch plan" (board context): "make this shorter" [pin id: ${pin.id}]`), updates);
    assert.ok(updates.endsWith(request), updates);
    const board = (await call('get_board', { board_id: boardId })).content[0].text;
    assert.ok(board.includes(request), 'get_board names it too');
    assert.ok(!/comment thread on the board context waits/.test(board), 'counted as a request, not as a thread to answer');

    const read = (await call('read_google_doc', { block_id: blockId })).content[0].text;
    assert.ok(read.includes(`Pinned to paragraphs by people (requests to act on first):\n- ${request}`), read);
    const canvas = (await call('get_canvas', { board_id: boardId })).content[0].text;
    assert.match(canvas, /pinned "Hiring is slow" \(paragraph p10; read_google_doc\) → request to edit the paragraph, comment thread, open \[pin id: \w+\]; change the draft with edit_google_doc, then reply with comment\(pin_id\)\n {4}- Wassim \(human\) at [^ ]+ \(asking agents\): make this shorter/);

    // Commenting without asking is a note: no request to agents.
    const noted = await ask('p3', 'beta', 'Is February realistic?', { ask: false });
    assert.equal(noted.status, 201);
    assert.equal(noted.json.comment.ask, undefined);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^commented on "beta" in Google Doc "Q1 launch plan" \(board context\): "Is February realistic\?"$/);
    const again = (await call('read_google_doc', { block_id: blockId })).content[0].text;
    assert.match(again, new RegExp(`- Comment on paragraph p3 "beta", not a request \\(1 comment, last by Wassim \\(human\\): "Is February realistic\\?"\\) \\[pin id: ${noted.json.pin.id}\\]`));
    assert.equal((await call('get_updates', { board_id: boardId, since: 0 })).content[0].text.split('asked you to edit').length, 2, 'still the one request');
  });

  it('the agent edits the draft and replies in the thread; a person resolves it', async () => {
    const pin = store.getBoard(boardId).canvas.pins.find((p) => p.anchor.kind === 'doc' && p.quote === 'Hiring is slow')!;
    const edited = await call('edit_google_doc', { block_id: blockId, revision: doc.revisionId, edits: [{ paragraph_id: 'p10', text: 'Hiring lags.' }] });
    assert.ok(!edited.isError, edited.content[0].text);
    const draft = block().docDraft!;
    assert.deepEqual(draft.edits.map((e) => [e.op, e.id, e.by.name, e.op === 'edit' ? e.text : '']), [['edit', 'p10', 'Claude', 'Hiring lags.']], "the agent's change, marked as its own");
    assert.ok(placePin(block(), pinOf(pin.id)), 'the paragraph is still there, reworded');

    const replied = await call('comment', { pin_id: pin.id, body: 'Shortened p10 to "Hiring lags." in the draft.' });
    assert.ok(!replied.isError, replied.content[0].text);
    assert.equal(replied.content[0].text, 'Replied in the comment thread on "Hiring is slow" in Google Doc "Q1 launch plan", on the board context (2 comments). People see it by the paragraph, in the doc.');
    assert.deepEqual(pinOf(pin.id).discussion!.thread!.map((c) => [c.author.name, c.author.kind]), [['Wassim', 'human'], ['Claude', 'agent']]);

    // Answered: no longer asked of agents, until the person says more.
    const updates = (await agent.callTool({ name: 'get_updates', arguments: { board_id: boardId, since: 0 } })) as { content: { text: string }[] };
    assert.ok(!updates.content[0].text.includes('asked you to edit'), updates.content[0].text);
    const read = (await call('read_google_doc', { block_id: blockId })).content[0].text;
    assert.match(read, /- Done, waiting on a person: Wassim's request on paragraph p10 "Hiring is slow" \("make this shorter"\), last by Claude \(agent\): "Shortened p10/);
    assert.match(read, /- p10 "Hiring lags\." \(changed by Claude \(agent\); the doc has "Hiring is slow\."\)/);
    await post(`/api/canvas/pins/${pin.id}/comments`, { actor: 'Wassim', body: 'Shorter still' });
    const more = (await call('get_updates', { board_id: boardId, since: cursor() - 1 })).content[0].text;
    assert.ok(more.includes(`Wassim asked you to edit "Q1 launch plan" (draft), paragraph p10 "Hiring is slow": "make this shorter"; then: "Shorter still". Change the draft`), more);
    await call('comment', { pin_id: pin.id, body: 'Done.' });

    // Only people resolve it.
    const refused = await call('remove_item', { id: pin.id });
    assert.equal(refused.isError, true);
    const resolved = await post(`/api/canvas/pins/${pin.id}/resolve`, { actor: 'Wassim', resolved: true });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.discussion.resolved.by.name, 'Wassim');
    assert.ok(!(await call('read_google_doc', { block_id: blockId })).content[0].text.includes('Hiring is slow"'), 'resolved: off the list');
  });

  it('on a task canvas: the request goes in its discussion, and the agent is shown taking a look at the task', async () => {
    const [task] = store.planTasks(boardId, [{ title: 'Tidy the launch plan' }], { kind: 'human', name: 'Wassim' }, { ready: true });
    const onTask = await post('/api/canvas/blocks', { actor: 'Wassim', taskId: task.id, content: { type: 'link', url: `https://docs.google.com/document/d/${DOC_ID}/edit` } });
    const id = onTask.json.id;
    const asked = await ask('p2', 'Goals', 'Call it Objectives', { id });
    assert.equal(asked.status, 201, JSON.stringify(asked.json));
    assert.equal(store.getTask(task.id).task.comments.at(-1)!.ask, true);
    assert.match(eventsOf(store, boardId).at(-1)!.summary, /^asked agents, on T\d+ "Tidy the launch plan", to edit "Goals" in Google Doc "Q1 launch plan": "Call it Objectives"$/);
    const updates = (await call('get_updates', { board_id: boardId, since: 0 })).content[0].text;
    assert.ok(updates.includes(`Wassim asked you to edit "Q1 launch plan" (draft, on T${task.number}'s canvas), paragraph p2 "Goals": "Call it Objectives". Change the draft with edit_google_doc (block_id: ${id}), then reply in the thread with comment (pin_id: ${asked.json.pin.id}).`), updates);

    const focus = async () => (await get(`/api/boards/${boardId}`)).json.presence.map((a: { name: string; focus?: unknown }) => [a.name, a.focus]);
    await call('edit_google_doc', { block_id: id, edits: [{ paragraph_id: 'p2', text: 'Objectives' }] });
    assert.deepEqual(await focus(), [['Claude', { kind: 'task', id: task.id }]], "editing the doc puts the agent on the card whose canvas has it");
    await call('get_board', { board_id: boardId });
    const replied = await call('comment', { pin_id: asked.json.pin.id, body: 'Renamed it.' });
    assert.match(replied.content[0].text, /^Commented on T\d+ about "Goals" in Google Doc "Q1 launch plan", in its discussion\.$/);
    assert.deepEqual(await focus(), [['Claude', { kind: 'task', id: task.id }]]);
    assert.ok(!(await call('get_updates', { board_id: boardId, since: 0 })).content[0].text.includes('Call it Objectives". Change'), 'answered');
  });

  it('says the pin is no longer there when its paragraph is removed, and follows the paragraphs through a save', async () => {
    const view = (await get(route())).json;
    const asked = await ask('p11', 'Old note', 'Is this still true?');
    const pin = asked.json.pin;
    const budget = (await ask('p7', 'Budget', 'Link the real sheet')).json.pin;

    await post(`${route()}/draft`, { actor: 'Wassim', revision: view.doc.revision, changes: [{ kind: 'delete', id: 'p11' }] });
    assert.equal(placePin(block(), pinOf(pin.id)), null);
    assert.equal(eventsOf(store, boardId).at(-1)!.summary, 'edited the draft of Google Doc "Q1 launch plan" in the board context; "Old note", commented on, is no longer there');
    const canvas = (await call('get_canvas', { board_id: boardId })).content[0].text;
    assert.match(canvas, /pinned "Old note" \(paragraph p11; read_google_doc\) \(paragraph removed\) → request to edit the paragraph, comment thread, open/);
    const updates = (await call('get_updates', { board_id: boardId, since: 0 })).content[0].text;
    assert.ok(updates.includes(`Wassim asked you to edit "Q1 launch plan" (draft), paragraph p11 "Old note", which is no longer there: "Is this still true?". Reply in the thread with comment (pin_id: ${pin.id}).`), updates);
    // Undoing the removal brings it back.
    await post(`${route()}/draft`, { actor: 'Wassim', revision: view.doc.revision, changes: [{ kind: 'restore', id: 'p11' }] });
    assert.ok(placePin(block(), pinOf(pin.id)));

    // A paragraph added in the draft, pinned, then removed from it: gone for good.
    const added = (await post(`${route()}/draft`, { actor: 'Wassim', revision: view.doc.revision, changes: [{ kind: 'add', after: 'p1', text: 'A line for now' }] })).json.added[0];
    const onAdded = (await ask(added, 'for now', 'Drop this?', { ask: false })).json.pin;
    await post(`${route()}/draft`, { actor: 'Wassim', revision: view.doc.revision, changes: [{ kind: 'delete', id: added }] });
    assert.equal((pinOf(onAdded.id).anchor as Extract<PinAnchor, { kind: 'doc' }>).gone, true);

    // Saved: the paragraphs are numbered afresh, and pins follow theirs.
    await post(`${route()}/draft`, { actor: 'Wassim', revision: view.doc.revision, changes: [{ kind: 'delete', id: 'p11' }, { kind: 'delete', id: 'p4' }, { kind: 'add', after: 'p1', text: 'Summary' }] });
    const saved = await post(`${route()}/save`, { actor: 'Wassim' });
    assert.equal(saved.json.outcome, 'saved', JSON.stringify(saved.json));
    const after = (await get(route())).json;
    const textOf = (id: string) => after.doc.paragraphs.find((p: DocParagraph) => p.id === id)?.text;
    const budgetAnchor = pinOf(budget.id).anchor as Extract<PinAnchor, { kind: 'doc' }>;
    assert.equal(budgetAnchor.revision, doc.revisionId);
    assert.equal(textOf(budgetAnchor.paragraph), 'Budget: see the sheet.', 'p7 is p7 again: one paragraph added above it, one removed');
    const beta = store.getBoard(boardId).canvas.pins.find((p) => p.quote === 'beta')!;
    assert.match(textOf((beta.anchor as Extract<PinAnchor, { kind: 'doc' }>).paragraph), /^Ship the beta/);
    assert.equal((pinOf(pin.id).anchor as Extract<PinAnchor, { kind: 'doc' }>).gone, true, 'saved away');
    assert.equal(placePin(block(), pinOf(pin.id)), null);

    // Someone adds a paragraph at the top in Google: with no draft, pins follow when the doc is next opened.
    doc.change((d) => d.batchUpdate({ requests: [{ insertText: { location: { index: 1 }, text: 'Draft, do not share\n' } }] }));
    await call('read_google_doc', { block_id: blockId });
    const moved = pinOf(budget.id).anchor as Extract<PinAnchor, { kind: 'doc' }>;
    assert.equal(moved.revision, doc.revisionId);
    const latest = (await get(route())).json;
    assert.equal(latest.doc.paragraphs.find((p: DocParagraph) => p.id === moved.paragraph).text, 'Budget: see the sheet.');
  });

  const block = () => store.blockOf(blockId) as Extract<Block, { type: 'link' }>;
});

describe("A saved doc's paragraph ids", () => {
  it('predicts how the saved doc numbers its paragraphs', () => {
    const doc = launchPlan();
    const before = pulled(doc);
    const { draft } = applyChanges(
      before.paragraphs,
      newDraft(before),
      [
        { kind: 'delete', id: 'p2' },
        { kind: 'add', after: 'p3', text: 'Docs site' },
        { kind: 'text', id: 'p10', text: 'Hiring lags.' },
        { kind: 'delete', id: 'p11' }, // last: emptied, not deleted
        { kind: 'add', after: 'p11', text: 'Vendors may slip.' },
      ],
      wassim,
    );
    const ids = savedIds(before.paragraphs, draft);
    const expected = new Map(draftRows(before.paragraphs, draft).filter((r) => r.state !== 'removed').map((r) => [r.id, r.text || r.locked]));
    doc.batchUpdate({ requests: buildRequests(before.paragraphs, draft), writeControl: { requiredRevisionId: before.revision } });
    const after = pulled(doc).paragraphs;
    for (const [id, text] of expected) {
      const now = after.find((p) => p.id === ids.get(id));
      assert.equal(now?.text || now?.locked, text, `${id} → ${ids.get(id)}`);
    }
    assert.equal(ids.has('p2'), false);
    assert.equal(ids.has('p11'), false);
  });
});

describe('A Google sign-in made before docs were chosen with the Picker', () => {
  let dir: string;
  let google: FakeGoogleServer;
  let server: Server;
  let base: string;
  let store: Store;
  let agent: Client;
  let blockId: string;

  const get = async (route: string) => {
    const response = await fetch(`${base}${route}`);
    return { status: response.status, json: await response.json() };
  };
  const post = async (route: string, body: unknown = {}) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  };
  const call = async (name: string, args: Record<string, unknown>) =>
    (await agent.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  const status = async () => (await get('/api/connectors')).json[0];
  const userinfo = 'https://www.googleapis.com/auth/userinfo.email';

  before(async () => {
    google = new FakeGoogleServer(CLIENT_ID);
    await google.start();
    google.add(launchPlan(DOC_ID));
    dir = mkdtempSync(path.join(os.tmpdir(), '.tricot-docs-legacy-'));
    writeFileSync(
      path.join(dir, 'google-client.json'),
      JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: 'fake-secret', redirect_uris: ['http://localhost'] } }),
    );
    // What the app saved before: all of Drive's file names and every Google Doc.
    const scopes = [DRIVE_METADATA, DOCS_SCOPE, 'openid', userinfo];
    google.tokens.set('legacy-access', scopes);
    mkdirSync(path.join(dir, 'connectors'), { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(dir, 'connectors', 'google.json'),
      JSON.stringify({
        version: 1,
        email: 'wassim@example.com',
        scopes,
        asked: scopes,
        connectedAt: '2026-10-01T10:00:00.000Z',
        accessToken: 'legacy-access',
        refreshToken: 'fake-refresh',
        expiresAt: Date.now() + 3_600_000,
        clientId: CLIENT_ID,
      }),
      { mode: 0o600 },
    );
    store = new Store(dir);
    store.load();
    const connectors = new Connectors({ dataDir: dir, google: { endpoints: google.endpoints(), builtIn: null } });
    const app = createApp(store, { host: '127.0.0.1', mcpUrl: 'unused', connectors });
    server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const boardId = (await post('/api/boards', { actor: 'Wassim', title: 'Launch' })).json.id;
    blockId = (await post('/api/canvas/blocks', { actor: 'Wassim', boardId, content: { type: 'link', url: `https://docs.google.com/document/d/${DOC_ID}/edit` } })).json.id;
    agent = new Client({ name: 'test-agent', version: '1.0.0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp?agent=Planner`)));
  });

  after(async () => {
    await agent.close();
    server.closeAllConnections();
    server.close();
    google.stop();
    await store.flush();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps working: docs open without being chosen, and it says it can switch', async () => {
    const connected = await status();
    assert.equal(connected.state, 'connected');
    assert.match(connected.notice, /from before Tricot asked to see only the Google Docs you choose\. It still works\. Connect again to switch/);
    const granted = connected.access.filter((a: { granted: boolean }) => a.granted).map((a: { scope: string }) => a.scope);
    assert.deepEqual(granted.sort(), ['email', DOCS_SCOPE, DRIVE_METADATA].sort());
    assert.equal(connected.access.find((a: { scope: string }) => a.scope === DRIVE_FILE).granted, false);

    const opened = await get(`/api/connectors/google/docs/${blockId}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.json.doc.title, 'Q1 launch plan');
    const read = await call('read_google_doc', { block_id: blockId });
    assert.ok(!read.isError, read.content[0].text);
    assert.equal((await get(`/api/connectors/google/files/${DOC_ID}`)).json.file.name, 'Q1 launch plan');

    const boards = await call('list_boards', {});
    assert.match(boards.content[0].text, /Google, connected as wassim@example\.com \(Drive file names and dates, Google Docs, read and write\)\. People's link cards show the files' real names; Google Docs on link cards: read_google_doc/);
    // The Picker needs drive.file, which this sign-in doesn't have.
    const picker = await post('/api/connectors/google/picker');
    assert.equal(picker.status, 403);
    assert.equal(picker.json.code, 'no_docs_permission');
    assert.match(picker.json.error, /Connect Google again/);
  });

  it('gets the new, smaller consent when signed in again, and then needs the doc chosen once', async () => {
    const started = await post('/api/connectors/google/start');
    const asked = new URL(started.json.url).searchParams.get('scope')!.split(' ').sort();
    assert.deepEqual(asked, ['email', 'openid', DRIVE_FILE].sort(), 'nothing of the old, wider scopes is kept');
    const back = new URL(google.approve(started.json.url));
    assert.equal((await fetch(`${base}${back.pathname}${back.search}`)).status, 200);

    const connected = await status();
    assert.equal(connected.notice, undefined);
    assert.ok(!connected.account.scopes.includes(DOCS_SCOPE));
    assert.equal((await get(`/api/connectors/google/docs/${blockId}`)).json.code, 'not_picked');
    const refused = await call('read_google_doc', { block_id: blockId });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /a person has to choose it in Google once/);
    const boards = await call('list_boards', {});
    assert.match(boards.content[0].text, /\(Google Docs people choose\)\. People's link cards show the real names of the Google Docs people have chosen; Google Docs people have chosen, on link cards: read_google_doc/);

    google.pick(DOC_ID);
    assert.equal((await get(`/api/connectors/google/docs/${blockId}`)).status, 200);
    assert.ok(!(await call('read_google_doc', { block_id: blockId })).isError);
  });

  it('says so when it was signed in without allowing any docs', async () => {
    google.deny = [DRIVE_FILE];
    const started = await post('/api/connectors/google/start');
    const back = new URL(google.approve(started.json.url));
    assert.equal((await fetch(`${base}${back.pathname}${back.search}`)).status, 200);
    google.deny = [];
    const connected = await status();
    assert.match(connected.notice, /Google didn't let Tricot use any docs/);
    assert.equal((await get(`/api/connectors/google/docs/${blockId}`)).json.code, 'no_docs_permission');
    assert.equal((await post('/api/connectors/google/picker')).json.code, 'no_docs_permission');
    const refused = await call('read_google_doc', { block_id: blockId });
    assert.match(refused.content[0].text, /can't open Google Docs with the sign-in it has/);
  });
});
