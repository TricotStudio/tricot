// A fake Google, for tests and scratch servers: its token endpoint, Drive's
// file lookup and the Docs API (documents.get and documents.batchUpdate),
// never the real one. A doc is a flat run of characters, as Google indexes
// them: a section break at 0, each paragraph's text then its newline (which
// carries the paragraph's style and bullet), tables as opaque runs. Requests
// are checked the way Google checks them (no deleting the body's last
// newline, no text inside a table, writeControl.requiredRevisionId) and a
// batch applies all or nothing.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  link?: { url: string };
}

interface Char {
  ch: string;
  style: TextStyle;
  para?: { namedStyleType: string; bullet?: { listId: string; nestingLevel: number }; alignment?: string };
  image?: string;
  table?: { id: string; rows: number; columns: number; header: string[] };
  section?: true;
  comment?: string; // a comment anchored on this character
}

export type FakeContent =
  | {
      runs: ({ text: string; comment?: string } & TextStyle | { image: string })[];
      style?: string;
      bullet?: { listId: string; level?: number };
      alignment?: string;
    }
  | { table: { rows: number; columns: number; header: string[] } };

export class GoogleRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly googleStatus = 'INVALID_ARGUMENT',
  ) {
    super(message);
  }
}

const clone = <T>(value: T): T => structuredClone(value);

export class FakeDoc {
  chars: Char[];
  lists: Record<string, { ordered: boolean }>;
  revision = 1;
  private nextList = 1;

  constructor(
    readonly id: string,
    public title: string,
    content: FakeContent[],
    lists: Record<string, { ordered: boolean }> = {},
  ) {
    this.lists = clone(lists);
    this.chars = [{ ch: '', style: {}, section: true }];
    let tables = 0;
    for (const item of content) {
      if ('table' in item) {
        const table = { id: `t${++tables}`, ...item.table };
        const length = 2 + item.table.rows * (1 + item.table.columns * 2);
        for (let i = 0; i < length; i++) this.chars.push({ ch: '', style: {}, table });
        continue;
      }
      for (const run of item.runs) {
        if ('image' in run) this.chars.push({ ch: '', style: {}, image: run.image });
        else {
          const { text, comment, ...style } = run;
          for (const unit of text.split('')) this.chars.push({ ch: unit, style: { ...style }, ...(comment ? { comment } : {}) });
        }
      }
      this.chars.push({
        ch: '\n',
        style: {},
        para: {
          namedStyleType: item.style ?? 'NORMAL_TEXT',
          ...(item.bullet ? { bullet: { listId: item.bullet.listId, nestingLevel: item.bullet.level ?? 0 } } : {}),
          ...(item.alignment ? { alignment: item.alignment } : {}),
        },
      });
    }
  }

  get revisionId(): string {
    return `rev-${this.id.slice(0, 6)}-${this.revision}`;
  }

  // Someone editing in Google: any change, then a new revision.
  change(edit: (doc: FakeDoc) => void): void {
    edit(this);
    this.revision++;
  }

  // ---- documents.get ----------------------------------------------------------

  toJSON(): Record<string, unknown> {
    const content: Record<string, unknown>[] = [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }];
    let i = 1;
    while (i < this.chars.length) {
      const c = this.chars[i];
      if (c.table) {
        let end = i;
        while (end < this.chars.length && this.chars[end].table?.id === c.table.id) end++;
        const cell = (text: string) => ({ content: [{ paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }] });
        content.push({
          startIndex: i,
          endIndex: end,
          table: {
            rows: c.table.rows,
            columns: c.table.columns,
            tableRows: Array.from({ length: c.table.rows }, (_, r) => ({
              tableCells: Array.from({ length: c.table!.columns }, (_, k) => cell(r === 0 ? (c.table!.header[k] ?? '') : `r${r}c${k}`)),
            })),
          },
        });
        i = end;
        continue;
      }
      let end = i;
      while (this.chars[end].ch !== '\n') end++;
      const elements: Record<string, unknown>[] = [];
      let k = i;
      while (k <= end) {
        const ch = this.chars[k];
        if (ch.image) {
          elements.push({ startIndex: k, endIndex: k + 1, inlineObjectElement: { inlineObjectId: ch.image, textStyle: {} } });
          k++;
          continue;
        }
        let j = k;
        const same = JSON.stringify(ch.style);
        while (j <= end && !this.chars[j].image && JSON.stringify(this.chars[j].style) === same) j++;
        elements.push({ startIndex: k, endIndex: j, textRun: { content: this.chars.slice(k, j).map((x) => x.ch).join(''), textStyle: clone(ch.style) } });
        k = j;
      }
      const para = this.chars[end].para!;
      content.push({
        startIndex: i,
        endIndex: end + 1,
        paragraph: {
          elements,
          paragraphStyle: { namedStyleType: para.namedStyleType, ...(para.alignment ? { alignment: para.alignment } : {}) },
          ...(para.bullet ? { bullet: clone(para.bullet) } : {}),
        },
      });
      i = end + 1;
    }
    const lists = Object.fromEntries(
      Object.entries(this.lists).map(([id, list]) => [
        id,
        { listProperties: { nestingLevels: [list.ordered ? { glyphType: 'DECIMAL', glyphFormat: '%0.' } : { glyphSymbol: '●' }] } },
      ]),
    );
    return { documentId: this.id, title: this.title, revisionId: this.revisionId, body: { content }, lists };
  }

  // ---- documents.batchUpdate ----------------------------------------------------

  batchUpdate(body: { requests?: Record<string, any>[]; writeControl?: { requiredRevisionId?: string } }): Record<string, unknown> {
    const required = body.writeControl?.requiredRevisionId;
    if (required && required !== this.revisionId) {
      // What Google's answer looks like is an assumption; Tricot only relies on the 400.
      throw new GoogleRefusal(400, `The required revision ID "${required}" does not match the latest revision of the document.`, 'FAILED_PRECONDITION');
    }
    const saved = { chars: clone(this.chars), lists: clone(this.lists), nextList: this.nextList };
    try {
      (body.requests ?? []).forEach((request, n) => this.apply(request, n));
    } catch (error) {
      Object.assign(this, saved);
      throw error;
    }
    this.revision++;
    return { documentId: this.id, replies: (body.requests ?? []).map(() => ({})), writeControl: { requiredRevisionId: this.revisionId } };
  }

  private bad(n: number, message: string): never {
    throw new GoogleRefusal(400, `Invalid requests[${n}]: ${message}`);
  }

  // The paragraphs overlapping [start, end): each one's newline index.
  private newlinesIn(start: number, end: number): number[] {
    const found: number[] = [];
    let paraStart = 1;
    for (let i = 1; i < this.chars.length; i++) {
      const c = this.chars[i];
      if (c.table) {
        paraStart = i + 1;
        continue;
      }
      if (c.ch === '\n') {
        if (paraStart < end && i + 1 > start) found.push(i);
        paraStart = i + 1;
      }
    }
    return found;
  }

  private apply(request: Record<string, any>, n: number): void {
    const [kind] = Object.keys(request);
    const r = request[kind];
    const last = this.chars.length - 1; // the body's final newline
    const checkRange = (range: { startIndex?: number; endIndex?: number } | undefined) => {
      const start = range?.startIndex ?? 0;
      const end = range?.endIndex ?? 0;
      if (!(start >= 1 && end > start && end <= this.chars.length)) this.bad(n, `the range ${start}..${end} is out of bounds`);
      return { start, end };
    };
    switch (kind) {
      case 'deleteContentRange': {
        const { start, end } = checkRange(r.range);
        if (end > last) this.bad(n, 'the range cannot include the newline character at the end of the segment');
        if (this.chars.slice(start, end).some((c) => c.table || c.section)) this.bad(n, 'deleting part of a table is not allowed');
        this.chars.splice(start, end - start);
        return;
      }
      case 'insertText': {
        const index = r.location?.index;
        const text: string = r.text ?? '';
        if (!(Number.isInteger(index) && index >= 1 && index <= last)) this.bad(n, `index ${index} must be inside the bounds of an existing paragraph`);
        if (this.chars[index].table) this.bad(n, 'text cannot be inserted inside a table or at its start index');
        const before = this.chars[index - 1];
        const style = before && !before.table && !before.section && !before.image && before.ch !== '\n' ? clone(before.style) : {};
        let next = index;
        while (this.chars[next].ch !== '\n') next++;
        const para = this.chars[next].para!;
        // By UTF-16 code unit, as Google counts.
        const added = text.split('').map((unit): Char => (unit === '\n' ? { ch: '\n', style: {}, para: clone(para) } : { ch: unit, style: clone(style) }));
        this.chars.splice(index, 0, ...added);
        return;
      }
      case 'updateParagraphStyle': {
        const { start, end } = checkRange(r.range);
        if (r.fields !== 'namedStyleType') this.bad(n, `fields ${r.fields} not supported by the fake`);
        for (const i of this.newlinesIn(start, end)) this.chars[i].para!.namedStyleType = r.paragraphStyle.namedStyleType;
        return;
      }
      case 'updateTextStyle': {
        const { start, end } = checkRange(r.range);
        for (let i = start; i < end; i++) {
          const c = this.chars[i];
          if (c.table || c.section) continue;
          if (r.fields === '*') c.style = clone(r.textStyle ?? {});
          else for (const field of String(r.fields).split(',')) {
            const key = field.trim() as keyof TextStyle;
            if (r.textStyle?.[key] === undefined) delete c.style[key];
            else (c.style as Record<string, unknown>)[key] = r.textStyle[key];
          }
        }
        return;
      }
      case 'createParagraphBullets': {
        const { start, end } = checkRange(r.range);
        const listId = `kix.new${this.nextList++}`;
        this.lists[listId] = { ordered: String(r.bulletPreset).startsWith('NUMBERED') };
        for (const i of this.newlinesIn(start, end)) this.chars[i].para!.bullet = { listId, nestingLevel: 0 };
        return;
      }
      case 'deleteParagraphBullets': {
        const { start, end } = checkRange(r.range);
        for (const i of this.newlinesIn(start, end)) delete this.chars[i].para!.bullet;
        return;
      }
      default:
        this.bad(n, `${kind} is not a request the fake knows`);
    }
  }

  // ---- reading it back, for tests ------------------------------------------------

  paragraphs(): { text: string; style: string; list?: 'bullet' | 'numbered'; listId?: string; bold: string; links: string; comments: string[]; images: string[]; alignment?: string }[] {
    const out: ReturnType<FakeDoc['paragraphs']> = [];
    let current: Char[] = [];
    for (let i = 1; i < this.chars.length; i++) {
      const c = this.chars[i];
      if (c.table) {
        if (this.chars[i - 1]?.table?.id !== c.table.id) out.push({ text: `[table ${c.table.header.join('|')}]`, style: 'TABLE', bold: '', links: '', comments: [], images: [] });
        continue;
      }
      if (c.ch !== '\n') {
        current.push(c);
        continue;
      }
      const bullet = c.para!.bullet;
      out.push({
        text: current.map((x) => (x.image ? '[image]' : x.ch)).join(''),
        style: c.para!.namedStyleType,
        ...(bullet ? { list: this.lists[bullet.listId]?.ordered ? 'numbered' : 'bullet', listId: bullet.listId } : {}),
        bold: current.filter((x) => x.style.bold).map((x) => x.ch).join(''),
        links: current.filter((x) => x.style.link).map((x) => x.ch).join(''),
        comments: [...new Set(current.flatMap((x) => (x.comment ? [x.comment] : [])))],
        images: current.flatMap((x) => (x.image ? [x.image] : [])),
        ...(c.para!.alignment ? { alignment: c.para!.alignment } : {}),
      });
      current = [];
    }
    return out;
  }
}

// ---- the server ---------------------------------------------------------------

export const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
export const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_METADATA = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const BASE_SCOPES = `${DRIVE_FILE} openid https://www.googleapis.com/auth/userinfo.email`;

async function readBody(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

// Token, revoke, Drive and Docs endpoints. Sign-ins approve on their own
// (`approve` for tests, or /auth redirecting straight back for a browser),
// granting the scopes asked for, unless `deny` lists some to leave out. A
// token with drive.file reaches only the docs a person chose in the Picker
// (`pick`); any other doc is not found, as Google answers (`hidden`). The
// earlier scopes, documents and drive.metadata.readonly, reach every doc.
export class FakeGoogleServer {
  server!: Server;
  base = '';
  docs = new Map<string, FakeDoc>();
  files: Record<string, { name: string; modifiedTime: string }> = {};
  tokens = new Map<string, string[]>(); // access token -> scopes
  deny: string[] = [];
  picked = new Set<string>(); // the docs a person chose in the Picker
  hidden = 404; // how a doc that was not chosen answers a drive.file token
  calls: { method: string; path: string; body?: unknown }[] = [];
  docsApiOff = false;
  private codes = new Map<string, { challenge: string; scopes: string[] }>();
  private issued = 0;

  constructor(
    readonly clientId: string,
    readonly email = 'wassim@example.com',
  ) {}

  pick(...ids: string[]): void {
    for (const id of ids) this.picked.add(id);
  }

  private sees(scopes: string[], id: string): boolean {
    return scopes.includes(DOCS_SCOPE) || scopes.includes(DRIVE_METADATA) || (scopes.includes(DRIVE_FILE) && this.picked.has(id));
  }

  add(doc: FakeDoc): FakeDoc {
    this.docs.set(doc.id, doc);
    this.files[doc.id] = { name: doc.title, modifiedTime: new Date().toISOString() };
    return doc;
  }

  async start(port = 0): Promise<void> {
    this.server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const text = await readBody(req);
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const fail = (status: number, message: string, googleStatus: string, reason?: string) =>
        json(status, { error: { code: status, message, status: googleStatus, ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } : {}) } });
      if (url.pathname === '/auth') {
        res.writeHead(302, { Location: this.approve(url.href) });
        return res.end();
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(text);
        if (form.get('client_id') !== this.clientId) return json(401, { error: 'invalid_client' });
        if (form.get('grant_type') === 'authorization_code') {
          const code = this.codes.get(form.get('code') ?? '');
          const verifier = form.get('code_verifier') ?? '';
          if (!code || createHash('sha256').update(verifier).digest('base64url') !== code.challenge) return json(400, { error: 'invalid_grant' });
          this.codes.delete(form.get('code')!);
          return json(200, this.token(code.scopes, true));
        }
        if (form.get('grant_type') === 'refresh_token') {
          const scopes = [...this.tokens.values()].at(-1) ?? BASE_SCOPES.split(' ');
          return json(200, this.token(scopes, false));
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/revoke') return json(200, {});
      const scopes = this.tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const file = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
      if (file) {
        if (!scopes) return fail(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED');
        const found = this.files[decodeURIComponent(file[1])];
        return found && this.sees(scopes, decodeURIComponent(file[1])) ? json(200, found) : fail(404, 'File not found', 'NOT_FOUND');
      }
      const doc = url.pathname.match(/^\/docs\/v1\/documents\/([^/:]+)(:batchUpdate)?$/);
      if (doc) {
        const body = text ? JSON.parse(text) : undefined;
        this.calls.push({ method: req.method ?? 'GET', path: url.pathname, body });
        if (!scopes) return fail(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED');
        if (this.docsApiOff) {
          return fail(403, 'Google Docs API has not been used in project 123 before or it is disabled.', 'PERMISSION_DENIED', 'SERVICE_DISABLED');
        }
        if (!scopes.includes(DOCS_SCOPE) && !scopes.includes(DRIVE_FILE)) {
          return fail(403, 'Request had insufficient authentication scopes.', 'PERMISSION_DENIED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
        }
        const found = this.docs.get(decodeURIComponent(doc[1]));
        if (!found || !this.sees(scopes, found.id)) {
          return this.hidden === 403
            ? fail(403, 'The caller does not have permission', 'PERMISSION_DENIED')
            : fail(404, 'Requested entity was not found.', 'NOT_FOUND');
        }
        if (!doc[2]) {
          if (req.method !== 'GET') return fail(405, 'Method not allowed', 'INVALID_ARGUMENT');
          assert(url.searchParams.get('suggestionsViewMode') === 'SUGGESTIONS_INLINE', 'pulls with suggestions inline');
          return json(200, found.toJSON());
        }
        try {
          return json(200, found.batchUpdate(body));
        } catch (error) {
          if (error instanceof GoogleRefusal) return fail(error.status, error.message, error.googleStatus);
          throw error;
        }
      }
      json(404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } });
    });
    await new Promise<void>((resolve) => this.server.listen(port, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  endpoints() {
    return {
      auth: `${this.base}/auth`,
      token: `${this.base}/token`,
      revoke: `${this.base}/revoke`,
      drive: `${this.base}/drive/v3`,
      docs: `${this.base}/docs/v1`,
    };
  }

  // The person allows access on Google's page: back to the redirect, with a code.
  approve(authUrl: string): string {
    const url = new URL(authUrl);
    const code = `code-${++this.issued}`;
    const asked = (url.searchParams.get('scope') ?? '').split(' ').map((s) => (s === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : s));
    this.codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', scopes: asked.filter((s) => !this.deny.includes(s)) });
    const back = new URL(url.searchParams.get('redirect_uri')!);
    back.searchParams.set('state', url.searchParams.get('state')!);
    back.searchParams.set('code', code);
    return back.href;
  }

  private token(scopes: string[], first: boolean) {
    const access = `fake-access-${++this.issued}`;
    this.tokens.set(access, scopes);
    return {
      access_token: access,
      ...(first ? { refresh_token: 'fake-refresh' } : {}),
      expires_in: 3599,
      token_type: 'Bearer',
      scope: scopes.join(' '),
      ...(first ? { id_token: `${part({ alg: 'none' })}.${part({ aud: this.clientId, email: this.email })}.` } : {}),
    };
  }

  stop(): void {
    this.server.closeAllConnections();
    this.server.close();
  }
}

function assert(ok: boolean, what: string): void {
  if (!ok) throw new Error(`Fake Google: expected ${what}`);
}
