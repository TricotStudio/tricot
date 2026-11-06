// What a person says about a part they pointed at in a piece's full view (a
// code block's lines, a note's words, a diagram's node, a box on an image):
// the prompt by the part, Ask <agent> first, as on a website or a doc
// (site/pins.tsx, google/docPins.tsx), or a note that just stays on it; and
// the marker on a part people asked or commented about, which opens its
// thread.

import { useEffect, useRef, type CSSProperties } from 'react';
import { pinComments } from '../../../core/pins';
import type { Pin } from '../../../core/types';
import { Icon } from '../../shared/components';
import { MentionTextarea } from '../../shared/mentions';
import { useCanvas } from '../context';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The prompt by a part pointed at. Clicking away closes it while it's empty;
// once something is typed it stays, and pointing at another part moves it
// there. `agent`: the agent paired with, whom a request goes to. `does`:
// what an agent does with a request here ("changes the code").
export function PairAskPrompt(props: {
  quote: string;
  style: CSSProperties;
  above: boolean;
  text: string;
  busy: boolean;
  error: string | null;
  agent?: string | null;
  does: string;
  example: string; // what a request might say: "rename it, say"
  onText: (text: string) => void;
  onSubmit: (ask: boolean) => void;
  onClose: () => void;
}) {
  const { quote, style, above, text, busy, error, agent, does, example, onText, onSubmit, onClose } = props;
  const root = useRef<HTMLDivElement>(null);
  const empty = !text.trim();
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
      className={`pin-prompt pair-ask${above ? ' is-above' : ''}`}
      style={style}
      role="dialog"
      aria-label="Ask about this part"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (!empty && !busy) onSubmit(true);
        }
      }}
    >
      <div className="pin-prompt-head">
        <p className="pin-prompt-quote">{quote}</p>
        <button type="button" className="pin-prompt-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </div>
      <MentionTextarea
        rows={2}
        value={text}
        placeholder={agent ? `Ask ${agent} to change it (${example}), or leave a note` : `Ask an agent to change it (${example}), or leave a note; @ to pick an agent`}
        aria-label="What should change here?"
        autoFocus
        onValue={onText}
      />
      {error && (
        <p className="pin-prompt-error" role="alert">
          {error}
        </p>
      )}
      <div className="pin-prompt-actions">
        <button type="button" className="btn btn-small btn-primary" disabled={empty || busy} onClick={() => onSubmit(true)}>
          {agent ? `Ask ${agent}` : 'Ask an agent'}
        </button>
        <button type="button" className="btn btn-small" disabled={empty || busy} onClick={() => onSubmit(false)}>
          Add a note
        </button>
        <kbd className="pin-prompt-keys" title={`${MOD}+Enter asks ${agent ?? 'an agent'}`}>
          {MOD === '⌘' ? '⌘↵' : 'Ctrl ↵'}
        </kbd>
      </div>
      <p className="pin-prompt-hint">
        {agent ?? 'An agent'} {does} and replies here{agent ? ', with its steps on the pin as it works' : ''}. A note just stays on the part.
      </p>
    </div>
  );
}

// A part's marker for its thread: a pen while people ask agents to change it,
// a speech bubble for notes, a tick once resolved. `part` names the part,
// where the chip is drawn apart from it; `lost` says what happened to it.
export function PairPinChip(props: { pin: Pin; open: boolean; part?: string; lost?: string; onToggle: () => void }) {
  const { pin, open, part, lost, onToggle } = props;
  const canvas = useCanvas();
  const comments = pinComments(pin, { decision: canvas.decision, task: canvas.task });
  const resolved = pin.discussion?.resolved;
  const asked = comments.some((c) => c.ask);
  const waiting = !resolved && comments.at(-1)?.author.kind === 'human';
  const fresh = !resolved && !open && canvas.newItems.has(pin.id);
  const classes = ['pin-chip', 'is-comment', 'pair-pin-chip', asked && 'is-ask', resolved && 'is-done', lost && 'is-lost', fresh && 'is-new', open && 'is-open'];
  const what = asked ? 'Asked agents to change' : 'Notes on';
  const state = resolved ? `, resolved by ${resolved.by.name}` : asked && waiting ? ', waiting for an agent' : '';
  const unpin = () => {
    if (comments.length && !window.confirm(`Unpin this part and remove its thread of ${plural(comments.length, 'comment')}?`)) return;
    canvas.removeItem(pin.id);
  };
  return (
    <span
      className={classes.filter(Boolean).join(' ')}
      data-chip-pin={pin.id}
      data-pin-skip=""
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="pin-chip-open"
        onClick={onToggle}
        aria-expanded={open}
        title={`${what} ${pin.quote}: ${plural(comments.length, 'comment')}${state}${lost ? ` (${lost})` : ''}`}
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
        <button type="button" className="pin-chip-unpin" onClick={unpin} aria-label={`Unpin ${pin.quote}`} title="Unpin. Its thread goes with it.">
          <Icon name="x" />
        </button>
      )}
    </span>
  );
}
