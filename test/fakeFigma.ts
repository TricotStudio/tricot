import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';

// A stand-in for api.figma.com: the endpoints Tricot reads (me, a file, a
// frame's nodes, rendered images, comments) and the pictures it points to. It
// checks the token header and records every request, with the token it carried,
// so tests can say where the token went. Nothing here reaches the network.

export const VALID_TOKEN = 'figd_valid-token-0123456789';
export const OTHER_TOKEN = 'figd_other-token-9876543210';
export const NO_USER_SCOPE_TOKEN = 'figd_no-user-scope-0123456789';

export interface FakeNode {
  id: string;
  name: string;
  children?: FakeNode[];
}

export interface FakeComment {
  id: string;
  parent_id?: string;
  message: string;
  created_at: string;
  resolved_at?: string | null;
  user: { handle: string };
  client_meta: { node_id: string } | { x: number; y: number };
}

export interface FakeFile {
  name: string;
  lastModified: string;
  nodes: Record<string, FakeNode>; // by id: the frames a link can point to
  comments: FakeComment[];
}

export interface FakeRequest {
  path: string;
  token?: string;
}

// A real PNG, drawn as a plain mock screen: a bar and a few cards, in colours
// that follow `seed`, so a picture drawn again with another seed differs.
export function drawPng(width: number, height: number, seed = 0): Buffer {
  const rows: Buffer[] = [];
  const hue = (n: number) => [(60 + n * 53 + seed * 37) % 200 + 30, (120 + n * 31 + seed * 17) % 180 + 40, (200 + n * 17 + seed * 71) % 140 + 80];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      let colour = [248, 248, 246];
      if (y < height * 0.12) colour = hue(0);
      else if (y > height * 0.2 && y < height * 0.55 && x > width * 0.08 && x < width * 0.46) colour = hue(1);
      else if (y > height * 0.2 && y < height * 0.55 && x > width * 0.54 && x < width * 0.92) colour = hue(2);
      else if (y > height * 0.65 && y < height * 0.8 && x > width * 0.08 && x < width * 0.6) colour = hue(3);
      row.set(colour, 1 + x * 3);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const FILE_KEY = 'aBcD1234eFgH5678iJkL90';
export const FRAME = '12:34';
export const OTHER_FRAME = '12:99';

export class FakeFigma {
  server!: Server;
  base = '';
  tokens = new Map<string, string>([
    [VALID_TOKEN, 'ada'],
    [OTHER_TOKEN, 'grace'],
  ]);
  revoked = new Set<string>();
  requests: FakeRequest[] = [];
  seed = 1; // what the pictures show: change it and a frame draws differently
  rateLimited = 0; // answer this many API calls with 429 (Retry-After: 60)
  tooBigAbove = Infinity; // a picture drawn above this scale comes back huge
  unrenderable = new Set<string>(); // nodes whose picture Figma can't draw (null)
  commentsRefused: string | null = null; // Figma's words for refusing the comments call (403)
  down = false; // Figma can't be reached: every connection is dropped
  hidden = new Set<string>(); // file keys the token can't see
  files: Record<string, FakeFile> = {
    [FILE_KEY]: {
      name: 'Onboarding designs',
      lastModified: '2026-10-29T10:00:00Z',
      nodes: {
        [FRAME]: { id: FRAME, name: 'Welcome screen', children: [{ id: '12:40', name: 'Button' }, { id: '12:41', name: 'Hero', children: [{ id: '12:42', name: 'Title' }] }] },
        [OTHER_FRAME]: { id: OTHER_FRAME, name: 'Pricing', children: [{ id: '12:100', name: 'Plans' }] },
      },
      comments: [
        { id: 'c1', message: 'Make the button larger', created_at: '2026-10-28T09:30:00Z', resolved_at: null, user: { handle: 'Sam' }, client_meta: { node_id: '12:40' } },
        { id: 'c2', parent_id: 'c1', message: 'Done, 48px now', created_at: '2026-10-28T11:00:00Z', user: { handle: 'Ada' }, client_meta: { node_id: '12:40' } },
        { id: 'c3', message: 'Title wraps on small phones', created_at: '2026-10-29T08:00:00Z', resolved_at: '2026-10-29T09:00:00Z', user: { handle: 'Grace' }, client_meta: { node_id: '12:42' } },
        { id: 'c4', message: 'Which plans do we show?', created_at: '2026-10-29T08:15:00Z', user: { handle: 'Sam' }, client_meta: { node_id: '12:100' } },
        { id: 'c5', message: 'A comment on the canvas, not on a frame', created_at: '2026-10-29T08:20:00Z', user: { handle: 'Sam' }, client_meta: { x: 10, y: 20 } },
      ],
    },
  };

  async start() {
    this.server = createServer((req, res) => {
      if (this.down) return void req.socket.destroy();
      const url = new URL(req.url ?? '/', 'http://fake');
      const token = req.headers['x-figma-token'];
      this.requests.push({ path: `${url.pathname}${url.search}`, token: typeof token === 'string' ? token : undefined });
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      const png = (width: number, height: number, padding = 0) => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(Buffer.concat([drawPng(width, height, this.seed), Buffer.alloc(padding)]));
      };

      const picture = url.pathname.match(/^\/pictures\/([^/]+)\/(.+)\/([\d.]+)\.png$/);
      if (picture) return png(Math.round(720 * Number(picture[3])), Math.round(480 * Number(picture[3])), Number(picture[3]) > this.tooBigAbove ? 9 * 1024 * 1024 : 0);
      const thumbnail = url.pathname.match(/^\/thumbnails\/([^/]+)\.png$/);
      if (thumbnail) return png(400, 260);

      if (!url.pathname.startsWith('/v1/')) return json(404, { status: 404, err: 'Not found' });
      if (this.rateLimited > 0) {
        this.rateLimited--;
        return json(429, { status: 429, err: 'Rate limit exceeded' }, { 'Retry-After': '60' });
      }
      const used = typeof token === 'string' ? token : '';
      if (!this.tokens.has(used) && used !== NO_USER_SCOPE_TOKEN) return json(403, { status: 403, err: 'Invalid token' });
      if (this.revoked.has(used)) return json(403, { status: 403, err: 'Token expired' });

      if (url.pathname === '/v1/me') {
        if (used === NO_USER_SCOPE_TOKEN) return json(403, { status: 403, err: 'Invalid scope(s): file_content:read. This endpoint requires the current_user:read scope' });
        return json(200, { id: '1', email: `${this.tokens.get(used)}@example.com`, handle: this.tokens.get(used), img_url: 'https://example.com/a.png' });
      }
      const [, , , key, kind] = url.pathname.split('/'); // /v1/<files|images>/<key>/<kind>
      const file = this.files[key];
      if (!file || this.hidden.has(key)) return json(404, { status: 404, err: 'Not found' });
      if (url.pathname.startsWith('/v1/files/') && !kind) {
        return json(200, { name: file.name, lastModified: file.lastModified, thumbnailUrl: `${this.base}/thumbnails/${key}.png`, document: { id: '0:0', name: 'Document' } });
      }
      if (kind === 'nodes') {
        const ids = (url.searchParams.get('ids') ?? '').split(',');
        const depth = url.searchParams.get('depth');
        const nodes = Object.fromEntries(
          ids.map((id) => {
            const node = file.nodes[id];
            return [id, node ? { document: depth ? { id: node.id, name: node.name } : node } : null];
          }),
        );
        return json(200, { name: file.name, lastModified: file.lastModified, nodes });
      }
      if (url.pathname.startsWith('/v1/images/')) {
        const id = url.searchParams.get('ids') ?? '';
        if (url.searchParams.get('format') !== 'png') return json(400, { status: 400, err: 'format' });
        const scale = url.searchParams.get('scale') ?? '1';
        const drawn = file.nodes[id] && !this.unrenderable.has(id);
        return json(200, { err: null, images: { [id]: drawn ? `${this.base}/pictures/${key}/${id}/${scale}.png` : null } });
      }
      if (kind === 'comments') return this.commentsRefused ? json(403, { status: 403, err: this.commentsRefused }) : json(200, { comments: file.comments });
      return json(404, { status: 404, err: 'Not found' });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  hide(key: string) {
    this.hidden.add(key);
  }

  // The calls that went to the API (not the pictures), optionally those for one path.
  apiCalls(pattern?: RegExp) {
    return this.requests.filter((r) => r.path.startsWith('/v1/') && (!pattern || pattern.test(r.path)));
  }

  stop() {
    this.server.closeAllConnections();
    this.server.close();
  }
}
