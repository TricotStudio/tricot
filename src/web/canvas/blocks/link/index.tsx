// Link blocks: a bookmark card, opening in place when the address can be
// embedded. A document of a connector (a Google Doc) also opens for editing
// in Tricot, in the connector's own editor (web/connectors/<id>/).

import { useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { linkAddress, linkHost, webUrl } from '../../../../core/blocks/link/link';
import { linkSource, sourceKind } from '../../../../core/sources';
import type { Block } from '../../../../core/types';
import { Icon } from '../../../shared/components';
import { ConnectorChoosers } from '../../../connectors/chooser';
import { editedAgo, useLinkFile } from '../../../connectors/live';
import { connectorOfLink } from '../../../connectors/registry';
import { useDismiss } from '../../../shared/hooks';
import { dragsLinks } from '../../clip';
import { useCanvas } from '../../context';
import { useTypedDrop } from '../../dropOverlay';
import { MarkIcon, SourceIcon } from '../../sources/icon';
import { siteMark } from '../../sources/sites';
import type { AddContext, CardProps, Clip, FormProps, OverlayProps, Point, ToolsProps, WebBlockKind } from '../kind';
import { LinkFrame } from './embed';

type LinkBlock = Extract<Block, { type: 'link' }>;

// People type "figma.com/file/…" without a scheme, so a bare address means
// https. Something that already names a scheme ("mailto:", "javascript:") is
// kept as is and refused; "localhost:3000" is a host and port, not a scheme.
export function typedAddress(input: string): string | null {
  const text = input.trim();
  return webUrl(/^[a-z][a-z\d+.-]*:(?!\d)/i.test(text) ? text : `https://${text}`);
}

// The icon of the site a link goes to, drawn by Tricot for the sites people
// link most (canvas/sources/sites.tsx), and a plain link icon for any other:
// nothing is fetched from the site.
function SiteIcon({ url }: { url: string }) {
  const mark = siteMark(url);
  if (mark) return <MarkIcon mark={mark} />;
  return (
    <span className="site-icon" aria-hidden>
      <Icon name="link" />
    </span>
  );
}

// A link reads as a bookmark: its site's icon, its title (or its address) and
// the host under it. The title opens it in a new tab; the rest of the card is
// for dragging, and double-clicking it edits the address and title. A link the
// board recognises (core/sources) shows its source's mark and kind, and one
// that can be embedded opens in place, for everyone on the board. With Google
// connected, a Google file's card shows its real name, unless someone gave
// the card a title of their own, and when it was last edited. A Google Doc's
// card opens it for editing in Tricot, and says when it has a draft (what its
// connector's editor says, see web/connectors/connector.ts). A connector can
// also add to the card of a link it recognises (a Figma frame's thumbnail).
function LinkCard(props: {
  block: Extract<Block, { type: 'link' }>;
  editing: boolean;
  setEditing: (editing: boolean) => void;
  badges: ReactNode;
}) {
  const { block, editing, setEditing, badges } = props;
  const canvas = useCanvas();
  const source = useMemo(() => linkSource(block.url), [block.url]);
  const drive = useLinkFile(source);
  const connector = connectorOfLink(source);
  const editor = connector?.editor;
  if (editing && !canvas.readOnly) return <LinkEditor block={block} onDone={() => setEditing(false)} />;
  const embed = source?.embed;
  const open = Boolean(block.open && embed);
  const title = block.title || drive?.name || source?.name || linkAddress(block.url);
  const edited = drive?.modifiedTime ? editedAgo(drive.modifiedTime) : '';
  // A titled GitHub card names its pull request or issue; others say the service
  // and host. The first part stays whole; the second gives way when space is short.
  const [lead, rest] = !source
    ? [linkHost(block.url)]
    : source.ref && block.title
      ? [source.ref, source.what]
      : [sourceKind(source), edited || linkHost(block.url)];
  const editable = Boolean(editor && source?.editable) && !canvas.readOnly;
  const draft = editor?.draft(block) ?? null;
  const threads = editable && editor && <editor.Threads block={block} />; // threads on the doc's parts
  const editHere = editable && editor && (
    <button className="btn btn-small" onClick={() => canvas.openOverlay(block.id)} title={editor.title}>
      Edit in Tricot
    </button>
  );
  return (
    <>
      <div
        className={`block-head block-link${open ? ' is-open' : connector?.LinkCard ? ' has-card' : ''}`}
        onDoubleClick={() => !canvas.readOnly && setEditing(true)}
        title={canvas.readOnly ? undefined : 'Double-click to edit'}
      >
        {source ? <SourceIcon mark={source.mark} /> : <SiteIcon url={block.url} />}
        <div className="block-link-text">
          <a
            className="block-link-title nodrag"
            href={block.url}
            target="_blank"
            rel="noreferrer"
            title={drive && drive.name !== title ? `${drive.name}\n${block.url}` : block.url}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {title}
          </a>
          <span className="block-link-host">
            {threads}
            {draft ? (
              <>
                <span className="block-link-lead block-link-draft">{draft[0].toUpperCase() + draft.slice(1)}</span>
                <span className="block-link-rest"> · {lead}</span>
              </>
            ) : rest ? (
              <>
                <span className="block-link-lead">{lead}</span>
                <span className="block-link-rest"> · {rest}</span>
              </>
            ) : (
              lead
            )}
          </span>
        </div>
        {embed && !canvas.readOnly && (
          <div className="block-link-actions nodrag" onDoubleClick={(e) => e.stopPropagation()}>
            {open ? (
              <>
                <button className="btn btn-small btn-quiet" onClick={() => canvas.openLink(block, false)}>
                  Collapse
                </button>
                {editHere || (
                  <a className="btn btn-small" href={block.url} target="_blank" rel="noreferrer">
                    Open in {source.site}
                    <Icon name="external" />
                  </a>
                )}
              </>
            ) : (
              <>
                {editHere}
                <button className={`btn btn-small${editable ? ' btn-quiet' : ''}`} onClick={() => canvas.openLink(block, true)}>
                  Open here
                </button>
              </>
            )}
          </div>
        )}
        {badges}
      </div>
      {!open && source && connector?.LinkCard && <connector.LinkCard block={block} source={source} />}
      {open && embed && <LinkFrame key={embed.url} embed={embed} url={block.url} site={source.site} title={title} />}
    </>
  );
}

// Enter or clicking away saves, Escape cancels; an address that isn't http or
// https is refused on Enter and dropped on clicking away.
function LinkEditor({ block, onDone }: { block: Extract<Block, { type: 'link' }>; onDone: () => void }) {
  const canvas = useCanvas();
  const [address, setAddress] = useState(block.url);
  const [title, setTitle] = useState(block.title ?? '');
  const [invalid, setInvalid] = useState(false);
  const finished = useRef(false);
  const finish = (save: boolean) => {
    if (finished.current) return;
    const url = typedAddress(address);
    if (save && !url) return setInvalid(true);
    finished.current = true;
    onDone();
    if (!save || !url) return;
    const urlChanged = url !== block.url;
    const titleChanged = title.trim() !== (block.title ?? '');
    if (urlChanged || titleChanged) {
      canvas.updateBlock(block, { url: urlChanged ? url : undefined, title: titleChanged ? title : undefined });
    }
  };
  return (
    <div
      className="block-link-editor nodrag"
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as HTMLElement | null)) return;
        finish(typedAddress(address) !== null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        }
        if (e.key === 'Escape') finish(false);
      }}
    >
      <input
        autoFocus
        value={address}
        onChange={(e) => {
          setAddress(e.target.value);
          setInvalid(false);
        }}
        placeholder="https://…"
        aria-label="Address"
        aria-invalid={invalid}
        title={invalid ? 'Enter an http or https address' : undefined}
      />
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" aria-label="Title" />
    </div>
  );
}

// The buttons of a link's card, where its block shows its toolbar.
function LinkTools({ block, editing, setEditing }: ToolsProps<LinkBlock>) {
  const canvas = useCanvas();
  if (editing) return null;
  return (
    <>
      <button
        onClick={() => canvas.startPin({ blockId: block.id, part: { kind: 'block' }, quote: block.title || linkAddress(block.url) })}
        title="Pin this card to a new task or a comment"
      >
        Pin
      </button>
      <button onClick={() => setEditing(true)}>Edit</button>
    </>
  );
}

// Add → Link: an address and an optional title. A pasted address opens it
// filled in, with the title next, so Enter alone adds the link. Empty, it
// closes on a click elsewhere or Escape; once something's in it, it stays
// until Cancel, or Escape in it.
function AddLinkFields(props: {
  address: string;
  toggle: RefObject<HTMLElement | null>; // its button on the toolbar
  onAdd: (url: string, title: string) => void;
  onCancel: () => void;
}) {
  const { toggle, onAdd, onCancel } = props;
  const [address, setAddress] = useState(props.address);
  const [title, setTitle] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [choosing, setChoosing] = useState(false); // a service's chooser is open over the page
  const root = useRef<HTMLFormElement>(null);
  useDismiss(!address.trim() && !title.trim() && !choosing, onCancel, root, toggle);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = typedAddress(address);
    if (url) onAdd(url, title.trim());
    else setInvalid(true);
  };
  return (
    <form
      ref={root}
      className="add-link nodrag nopan nowheel"
      onSubmit={submit}
      onKeyDown={(e) => e.key === 'Escape' && onCancel()}
    >
      <ConnectorChoosers onBusy={setChoosing} onPick={(url) => onAdd(url, '')} />
      <label>
        <span className="field-label">Address</span>
        <input
          autoFocus={!props.address}
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setInvalid(false);
          }}
          placeholder="https://…"
          aria-invalid={invalid}
        />
      </label>
      <label>
        <span className="field-label">
          Title <span className="faint">(optional)</span>
        </span>
        <input
          autoFocus={Boolean(props.address)}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Design file"
        />
      </label>
      {invalid && <p className="error">Enter an http:// or https:// address.</p>}
      <div className="row">
        <button className="btn btn-primary btn-small" disabled={!address.trim()}>
          Add link
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function AddLinkForm({ initial, toggle, context, close }: FormProps) {
  return (
    <AddLinkFields
      address={initial ?? ''}
      toggle={toggle}
      onAdd={(url, title) => {
        close();
        void context.add({ type: 'link', url }, { title });
      }}
      onCancel={close}
    />
  );
}


// The web addresses in a dragged link list, each once. Others (mailto:, a
// file: path) are not links a card can open.
export const webAddressesIn = (clip: Clip): string[] => [...new Set(clip.links.flatMap((address) => webUrl(address) ?? []))];

// Links dropped on the canvas: a card each, the way dropped files are laid out.
async function addLinks(clip: Clip, context: AddContext, at?: Point) {
  for (const [i, url] of webAddressesIn(clip).entries()) {
    await context.add({ type: 'link', url }, { at: at && { x: at.x + i * 40, y: at.y + i * 40 } });
  }
}

// A link's overlay is its connector's editor, for a document it can edit.
function LinkOverlay({ block, name, pinId, onClose }: OverlayProps<LinkBlock>) {
  const editor = connectorOfLink(linkSource(block.url))?.editor;
  return editor ? <editor.Editor block={block} name={name} pinId={pinId} onClose={onClose} /> : null;
}

export const link: WebBlockKind<LinkBlock> = {
  type: 'link',
  copyText: (block) => block.url,
  Body: () => null, // drawn whole by its card
  Card: ({ block, editing, setEditing, badges }: CardProps<LinkBlock>) => (
    <LinkCard block={block} editing={editing} setEditing={setEditing} badges={badges} />
  ),
  Tools: LinkTools,
  overlay: { Component: LinkOverlay, changes: true },
  // Showing a comment on a part of the document opens the connector's editor there.
  opensOnPin: (block, pin) => Boolean(connectorOfLink(linkSource(block.url))?.editor?.opensPin(pin)),
  menu: {
    label: 'Link',
    Form: AddLinkForm,
    // A pasted web address opens the form with it filled in.
    paste: (text) => (/^https?:\/\/\S+$/i.test(text) ? webUrl(text) : null),
  },
  // A link dragged from the address bar or a page is a card where it is dropped.
  clips: {
    accepts: (clip) => webAddressesIn(clip).length > 0,
    add: addLinks,
    useDrop: (enabled) => useTypedDrop(enabled, { matches: dragsLinks, what: 'the link', as: 'a Link card' }),
  },
};
