// What a person says about a part they pointed at in a piece's full view (a
// code block's lines, a note's words, a diagram's node, a box on an image, a
// website's element): the prompt by the part, Ask <agent> first, as on a
// Google Doc (google/docPins.tsx), or a note that just stays on it; and the
// marker on a part people asked or commented about, which opens its thread.
// Both are drawn in the view's popover (popover.tsx), which places them.

import { useEffect, useRef } from 'react';
import { pinStanding, type PinStanding } from '../../../core/pairing';
import { pinComments } from '../../../core/pins';
import type { Pin } from '../../../core/types';
import { Icon, type IconName } from '../../shared/components';
import { askToUnpin } from '../../shared/confirm';
import { MentionTextarea, COMMENT_LENSES } from '../../shared/mentions';
import { insideOf } from '../../shared/onTop';
import { ownedBy, useCanvas } from '../context';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The prompt by a part pointed at. Clicking away closes it while it's empty;
// once something is typed it stays, and pointing at another part moves it
// there. `agent`: the agent paired with, whom a request goes to. `does`:
// what an agent does with a request here ("changes the code"), said under it
// until the session has a request (`hint`).
export function PairAskPrompt(props: {
  quote: string;
  label?: string; // the dialog's name: "Ask about this part"
  text: string;
  busy: boolean;
  error: string | null;
  agent?: string | null;
  does: string;
  example: string; // what a request might say: "rename it, say"
  hint?: boolean;
  onText: (text: string) => void;
  onSubmit: (ask: boolean) => void;
  onClose: () => void;
}) {
  const { quote, label = 'Ask about this part', text, busy, error, agent, does, example, hint, onText, onSubmit, onClose } = props;
  const root = useRef<HTMLDivElement>(null);
  const empty = !text.trim();
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!insideOf(e.target as Element, root.current) && !textRef.current.trim()) onClose();
    };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [onClose]);

  return (
    <div
      ref={root}
      className="pin-prompt pair-ask"
      role="dialog"
      aria-label={label}
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
        <button type="button" className="pin-prompt-close" onClick={onClose} aria-label="Close" title="Close (Esc). What you typed stays for when you come back.">
          <Icon name="x" />
        </button>
      </div>
      <MentionTextarea
        skills
        lenses={COMMENT_LENSES}
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
        <button type="button" className="btn btn-small" disabled={empty || busy} onClick={() => onSubmit(false)} title="A note stays on the part, for whoever reads it">
          Add a note
        </button>
        <kbd className="pin-prompt-keys" title={`${MOD}+Enter asks ${agent ?? 'an agent'}`}>
          {MOD === '⌘' ? '⌘↵' : 'Ctrl ↵'}
        </kbd>
      </div>
      {hint && (
        <p className="pin-prompt-hint">
          {agent ?? 'An agent'} {does} and replies here. A note just stays.
        </p>
      )}
    </div>
  );
}

// Whether a pin's thread is settled: resolved, or answered by the agents.
export const settled = (standing: PinStanding) => standing === 'resolved' || standing === 'answered';

// What a chip says of where its thread stands, after the count, and its icon.
const FACE: Record<PinStanding, { icon: IconName; word?: string }> = {
  working: { icon: 'edit', word: 'asked' },
  waiting: { icon: 'comment', word: 'for you' },
  note: { icon: 'comment' },
  answered: { icon: 'check', word: 'done' },
  resolved: { icon: 'check', word: 'resolved' },
};

// A part's marker for its thread, by where it stands: a pen while the agents
// work on what was asked, amber when they asked the person something back, a
// speech bubble for a note, and a tick, quiet, once answered or resolved.
// `part` names the part, where the chip is drawn apart from it; `lost` says
// what happened to it, in its title, the chip only outlined dashed. `noun`
// is what unpinning it asks about: "this part".
export function PairPinChip(props: { pin: Pin; open: boolean; part?: string; lost?: string; noun?: string; onToggle: (from: HTMLElement) => void }) {
  const { pin, open, part, lost, noun = 'this part', onToggle } = props;
  const canvas = useCanvas();
  const comments = pinComments(pin, ownedBy(canvas));
  const standing = pinStanding(pin, comments, canvas.viewer);
  const resolved = pin.discussion?.resolved;
  const asked = comments.some((c) => c.ask);
  const fresh = !resolved && !open && canvas.newItems.has(pin.id);
  const classes = [
    'pin-chip',
    'is-comment',
    'pair-pin-chip',
    `is-${standing}`,
    asked && 'is-ask',
    settled(standing) && 'is-done',
    lost && 'is-lost',
    fresh && 'is-new',
    open && 'is-open',
  ];
  const face = FACE[standing];
  const word = standing === 'answered' && !asked ? 'answered' : face.word;
  const what = asked ? 'Asked agents to change' : 'Notes on';
  const state = {
    resolved: resolved ? `, resolved by ${resolved.by.name}` : '',
    answered: asked ? ', done' : ', answered',
    waiting: `, ${comments.at(-1)?.author.name ?? 'an agent'} asked you something`,
    working: ', waiting for an agent',
    note: '',
  }[standing];
  const unpin = async () => {
    if (comments.length && !(await askToUnpin(noun, comments.length))) return;
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
        onClick={(e) => onToggle(e.currentTarget)}
        aria-expanded={open}
        title={`${what} ${pin.quote}: ${plural(comments.length, 'comment')}${state}${lost ? ` (its part: ${lost})` : ''}`}
      >
        {part && <span className="pin-chip-part">{part}</span>}
        <Icon name={face.icon} className="pin-chip-icon" />
        <span className="pin-chip-ref">{comments.length}</span>
        {word && <span className="pin-chip-status">{word}</span>}
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
