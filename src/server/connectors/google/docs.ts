// Google Docs through the Google connector: pulling a doc as paragraphs,
// saving a draft with one batchUpdate, and the drafts people and agents edit
// on link blocks. The access token stays in this process: what goes to the
// browser and to agents is the doc's text and the draft.
//
// The version of a doc a draft started from is kept on this computer
// (<data dir>/connectors/google-docs/<file id>.json, readable by this user
// only), so the board keeps just the changes, and a save can be compared with
// whatever Google has by then.

import path from 'node:path';
import { blockLabel } from '../../../core/canvas';
import {
  applyChanges,
  buildRequests,
  docFileId,
  DocError,
  draftRows,
  followParagraph,
  lockedLabel,
  newDraft,
  readDocument,
  rebaseDraft,
  resolveConflict,
  savedIds,
  type DocChange,
  type DocParagraph,
  type DocRequest,
  type GoogleDocument,
  type PulledDoc,
} from '../../../core/connectors/google/doc';
import type { DocDraftStore, DocFollow } from '../../../core/connectors/google/store';
import { findQuote, quoteAt } from '../../../core/pins';
import type { Store } from '../../../core/store';
import type { Actor, Block, Comment, DocDraft, Pin } from '../../../core/types';
import type { GoogleConnector } from './connector';
import { ConnectorError, readSecretFile, writeSecretFile } from '../oauth';

const FILE_ID = /^[\w-]{10,200}$/;
const KEPT_VERSIONS = 4; // per doc: the one a draft started from, and the latest few

// Google's error answer: { error: { code, message, status, details: [{ reason }] } }.
interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: { reason?: string }[] };
}

async function googleProblem(response: Response): Promise<{ message: string; reason?: string; status?: string }> {
  const body = (await response.json().catch(() => ({}))) as GoogleErrorBody;
  const message = typeof body.error?.message === 'string' ? body.error.message.slice(0, 300) : `HTTP ${response.status}`;
  const reason = body.error?.details?.find((d) => typeof d.reason === 'string')?.reason;
  return { message, reason, status: body.error?.status };
}

export type SaveResult =
  | { ok: true; revision?: string }
  | { ok: false; message: string }; // refused as a bad request: a stale revision, or requests Google won't apply

export class GoogleDocs {
  private versions = new Map<string, PulledDoc[]>(); // file id -> versions pulled, newest last

  constructor(
    readonly google: GoogleConnector,
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  // Throws, in words for people, unless Docs can be opened and edited.
  check(): void {
    switch (this.google.docsAccess()) {
      case 'not_set_up':
        throw new ConnectorError("Google isn't set up in Tricot yet. Set it up on the Connectors page, then come back.", 409, 'not_set_up');
      case 'not_connected':
        throw new ConnectorError("Google isn't connected. Connect it from the Connectors page, then choose this doc.", 409, 'not_connected');
      case 'needs_sign_in':
        throw new ConnectorError('Google needs you to sign in again before Tricot can open this doc.', 409, 'needs_sign_in');
      case 'no_permission':
        throw new ConnectorError(
          "This Google sign-in can't open Google Docs: it's from before Tricot asked to use the docs you choose, or that was unticked on Google's page. Connect Google again from the Connectors page, then choose this doc.",
          403,
          'no_docs_permission',
        );
      case 'ready':
        return;
    }
  }

  // The doc as Google has it now, read as paragraphs, and kept as a version.
  async pull(fileId: string): Promise<PulledDoc> {
    this.check();
    if (!FILE_ID.test(fileId)) throw new DocError("That isn't a Google Doc's id.");
    const response = await this.google.authorized(
      `${this.google.docsBase}/documents/${encodeURIComponent(fileId)}?suggestionsViewMode=SUGGESTIONS_INLINE`,
    );
    if (!response.ok) throw await this.problem(response, 'open');
    const read = readDocument((await response.json()) as GoogleDocument);
    if (!read.revision) {
      throw new ConnectorError(
        `${this.account()} can view this doc but not edit it, so there's nothing to save to. Ask its owner for edit access.`,
        403,
        'view_only',
      );
    }
    const doc: PulledDoc = { fileId, revision: read.revision, title: read.title, paragraphs: read.paragraphs, pulledAt: new Date(this.now()).toISOString() };
    this.keep(doc);
    return doc;
  }

  // A version pulled earlier, if this computer still has it.
  version(fileId: string, revision: string): PulledDoc | undefined {
    return this.load(fileId).find((v) => v.revision === revision);
  }

  // Applies the requests, only if the doc is still at `revision`
  // (writeControl.requiredRevisionId). Google answers a stale revision with a
  // 400, as it does requests it won't apply; the caller tells them apart by
  // pulling the doc again.
  async batchUpdate(fileId: string, requests: DocRequest[], revision: string): Promise<SaveResult> {
    this.check();
    const response = await this.google.authorized(
      `${this.google.docsBase}/documents/${encodeURIComponent(fileId)}:batchUpdate`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revision } }),
      },
      30_000,
    );
    if (response.ok) {
      const data = (await response.json().catch(() => ({}))) as { writeControl?: { requiredRevisionId?: string } };
      return { ok: true, revision: data.writeControl?.requiredRevisionId };
    }
    if (response.status === 400) return { ok: false, message: (await googleProblem(response)).message };
    throw await this.problem(response, 'save');
  }

  private account(): string {
    return this.google.email() ?? 'The connected Google account';
  }

  private async problem(response: Response, action: 'open' | 'save'): Promise<ConnectorError> {
    const { message, reason, status } = await googleProblem(response);
    if (response.status === 403 && (reason === 'SERVICE_DISABLED' || /has not been used|is disabled/i.test(message))) {
      if (this.google.clientSource() === 'built-in') {
        return new ConnectorError("Google's Docs service isn't available to Tricot right now. Try again later.", 502, 'docs_api_off');
      }
      return new ConnectorError(
        'The Google Docs API is turned off in your Google Cloud project. Turn it on (APIs & Services → Library → Google Docs API), wait a minute, then try again.',
        409,
        'docs_api_off',
      );
    }
    if (response.status === 403 && (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || /insufficient.*scope/i.test(message))) {
      return new ConnectorError("Google says this sign-in can't open Google Docs. Connect Google again from the Connectors page.", 403, 'no_docs_permission');
    }
    // With only the docs a person chose, Google answers a doc not chosen yet as not found or not allowed.
    if (this.google.chosenDocsOnly() && (response.status === 403 || response.status === 404 || status === 'PERMISSION_DENIED')) {
      return new ConnectorError('Choose this doc in Google once to let Tricot open it.', 403, 'not_picked');
    }
    if (response.status === 403 || status === 'PERMISSION_DENIED') {
      return new ConnectorError(
        `Google won't let ${this.google.email() ?? 'the connected account'} ${action} this doc. Check it's shared with that account${action === 'save' ? ', with edit access' : ''}.`,
        403,
        'forbidden',
      );
    }
    if (response.status === 404) {
      return new ConnectorError(`Google can't find this doc. It may have been deleted, or it isn't shared with ${this.google.email() ?? 'the connected account'}.`, 404, 'not_found');
    }
    if (response.status === 429) return new ConnectorError('Google is limiting how often Tricot can ask. Wait a minute, then try again.', 429, 'rate_limited');
    return new ConnectorError(`Google couldn't ${action} the doc (${message}).`, 502, 'google');
  }

  // ---- versions kept on this computer -------------------------------------------

  private file(fileId: string): string {
    return path.join(this.dataDir, 'connectors', 'google-docs', `${fileId}.json`);
  }

  private load(fileId: string): PulledDoc[] {
    let versions = this.versions.get(fileId);
    if (!versions) {
      try {
        versions = readSecretFile<{ versions?: PulledDoc[] }>(this.file(fileId))?.versions ?? [];
      } catch {
        versions = [];
      }
      this.versions.set(fileId, versions);
    }
    return versions;
  }

  private keep(doc: PulledDoc): void {
    const versions = [...this.load(doc.fileId).filter((v) => v.revision !== doc.revision), doc].slice(-KEPT_VERSIONS);
    this.versions.set(doc.fileId, versions);
    try {
      writeSecretFile(this.file(doc.fileId), { versions });
    } catch (error) {
      console.error('Could not keep a Google Doc version:', (error as Error)?.message);
    }
  }
}

type LinkBlock = Extract<Block, { type: 'link' }>;

export interface DocView {
  doc: PulledDoc; // the version the draft applies to (the latest, with no draft)
  draft?: DocDraft;
}

export type SaveOutcome =
  | { outcome: 'saved'; paragraphs: number; revision?: string }
  | { outcome: 'conflict'; conflicts: number; theirs: number; draft: DocDraft };

// Words a person selected in a paragraph, with what they ask or say about them.
export interface DocPinInput {
  paragraph: string; // its id in the version shown
  revision: string; // the version shown
  quote: string;
  prefix?: string;
  suffix?: string;
  body: string;
  ask: boolean; // asking agents to edit the paragraph, or only commenting
}

// The drafts on link blocks: read, edited by people and agents, saved by
// people. One save at a time per block, and no edits while it runs, so what's
// saved is what was there when Save was pressed.
export class DocDrafts {
  private saving = new Set<string>();

  // The drafts are kept with Google's part of the store (core/connectors/google/store.ts).
  private readonly parts: DocDraftStore;

  constructor(
    private readonly store: Store,
    readonly docs: GoogleDocs,
  ) {
    this.parts = store.connectorStore<DocDraftStore>('google');
  }

  private linkOf(blockId: string): { block: LinkBlock; fileId: string } {
    const block = this.store.blockOf(blockId);
    const fileId = block.type === 'link' ? docFileId(block.url) : undefined;
    if (block.type !== 'link' || !fileId) throw new DocError(`${blockLabel(block)} isn't a link to a Google Doc.`);
    return { block, fileId };
  }

  // What to call the doc: the card's title, or the doc's own.
  name(blockId: string, doc?: PulledDoc): string {
    const { block } = this.linkOf(blockId);
    return block.title || doc?.title || block.docDraft?.title || 'Untitled';
  }

  // The doc and its draft. With no draft, the doc as Google has it now. A
  // draft whose version this computer no longer has is moved onto the latest.
  // Pins on the doc's paragraphs follow it onto the version opened.
  async open(blockId: string, actor: Actor): Promise<DocView> {
    const { block, fileId } = this.linkOf(blockId);
    this.docs.check();
    const draft = block.docDraft;
    if (!draft) {
      const doc = await this.docs.pull(fileId);
      this.followOnto(blockId, fileId, doc, actor);
      return { doc };
    }
    const base = this.docs.version(fileId, draft.revision);
    if (base) return { doc: base, draft };
    const latest = await this.docs.pull(fileId);
    const now = this.linkOf(blockId).block.docDraft;
    if (!now || latest.revision === now.revision) return { doc: latest, draft: now };
    if (now.conflicts?.length) throw new DocError('This draft is waiting for a person to choose between versions, and the version it needs is gone. Discard it and start again.', 409);
    const rebased = rebaseDraft(null, latest, now);
    this.parts.setDocDraft(blockId, rebased, actor, { kind: 'conflict', conflicts: rebased.conflicts?.length ?? 0 }, this.follow(now, rebased, null, latest));
    return { doc: latest, draft: rebased };
  }

  // Pins left on earlier versions of a doc with no draft (it changed in
  // Google since) follow their paragraphs onto `latest`.
  private followOnto(blockId: string, fileId: string, latest: PulledDoc, actor: Actor): void {
    const earlier = new Set(
      this.store
        .canvasOf(blockId)
        .canvas.pins.flatMap((p) => (p.blockId === blockId && p.anchor.kind === 'doc' && !p.anchor.gone && p.anchor.revision !== latest.revision ? [p.anchor.revision] : [])),
    );
    for (const revision of earlier) {
      const before = this.docs.version(fileId, revision)?.paragraphs ?? null;
      this.parts.followDocPins(blockId, { from: revision, to: latest.revision, paragraph: followParagraph(before, latest.paragraphs) }, actor);
    }
  }

  // How pins follow a draft moved onto a newer version: a paragraph of the
  // doc to its counterpart, one added in the draft to itself while it's kept.
  private follow(draft: DocDraft, rebased: DocDraft, base: DocParagraph[] | null, latest: PulledDoc): DocFollow {
    const find = followParagraph(base, latest.paragraphs);
    const added = new Set(rebased.edits.flatMap((e) => (e.op === 'add' ? [e.id] : [])));
    return {
      from: draft.revision,
      to: rebased.revision,
      paragraph: (id, words) => (id.startsWith('n') ? (added.has(id) ? id : null) : find(id, words)),
    };
  }

  // A person pins words in a paragraph, asking agents to edit it or only
  // commenting: checked against the doc and the draft as they are now.
  async pin(blockId: string, input: DocPinInput, actor: Actor): Promise<{ pin: Pin; comment: Comment }> {
    this.notSaving(blockId);
    const view = await this.open(blockId, actor);
    if (input.revision !== view.doc.revision) {
      throw new DocError('The doc moved to a newer version since these words were selected. Select them again.', 409);
    }
    const row = draftRows(view.doc.paragraphs, view.draft).find((r) => r.id === input.paragraph);
    if (!row || row.state === 'removed') throw new DocError(`That paragraph isn't in the draft any more.`, 409);
    if (row.locked) throw new DocError(`That's ${lockedLabel(row)}: pin words in a paragraph of text.`);
    const at = findQuote(row.text, input.quote, input);
    if (!at) throw new DocError("Those words aren't in the paragraph any more. Select them again.", 409);
    const { quote, prefix, suffix } = quoteAt(row.text, at.start, at.end)!;
    const part = { kind: 'doc' as const, paragraph: row.id, revision: view.doc.revision, quote, prefix, suffix, title: view.doc.title };
    return this.store.pinComment(blockId, part, input.body, actor, { ask: input.ask });
  }

  // Changes the draft (starting one on the version shown). `revision`, when
  // given, is the version the changes were made against: refused if the
  // draft has moved on since, as paragraph ids belong to a version.
  async edit(blockId: string, revision: string | undefined, changes: DocChange[], actor: Actor): Promise<{ draft?: DocDraft; added: string[]; doc: PulledDoc }> {
    if (changes.length === 0) throw new DocError('No changes to make.');
    this.notSaving(blockId);
    const { block, fileId } = this.linkOf(blockId);
    this.docs.check();
    // A first change starts the draft on the version it was made against, when
    // this computer has it; else on the latest.
    const shown = !block.docDraft && revision ? this.docs.version(fileId, revision) : undefined;
    const doc = shown ?? (await this.open(blockId, actor)).doc;
    this.notSaving(blockId);
    const current = this.linkOf(blockId).block.docDraft;
    if (current && current.revision !== doc.revision) {
      throw new DocError('The draft just moved to a newer version of the doc. Read it again, then make the change.', 409);
    }
    if (revision && revision !== doc.revision) {
      throw new DocError(`The draft is on revision ${doc.revision} now, not ${revision}: paragraph ids may point elsewhere. Read it again, then make the change.`, 409);
    }
    const { draft, added } = applyChanges(doc.paragraphs, current ?? newDraft(doc), changes, actor);
    const kept = draft.edits.length || draft.conflicts?.length ? draft : undefined;
    this.parts.setDocDraft(blockId, kept, actor, { kind: 'edited' });
    return { draft: kept, added, doc };
  }

  discard(blockId: string, actor: Actor): void {
    this.notSaving(blockId);
    if (!this.linkOf(blockId).block.docDraft) return;
    this.parts.setDocDraft(blockId, undefined, actor, { kind: 'discarded' });
  }

  // Sends Google the draft's changes as one batchUpdate on the version they
  // were made against. If Google has a newer version, nothing is overwritten:
  // the draft moves onto it, with what both sides changed left for a person.
  async save(blockId: string, actor: Actor): Promise<SaveOutcome> {
    const { fileId, block } = this.linkOf(blockId);
    const draft = block.docDraft;
    if (!draft?.edits.length) throw new DocError('There is nothing to save: the draft has no changes.');
    if (draft.conflicts?.length) {
      throw new DocError(`Choose which version to keep for ${draft.conflicts.length === 1 ? 'the paragraph' : `${draft.conflicts.length} paragraphs`} first.`, 409);
    }
    this.notSaving(blockId);
    this.saving.add(blockId);
    try {
      this.docs.check();
      let base = this.docs.version(fileId, draft.revision);
      if (!base) {
        const latest = await this.docs.pull(fileId);
        if (latest.revision !== draft.revision) return this.moveOnto(blockId, null, latest, draft, actor);
        base = latest;
      }
      const result = await this.docs.batchUpdate(fileId, buildRequests(base.paragraphs, draft), draft.revision);
      if (result.ok) {
        // The saved doc numbers its paragraphs afresh; pins follow theirs.
        const ids = savedIds(base.paragraphs, draft);
        const follow: DocFollow | undefined = result.revision ? { from: draft.revision, to: result.revision, paragraph: (id) => ids.get(id) ?? null } : undefined;
        this.parts.setDocDraft(blockId, undefined, actor, { kind: 'saved', paragraphs: draft.edits.length }, follow);
        return { outcome: 'saved', paragraphs: draft.edits.length, revision: result.revision };
      }
      // Refused: someone changed the doc since, or Google won't apply it.
      const latest = await this.docs.pull(fileId);
      if (latest.revision === draft.revision) throw new DocError(`Google didn't accept the changes: ${result.message}`, 502);
      return this.moveOnto(blockId, base.paragraphs, latest, draft, actor);
    } finally {
      this.saving.delete(blockId);
    }
  }

  private moveOnto(blockId: string, base: PulledDoc['paragraphs'] | null, latest: PulledDoc, draft: DocDraft, actor: Actor): SaveOutcome {
    const rebased = rebaseDraft(base, latest, draft);
    const conflicts = rebased.conflicts?.length ?? 0;
    const follow = this.follow(draft, rebased, base, latest);
    this.parts.setDocDraft(blockId, rebased.edits.length || conflicts ? rebased : undefined, actor, { kind: 'conflict', conflicts }, follow);
    return { outcome: 'conflict', conflicts, theirs: rebased.rebased?.theirs ?? 0, draft: rebased };
  }

  // A person keeps the draft's version of a paragraph, or takes Google's.
  async resolve(blockId: string, conflictId: string, keep: 'mine' | 'theirs', actor: Actor): Promise<DocDraft | undefined> {
    this.notSaving(blockId);
    const view = await this.open(blockId, actor);
    const draft = this.linkOf(blockId).block.docDraft;
    if (!draft?.conflicts?.length) throw new DocError('This draft has nothing to choose between.', 409);
    if (draft.revision !== view.doc.revision) throw new DocError('The draft moved on. Open it again.', 409);
    const next = resolveConflict(view.doc.paragraphs, draft, conflictId, keep);
    const kept = next.edits.length || next.conflicts?.length ? next : undefined;
    this.parts.setDocDraft(blockId, kept, actor, { kind: 'resolved' });
    return kept;
  }

  private notSaving(blockId: string): void {
    if (this.saving.has(blockId)) throw new DocError('This draft is being saved to Google right now. Try again in a moment.', 409);
  }
}
