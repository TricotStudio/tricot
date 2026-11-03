import { useState } from 'react';
import type { LinkSource } from '../../../core/sources';
import type { Block, BlockVersion } from '../../../core/types';
import { useCanvas } from '../../canvas/context';
import { figmaApi, useFigmaCard } from './api';

type LinkBlock = Extract<Block, { type: 'link' }>;
type ImageBlock = Extract<Block, { type: 'image' }>;

// What the preview says when there is none to show.
function missing(code: string | undefined, frame: boolean, message?: string): string {
  const what = frame ? 'frame' : 'file';
  if (code === 'not_connected') return `Connect Figma to see this ${what} here.`;
  if (code === 'needs_sign_in' || code === 'token_refused') return 'Figma needs a new token before it can show this.';
  return message ?? `Figma isn't showing this ${what} right now.`;
}

// Under a Figma link's title: the file's or frame's thumbnail, and what to do
// with it: "Bring in this frame" once Figma is connected, "Connect Figma" until then.
export function FigmaLinkCard({ block, source }: { block: LinkBlock; source: LinkSource }) {
  const canvas = useCanvas();
  const answer = useFigmaCard(source.fileId);
  const [busy, setBusy] = useState(false);
  if (!source.fileId) return null;
  const card = answer?.file;
  const frame = card ? card.frame : source.fileId.includes(':');
  const needsConnecting = ['not_connected', 'needs_sign_in', 'token_refused'].includes(answer?.problem?.code ?? '');

  const bringIn = () =>
    canvas.perform(async (actor) => {
      setBusy(true);
      try {
        await figmaApi.bringIn(block.id, actor);
      } finally {
        setBusy(false);
      }
    });

  return (
    <div className="figma-card nodrag">
      <div className="figma-card-preview">
        {card?.thumbnail ? (
          <img src={`/api/assets/${encodeURIComponent(card.thumbnail)}`} alt={`Preview of ${card.name}`} draggable={false} />
        ) : answer ? (
          <p className="faint small">{missing(answer.problem?.code, frame, answer.problem?.message)}</p>
        ) : (
          <p className="faint small">Loading the preview…</p>
        )}
      </div>
      <div className="figma-card-actions">
        {card && frame && <span className="faint small figma-card-file">In {card.fileName}</span>}
        {needsConnecting && (
          <a className="btn btn-small btn-primary" href={`#/connectors?from=${encodeURIComponent(canvas.board.id)}`}>
            Connect Figma
          </a>
        )}
        {card && frame && !canvas.readOnly && (
          <button className="btn btn-small" disabled={busy} onClick={bringIn} title="Add a picture of this frame to the canvas, kept as it is now">
            {busy ? 'Bringing it in…' : 'Bring in this frame'}
          </button>
        )}
      </div>
    </div>
  );
}

// An image brought in from Figma: Refresh draws the frame again, in place; the
// picture it replaces stays as an earlier version.
export function FigmaImageTools({ block, viewing }: { block: ImageBlock; viewing: BlockVersion | null }) {
  const canvas = useCanvas();
  const [busy, setBusy] = useState(false);
  const [same, setSame] = useState(false);
  if (canvas.readOnly) return null;
  const refresh = () =>
    canvas.perform(async (actor) => {
      setBusy(true);
      setSame(false);
      try {
        const { changed } = await figmaApi.refresh(block.id, actor);
        if (!changed) {
          setSame(true);
          setTimeout(() => setSame(false), 3000);
        }
      } finally {
        setBusy(false);
      }
    });
  return (
    <button
      onClick={refresh}
      disabled={busy || viewing !== null}
      title={viewing ? 'Go back to the current version to refresh it' : 'Draw this frame again from Figma. This picture is kept as an earlier version'}
    >
      {busy ? 'Refreshing…' : same ? 'Already up to date' : 'Refresh'}
    </button>
  );
}
