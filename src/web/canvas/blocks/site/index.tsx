// Website blocks: a live site on the canvas, from a folder on this computer
// or a dev server on it (core/blocks/site). Its card shows the page it is on,
// live and scaled down, and opens the site to the whole canvas (siteView.tsx),
// where people browse it and pin notes and requests for agents on its parts.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { pageTitle, siteName } from '../../../../core/blocks/site/site';
import type { Block } from '../../../../core/types';
import { Icon } from '../../../components';
import { useDismiss } from '../../../hooks';
import { EditableText, useCanvas } from '../../context';
import type { CardProps, FormProps, ToolsProps, WebBlockKind } from '../kind';
import { SANDBOX, SITE_CHANGED, pageAddress, siteChanged, useFrameMessages, useSiteAddress } from './frame';
import { SiteBoundary } from './boundary';
import { SiteThreadsChip } from './pins';
import { SiteView } from './siteView';
import './site.css';

type SiteBlock = Extract<Block, { type: 'site' }>;

const PREVIEW_WIDTH = 1280; // the card shows the page as a desktop's screen would, scaled down

// The page the block is on, live, scaled to the card: nothing on it takes the
// pointer, so the card drags and selects as any block does. A double-click opens it.
function SitePreview({ block, onTitle, onOpen }: { block: SiteBlock; onTitle: (title: string) => void; onOpen: () => void }) {
  const { address, error, blocked } = useSiteAddress(block.id);
  const stage = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [loads, setLoads] = useState(0);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ w: element.clientWidth, h: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const again = (e: Event) => (e as CustomEvent<string>).detail === block.id && setLoads((n) => n + 1);
    window.addEventListener(SITE_CHANGED, again);
    return () => window.removeEventListener(SITE_CHANGED, again);
  }, [block.id]);
  useFrameMessages(frame, address?.origin, (message) => {
    if (message.type === 'ready') onTitle(message.title);
  });
  const scale = size.w ? size.w / PREVIEW_WIDTH : 0;
  return (
    <div className="site-preview" ref={stage} onDoubleClick={onOpen} title="Double-click to open it">
      {error || blocked ? (
        <p className="site-preview-note">{error ?? 'Load the page again to show this website.'}</p>
      ) : address && scale > 0 ? (
        <iframe
          key={`${block.page}:${loads}`}
          ref={frame}
          name="tricot-site-preview"
          src={pageAddress(address, block.page)}
          title={`${siteName(block)}, scaled down`}
          sandbox={SANDBOX}
          tabIndex={-1}
          loading="lazy"
          referrerPolicy="strict-origin-when-cross-origin"
          style={{ width: PREVIEW_WIDTH, height: size.h / scale, transform: `scale(${scale})` }}
        />
      ) : (
        <span className="site-preview-note">Opening the website…</span>
      )}
    </div>
  );
}

// Its card: the site's mark, its title (double-click to rename) over where it
// comes from and the page it shows, Open, and the page itself.
function SiteCard({ block, badges }: CardProps<SiteBlock>) {
  const canvas = useCanvas();
  const [live, setLive] = useState('');
  const open = () => canvas.openOverlay(block.id);
  const from = block.folder ? 'Folder' : 'Dev server';
  const where = block.folder ? siteName({ ...block, title: undefined }) : block.url ? new URL(block.url).host : '';
  const shown = live || pageTitle(block, block.page) || siteName(block);
  return (
    <>
      <div className="block-head block-link block-site">
        <span className="site-icon" aria-hidden>
          <Icon name="globe" />
        </span>
        <div className="block-link-text">
          <EditableText className="block-link-title" value={block.title || shown} placeholder="Untitled" onCommit={(title) => canvas.updateBlock(block, { title })} />
          <span className="block-link-host">
            <SiteThreadsChip blockId={block.id} />
            <span className="block-link-lead">{from}</span>
            <span className="block-link-rest">
              {' '}
              · {where} · {block.page === '/' ? 'home page' : block.page}
            </span>
          </span>
        </div>
        <div className="block-link-actions nodrag" onDoubleClick={(e) => e.stopPropagation()}>
          <button className="btn btn-small" onClick={open} title="Open the website over the canvas, to browse it and pin notes on it">
            Open
          </button>
        </div>
        {badges}
      </div>
      <SitePreview block={block} onTitle={setLive} onOpen={open} />
    </>
  );
}

function SiteTools({ block, viewing }: ToolsProps<SiteBlock>) {
  const canvas = useCanvas();
  if (viewing) return null;
  return (
    <>
      <button onClick={() => canvas.openOverlay(block.id)}>Open</button>
      <button
        onClick={() => canvas.startPin({ blockId: block.id, part: { kind: 'block' }, quote: block.title || siteName(block) })}
        title="Pin this website to a new task or a comment"
      >
        Pin
      </button>
    </>
  );
}

// What a person typed as a site's source: a folder (a path from / or ~), or a local address.
export function typedSource(input: string): { folder: string } | { url: string } | null {
  const text = input.trim();
  if (!text) return null;
  if (text.startsWith('/') || text.startsWith('~')) return { folder: text };
  return { url: /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}` };
}

// Add → Website: a folder on this computer or a local address, and an optional title.
function AddSiteForm({ toggle, context, close }: FormProps) {
  const [source, setSource] = useState('');
  const [title, setTitle] = useState('');
  const [invalid, setInvalid] = useState(false);
  const root = useRef<HTMLFormElement>(null);
  useDismiss(!source.trim() && !title.trim(), close, root, toggle);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const typed = typedSource(source);
    if (!typed) return setInvalid(true);
    close();
    void context.add({ type: 'site', ...typed }, { title: title.trim(), size: { w: 520, h: 420 } });
  };
  return (
    <form ref={root} className="add-link add-site nodrag nopan nowheel" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <label>
        <span className="field-label">Folder or local address</span>
        <input
          autoFocus
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setInvalid(false);
          }}
          placeholder="~/my-site or localhost:3000"
          aria-invalid={invalid}
        />
      </label>
      <label>
        <span className="field-label">
          Title <span className="faint">(optional)</span>
        </span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Marketing site" />
      </label>
      {invalid && <p className="error">Give a folder on this computer, or a dev server's address such as localhost:3000.</p>}
      <p className="faint small">Shown live, from an address of its own: its scripts can't reach the board.</p>
      <div className="row">
        <button className="btn btn-primary btn-small" disabled={!source.trim()}>
          Add website
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// Its overlay is the full view; closing it loads the card's page again, which
// may have changed meanwhile. Whatever goes wrong in it stays in it.
function SiteOverlay(props: Parameters<typeof SiteView>[0]) {
  const { block } = props;
  useEffect(
    () => () => {
      siteChanged(block.id);
    },
    [block.id],
  );
  return (
    <SiteBoundary onClose={props.onClose}>
      <SiteView {...props} />
    </SiteBoundary>
  );
}

export const site: WebBlockKind<SiteBlock> = {
  type: 'site',
  Body: () => null, // drawn whole by its card
  Card: (props: CardProps<SiteBlock>) => (
    <SiteBoundary>
      <SiteCard {...props} />
    </SiteBoundary>
  ),
  Tools: SiteTools,
  overlay: { Component: SiteOverlay },
  // Showing a comment on one of its elements opens the full view there.
  opensOnPin: (_block, pin) => pin.anchor.kind === 'site',
  activate: (block, canvas) => canvas.openOverlay(block.id),
  menu: { label: 'Website', Form: AddSiteForm },
};
