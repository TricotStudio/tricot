import { useEffect, useRef, type CSSProperties } from 'react';
import { pinComments } from '../../../core/pins';
import type { Block, Pin } from '../../../core/types';
import { useCanvas } from '../../canvas/context';
import { Icon } from '../../components';
import { MentionTextarea } from '../../mentions';
import type { DocWords } from './api';

// Asking agents about words in a Google Doc's paragraph, in the doc editor:
// the prompt that opens on selecting them (the canvas's pin prompt, with Ask
// an agent first), the marker by a paragraph people asked or commented about,
// and on the doc's card, how many of those threads are open.

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The prompt under selected words. It doesn't take the focus: the words stay
// selected in the paragraph, so typing over them edits the doc as usual (and
// closes an empty prompt). Clicking into it asks.
export function DocAskPrompt(props: {
  words: DocWords;
  style: CSSProperties;
  above: boolean; // drawn above the words, its bottom at style.top
  text: string;
  busy: boolean;
  error: string | null;
  onText: (text: string) => void;
  onSubmit: (ask: boolean) => void;
  onClose: () => void;
}) {
  const { words, style, above, text, busy, error, onText, onSubmit, onClose } = props;
  const root = useRef<HTMLDivElement>(null);
  const empty = !text.trim();

  // Clicking away closes an empty prompt. Once something is typed it stays,
  // and a new selection moves it to the new words, keeping what was typed.
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node) && !textRef.current.trim()) onClose();
    };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [onClose]);

  return (
    <div
      ref={root}
      className={`pin-prompt doc-ask${above ? ' is-above' : ''}`}
      style={style}
      role="dialog"
      aria-label="Ask about these words"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (!empty && !busy) onSubmit(true);
        }
      }}
    >
      <div className="pin-prompt-head">
        <p className="pin-prompt-quote">“{words.quote}”</p>
        <button type="button" className="pin-prompt-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </div>
      <MentionTextarea
        rows={2}
        value={text}
        placeholder="Ask an agent to… (e.g. make this shorter, rewrite for a customer); @ to pick one"
        aria-label="What should an agent do with these words?"
        onValue={onText}
      />
      {error && (
        <p className="pin-prompt-error" role="alert">
          {error}
        </p>
      )}
      <div className="pin-prompt-actions">
        <button type="button" className="btn btn-small btn-primary" disabled={empty || busy} onClick={() => onSubmit(true)}>
          Ask an agent
        </button>
        <button type="button" className="btn btn-small" disabled={empty || busy} onClick={() => onSubmit(false)}>
          Comment
        </button>
        <kbd className="pin-prompt-keys" title={`${MOD}+Enter asks an agent`}>
          {MOD === '⌘' ? '⌘↵' : 'Ctrl ↵'}
        </kbd>
      </div>
      <p className="pin-prompt-hint">An agent edits the draft and replies here. Comment just leaves a note.</p>
    </div>
  );
}

// A paragraph's marker for a thread on words in it: a pen while people ask
// agents to edit it, a speech bubble for comments, a tick once resolved. It
// opens the thread under the paragraph. `part` names the words, for a pin
// whose paragraph is gone; `lost` says what happened to it.
export function DocPinChip(props: { pin: Pin; open: boolean; part?: string; lost?: string; onToggle: () => void }) {
  const { pin, open, part, lost, onToggle } = props;
  const canvas = useCanvas();
  const comments = pinComments(pin, { decision: canvas.decision, task: canvas.task });
  const resolved = pin.discussion?.resolved;
  const asked = comments.some((c) => c.ask);
  const waiting = !resolved && comments.at(-1)?.author.kind === 'human';
  const fresh = !resolved && !open && canvas.newItems.has(pin.id);
  const classes = ['pin-chip', 'is-comment', 'doc-pin-chip', asked && 'is-ask', resolved && 'is-done', lost && 'is-lost', fresh && 'is-new', open && 'is-open'];
  const what = asked ? 'Asked agents to edit' : 'Comments on';
  const state = resolved ? `, resolved by ${resolved.by.name}` : asked && waiting ? ', waiting for an agent' : '';
  const unpin = () => {
    if (comments.length && !window.confirm(`Unpin these words and remove their thread of ${plural(comments.length, 'comment')}?`)) return;
    canvas.removeItem(pin.id);
  };
  return (
    <span className={classes.filter(Boolean).join(' ')} data-doc-chip={pin.id}>
      <button
        type="button"
        className="pin-chip-open"
        onClick={onToggle}
        aria-expanded={open}
        title={`${what} “${pin.quote}”: ${plural(comments.length, 'comment')}${state}${lost ? ` (${lost})` : ''}`}
      >
        {part && (
          <>
            <span className="pin-chip-part">{part}</span>
            {lost && <span className="pin-chip-lost">{lost}</span>}
            <Icon name="arrow-right" className="pin-chip-arrow" />
          </>
        )}
        <Icon name={resolved ? 'check' : asked ? 'edit' : 'comment'} className="pin-chip-icon" />
        <span className="pin-chip-ref">{comments.length}</span>
        {resolved ? <span className="pin-chip-status">resolved</span> : asked && waiting && <span className="pin-chip-status">asked</span>}
        {fresh && <span className="pin-chip-new" aria-label="new replies" />}
      </button>
      {!canvas.readOnly && (
        <button type="button" className="pin-chip-unpin" onClick={unpin} aria-label={`Unpin “${pin.quote}”`} title="Unpin. Its thread goes with it.">
          <Icon name="x" />
        </button>
      )}
    </span>
  );
}

// On a Google Doc's card, in its status line: the threads on its paragraphs
// still open, marked when one has news. It opens the doc at that one (or the first).
export function DocThreadsChip({ block }: { block: Block }) {
  const canvas = useCanvas();
  const open = (canvas.pins.get(block.id) ?? []).filter((p) => p.anchor.kind === 'doc' && p.discussion && !p.discussion.resolved);
  if (open.length === 0) return null;
  const fresh = open.filter((p) => canvas.newItems.has(p.id));
  const asks = open.filter((p) => pinComments(p, { decision: canvas.decision, task: canvas.task }).some((c) => c.ask)).length;
  const what = [asks && `${plural(asks, 'request')} to agents`, open.length - asks && plural(open.length - asks, 'comment thread')].filter(Boolean).join(' and ');
  return (
    <button
      type="button"
      className={`block-link-threads nodrag${fresh.length ? ' is-new' : ''}`}
      onClick={() => canvas.openOverlay(block.id, { pinId: (fresh[0] ?? open[0]).id })}
      onDoubleClick={(e) => e.stopPropagation()}
      title={`${what} on paragraphs of this doc${fresh.length ? ', with new replies' : ''}. Open it there.`}
    >
      <Icon name={asks ? 'edit' : 'comment'} />
      {open.length}
      {fresh.length > 0 && <span className="pin-chip-new" aria-label="new replies" />}
    </button>
  );
}
