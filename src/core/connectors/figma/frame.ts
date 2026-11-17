// What a Figma address names, read from the address alone (browser-safe): the
// file, and the frame in it when the link points at one. Shared by the server
// (which reads the frame through Figma) and the web (which shows its card).

export interface FigmaTarget {
  fileKey: string;
  nodeId?: string; // the frame (or other node) the link points to, as Figma's API names it: "12:34"
}

const FILE_KEY = /^[A-Za-z0-9]{6,64}$/;
const NODE_IN_ADDRESS = /^(\d{1,12})[-:](\d{1,12})$/; // the address writes 12-34; the API says 12:34

// figma.com/file/<key>/…, /design/<key>/…, /proto/<key>/…, and a branch's own
// key in /design/<key>/branch/<branchKey>/…; ?node-id=12-34 names the frame.
export function figmaTarget(address: string): FigmaTarget | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.hostname.replace(/^www\./, '') !== 'figma.com' || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (!['file', 'design', 'proto'].includes(parts[0] ?? '')) return null;
  const fileKey = parts[2] === 'branch' && parts[3] ? parts[3] : parts[1];
  if (!fileKey || !FILE_KEY.test(fileKey)) return null;
  const node = NODE_IN_ADDRESS.exec(url.searchParams.get('node-id') ?? '');
  return node ? { fileKey, nodeId: `${node[1]}:${node[2]}` } : { fileKey };
}

// A link's target as one string, for what is looked up by a file's id
// (core/sources): "<key>" for a file, "<key>:12:34" for a frame in it.
export function figmaFileId(target: FigmaTarget): string {
  return target.nodeId ? `${target.fileKey}:${target.nodeId}` : target.fileKey;
}

export function parseFigmaFileId(id: string): FigmaTarget | null {
  const at = id.indexOf(':');
  const fileKey = at < 0 ? id : id.slice(0, at);
  const node = at < 0 ? null : NODE_IN_ADDRESS.exec(id.slice(at + 1));
  if (!FILE_KEY.test(fileKey) || (at >= 0 && !node)) return null;
  return node ? { fileKey, nodeId: `${node[1]}:${node[2]}` } : { fileKey };
}
