// Note blocks: Markdown, edited in place. Selecting words pins them. A task
// list in a note ("- [ ] step") ticks in place: a tick rewrites that line.

import { useRef } from 'react';
import { retick, setTask, taskLines, taskProgress } from '../../../../core/taskList';
import type { Block } from '../../../../core/types';
import { Md } from '../../../components';
import { useCanvas } from '../../context';
import { DRAFT, PinStrip, rehypePins, type PlacedPin, type QuotedMark } from '../../pins';
import { PIN_COMPONENTS, dragged, draftOf, selecting, useLongEdit } from '../interaction';
import type { WebBlockKind } from '../kind';

type NoteBlock = Extract<Block, { type: 'note' }>;

// Selecting words in a note pins them: they show in amber while the prompt is
// open, then in blue with the status of the work they're pinned to.
function NoteBody({ block, placed }: { block: NoteBlock; placed: PlacedPin[] }) {
  const canvas = useCanvas();
  const edit = useLongEdit(block.id);
  const draft = draftOf(canvas.draft, block.id, 'text');
  const pressedAt = useRef({ x: 0, y: 0 });
  const marks: QuotedMark[] = [
    ...placed.flatMap(({ pin, place }) =>
      place && pin.anchor.kind === 'text' ? [{ id: pin.id, quote: pin.quote, prefix: pin.anchor.prefix, suffix: pin.anchor.suffix }] : [],
    ),
    ...(draft ? [{ id: DRAFT, quote: draft.quote, prefix: draft.prefix, suffix: draft.suffix }] : []),
  ];
  // A tick changes that line of the note and nothing else, as the viewer saw
  // it; if someone changed the note meanwhile, the same task is ticked again
  // on the note as it is now.
  const tick = (line: number, done: boolean) => {
    const text = setTask(block.text, line, done);
    if (text === null || text === block.text) return;
    const task = taskLines(block.text).find((t) => t.line === line);
    canvas.updateBlock(
      block,
      { text },
      task &&
        ((latest) => {
          const again = latest.type === 'note' ? retick(latest.text, task, done) : null;
          return again === null || latest.type !== 'note' || again === latest.text ? null : { text: again };
        }),
    );
  };
  if (edit.editing) {
    return (
      <textarea
        autoFocus
        className="block-editor nodrag"
        defaultValue={block.text}
        placeholder="Markdown"
        onBlur={(e) => edit.finish(e.currentTarget.value, block.text, (text) => canvas.updateBlock(block, { text }))}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            edit.cancel();
            e.currentTarget.blur();
          }
        }}
      />
    );
  }
  if (!block.text.trim()) {
    return (
      <>
        <div className="block-note" onDoubleClick={edit.start}>
          <p className="placeholder">Double-click to write</p>
        </div>
        <PinStrip block={block} placed={placed} />
      </>
    );
  }
  return (
    <>
      <div
        className="block-note nopan"
        data-pin-text=""
        data-block-id={block.id}
        onDoubleClick={edit.start}
        onMouseDown={(e) => (pressedAt.current = { x: e.clientX, y: e.clientY })}
        onClick={(e) => !selecting(e) && dragged(e, pressedAt.current) && e.stopPropagation()}
      >
        <Md rehypePlugins={[[rehypePins, { marks, focus: canvas.focusPin }]]} components={PIN_COMPONENTS} onTick={canvas.readOnly ? undefined : tick}>
          {block.text}
        </Md>
      </div>
      <PinStrip block={block} placed={placed} />
    </>
  );
}

// How far along a note's tasks are, quietly beside its title: 3 of 7 done.
function NoteHead({ block }: { block: NoteBlock }) {
  const { done, total } = taskProgress(block.text);
  if (total === 0) return null;
  return (
    <span className="note-progress" title={`${done} of ${total} tasks done`}>
      {done} of {total} done
    </span>
  );
}

export const note: WebBlockKind<NoteBlock> = {
  type: 'note',
  Body: NoteBody,
  Head: NoteHead,
  ownPins: true, // its pins are the words themselves, and its body draws the strip
  menu: { label: 'Note', add: () => ({ content: { type: 'note', text: '' } }) },
  added: (block, canvas) => canvas.edit(block.id),
};
