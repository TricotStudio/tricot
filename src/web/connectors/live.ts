import { useEffect, useSyncExternalStore } from 'react';
import type { LinkSource } from '../../core/sources';
import { timeAgo } from '../shared/components';
import type { FileInfo } from './connector';
import { webConnector } from './registry';

// What a page hears of connectors: how a sign-in went (the tab it comes back
// to tells this one, same origin), and the real names of files on link cards,
// which a sign-in changes.

const CHANNEL = 'tricot:connectors';
type ConnectorMessage = { type: 'tricot:connector'; id: string; ok: boolean; message?: string };

const messageListeners = new Set<(message: ConnectorMessage) => void>();
let listening = false;

function isConnectorMessage(data: unknown): data is ConnectorMessage {
  return Boolean(data && typeof data === 'object' && (data as ConnectorMessage).type === 'tricot:connector');
}

// One listener for the page, on the channel the callback tab posts to and on
// window messages from it, when it is still this tab's opener.
export function onConnectorMessage(listener: (message: ConnectorMessage) => void): () => void {
  if (!listening) {
    listening = true;
    const deliver = (data: unknown) => {
      if (!isConnectorMessage(data)) return;
      files.clear(); // a new sign-in, or none: names may change
      notifyFiles();
      for (const each of messageListeners) each(data);
    };
    try {
      new BroadcastChannel(CHANNEL).onmessage = (event) => deliver(event.data);
    } catch {
      // No BroadcastChannel: the page still refetches on focus.
    }
    window.addEventListener('message', (event) => event.origin === location.origin && deliver(event.data));
  }
  messageListeners.add(listener);
  return () => messageListeners.delete(listener);
}

// ---- file names, for link cards ------------------------------------------------

// Looked up through the server, which holds the token; kept for a short
// while here too. Anything that goes wrong leaves the card as it was.
const FRESH = 2 * 60_000;
const MISSING = 60_000;
const files = new Map<string, { at: number; file: FileInfo | null }>();
const loading = new Set<string>();
const fileListeners = new Set<() => void>();

// Docs were chosen: what was looked up before may be wrong.
export function forgetFiles(): void {
  files.clear();
  notifyFiles();
}

function notifyFiles(): void {
  for (const listener of fileListeners) listener();
}

function load(key: string, lookup: () => Promise<FileInfo | null>): void {
  const known = files.get(key);
  if (loading.has(key) || (known && Date.now() - known.at < (known.file ? FRESH : MISSING))) return;
  loading.add(key);
  lookup()
    .then(
      (file) => files.set(key, { at: Date.now(), file }),
      () => files.set(key, { at: Date.now(), file: known?.file ?? null }),
    )
    .finally(() => {
      loading.delete(key);
      notifyFiles();
    });
}

function subscribeFiles(listener: () => void): () => void {
  fileListeners.add(listener);
  const stop = onConnectorMessage(() => {});
  return () => {
    fileListeners.delete(listener);
    stop();
  };
}

// A linked file's name and last edit, once its connector is connected; null
// until then, or when the link isn't a file of a connector that names them
// (any other link).
export function useLinkFile(source: LinkSource | null): FileInfo | null {
  const fileId = source?.fileId;
  const lookup = source?.connector ? webConnector(source.connector)?.fileInfo : undefined;
  const key = fileId && lookup && source?.connector ? `${source.connector}:${fileId}` : undefined;
  const file = useSyncExternalStore(subscribeFiles, () => (key ? (files.get(key)?.file ?? null) : null));
  useEffect(() => {
    if (!key || !fileId || !lookup) return;
    const again = () => load(key, () => lookup(fileId));
    again();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [key, fileId, file]);
  return file;
}

// "edited 3h ago", or the date once it's more than a week back.
export function editedAgo(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  if (Date.now() - at.getTime() < 7 * 86_400_000) return `edited ${timeAgo(iso)}`;
  const sameYear = at.getFullYear() === new Date().getFullYear();
  return `edited ${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' })}`;
}
