// A note's full view, in the pairing shell (canvas/pairing/piece.tsx): the
// note on a sheet, at a reading size, its pinned words marked. Read on your
// own, or paired with an agent: click a sentence, or select any words, to ask
// the agent to rewrite them, or to leave a note. The agent rewrites the
// note's text; the view shows it where it was, and each pin stays on its
// words while they read the same (words the agent rewrote are listed under
// the note, with their thread). Edit, or a double-click while reading,
// edits its Markdown by hand, with the note as it reads beside it.

import { useMemo, useRef, type ComponentProps, type MouseEvent } from 'react';
import type { ExtraProps } from 'react-markdown';
import { clip } from '../../../../core/format';
import { noteText, quoteAt } from '../../../../core/pins';
import { taskProgress } from '../../../../core/taskList';
import type { Block } from '../../../../core/types';
import { Icon, Md, timeAgo } from '../../../shared/components';
import { PairPinChip } from '../../pairing/ask';
import { DRAFT_ANCHOR, PieceView, type PieceBodyProps } from '../../pairing/piece';
import { sentenceAt } from '../../pairing/pointing';
import { DRAFT, readText, rehypePins, selectedWords, type QuotedMark } from '../../pins';
import type { OverlayProps } from '../kind';
import './noteView.css';

type NoteBlock = Extract<Block, { type: 'note' }>;

// Where a point on the page falls in the text under it.
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function NoteWords({ block, placed, pointing, chosen, open, pick, openPin }: PieceBodyProps<NoteBlock>) {
  const root = useRef<HTMLDivElement>(null);
  const draft = chosen?.part.kind === 'text' ? chosen.part : null;
  const marks: QuotedMark[] = [
    ...placed.flatMap(({ pin, place }) => (place && pin.anchor.kind === 'text' ? [{ id: pin.id, quote: pin.quote, prefix: pin.anchor.prefix, suffix: pin.anchor.suffix }] : [])),
    ...(draft ? [{ id: DRAFT, quote: draft.quote, prefix: draft.prefix, suffix: draft.suffix }] : []),
  ];

  // Its marked words, by the pins on them, and each pin's marker after its words.
  const components = useMemo(
    () => ({
      mark: ({ node: _node, children, ...props }: ComponentProps<'mark'> & ExtraProps) => {
        const attributes = props as Record<string, unknown>;
        const chip = attributes['data-chip'] as string | undefined;
        if (chip) {
          const pin = placed.find((p) => p.pin.id === chip)?.pin;
          return pin ? <PairPinChip pin={pin} open={pin.id === open} onToggle={() => openPin(pin.id)} /> : null;
        }
        const ids = String(attributes['data-pins'] ?? '');
        const own = ids.split(' ').filter((id) => id && id !== DRAFT_ANCHOR);
        return (
          <mark
            className={`${props.className ?? ''}${own.includes(open ?? '') ? ' is-open' : ''}`}
            data-pair-anchor={ids || undefined}
            onClick={() => {
              // Reading, a click on marked words opens what was said about them.
              if (!pointing && own.length && window.getSelection()?.isCollapsed !== false) openPin(own[0]);
            }}
          >
            {children}
          </mark>
        );
      },
    }),
    [placed, open, openPin, pointing],
  );

  // Pointing: the words selected, or the sentence clicked.
  const onMouseUp = (event: MouseEvent) => {
    const container = root.current;
    if (!pointing || event.button !== 0 || !container) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;
      const words = selectedWords(container, range);
      if (!words) return;
      selection.removeAllRanges(); // the words show as being asked about instead
      pick({ blockId: block.id, part: words, quote: words.quote });
      return;
    }
    const caret = caretAt(event.clientX, event.clientY);
    if (!caret || !container.contains(caret.node) || (caret.node.parentElement?.closest('[data-pin-skip]') ?? null)) return;
    const { text, at } = readText(container);
    const sentence = sentenceAt(text, at(caret.node, caret.offset));
    const words = sentence && quoteAt(text, sentence.start, sentence.end);
    if (words) pick({ blockId: block.id, part: { kind: 'text', ...words }, quote: words.quote });
  };

  return (
    <div className="piece-scroll note-full-scroll">
      <div className="piece-sheet note-full-sheet">
        {block.text.trim() ? (
          <div ref={root} className={`note-full${pointing ? ' is-pointing' : ''}`} data-pin-text="" onMouseUp={onMouseUp} title={pointing ? 'Click a sentence, or select any words, to ask about them' : undefined}>
            <Md rehypePlugins={[[rehypePins, { marks, ids: true }]]} components={components}>
              {block.text}
            </Md>
          </div>
        ) : (
          <p className="note-full-empty placeholder">This note is empty.</p>
        )}
      </div>
    </div>
  );
}

export function NoteView({ block, name, version, pinId, onClose }: OverlayProps<NoteBlock>) {
  const { done, total } = taskProgress(block.text);
  const title = block.title || clip(noteText(block.text.split('\n').find((line) => line.trim()) ?? '').trim(), 60) || 'Note';
  const from = [total ? `Note · ${done} of ${total} done` : 'Note', `changed by ${block.updatedBy.name} ${timeAgo(block.updatedAt)}`].join(' · ');
  return (
    <PieceView
      block={block}
      name={name}
      version={version}
      pinId={pinId}
      part="note"
      className="note-full-view"
      label={`Note ${title}`}
      icon={<Icon name="note" />}
      title={title}
      from={from}
      browse={{ label: 'Read', hint: 'Read it, and select words to copy' }}
      it="the note"
      point="click a sentence, or select any words,"
      does="rewrites the note"
      example="say it plainly, say"
      body={(props) => <NoteWords {...props} />}
      edit={{
        hint: 'Edit its Markdown by hand (or double-click it while reading)',
        label: 'Markdown',
        placeholder: 'Write in Markdown',
        of: (note) => note.text,
        patch: (text) => ({ text }),
        preview: (text) => (text.trim() ? <Md>{text}</Md> : <p className="placeholder">Nothing written yet.</p>),
      }}
      onClose={onClose}
    />
  );
}
