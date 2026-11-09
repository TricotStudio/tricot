// Notes and requests on a website's elements, in its full view: the prompt
// that opens on an element picked in edit mode (Ask an agent first, as a
// Google Doc's does), and the chip on an element people asked or commented
// about, which opens its thread on the element.

import { useEffect, useRef, type CSSProperties } from 'react';
import type { PickedElement } from '../../../../core/blocks/site/messages';
import { elementQuote } from '../../../../core/blocks/site/site';
import { pinComments } from '../../../../core/pins';
import type { Pin } from '../../../../core/types';
import { Icon } from '../../../shared/components';
import { askToUnpin } from '../../../shared/confirm';
import { MentionTextarea } from '../../../shared/mentions';
import { useCanvas } from '../../context';

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The prompt by a picked element. Clicking away closes it while it's empty;
// once something is typed it stays, and picking another element moves it there.
// `agent`: the agent paired with (canvas/pairing), whom a request goes to.
export function SiteAskPrompt(props: {
  element: PickedElement;
  style: CSSProperties;
  above: boolean;
  text: string;
  busy: boolean;
  error: string | null;
  agent?: string | null;
  onText: (text: string) => void;
  onSubmit: (ask: boolean) => void;
  onClose: () => void;
}) {
  const { element, style, above, text, busy, error, agent, onText, onSubmit, onClose } = props;
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
      className={`pin-prompt site-ask${above ? ' is-above' : ''}`}
      style={style}
      role="dialog"
      aria-label="Ask about this part of the page"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          if (!empty && !busy) onSubmit(true);
        }
      }}
    >
      <div className="pin-prompt-head">
        <p className="pin-prompt-quote">{elementQuote(element.tag, element.text, element.selector)}</p>
        <button type="button" className="pin-prompt-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </div>
      <MentionTextarea
        rows={2}
        value={text}
        placeholder={agent ? `Ask ${agent} to change it (make this shorter, say), or leave a note` : 'Ask an agent to change it (make this shorter, say), or leave a note; @ to pick an agent'}
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
        {agent ?? 'An agent'} changes the site's {element.file ? `file (${element.file}${element.line ? `, line ${element.line}` : ''})` : 'files'} and replies here
        {agent ? ', with its steps on the pin as it works' : ''}. A note just stays on the element.
      </p>
    </div>
  );
}

// An element's marker for its thread: a pen while people ask agents to
// change it, a speech bubble for notes, a tick once resolved. `part` names
// the element, where the chip is drawn apart from it; `lost` says what happened.
export function SitePinChip(props: { pin: Pin; open: boolean; part?: string; lost?: string; onToggle: () => void }) {
  const { pin, open, part, lost, onToggle } = props;
  const canvas = useCanvas();
  const comments = pinComments(pin, { decision: canvas.decision, task: canvas.task });
  const resolved = pin.discussion?.resolved;
  const asked = comments.some((c) => c.ask);
  const waiting = !resolved && comments.at(-1)?.author.kind === 'human';
  const fresh = !resolved && !open && canvas.newItems.has(pin.id);
  const classes = ['pin-chip', 'is-comment', 'site-pin-chip', asked && 'is-ask', resolved && 'is-done', lost && 'is-lost', fresh && 'is-new', open && 'is-open'];
  const what = asked ? 'Asked agents to change' : 'Notes on';
  const state = resolved ? `, resolved by ${resolved.by.name}` : asked && waiting ? ', waiting for an agent' : '';
  const unpin = async () => {
    if (comments.length && !(await askToUnpin('this element', comments.length))) return;
    canvas.removeItem(pin.id);
  };
  return (
    <span className={classes.filter(Boolean).join(' ')} data-chip-pin={pin.id}>
      <button
        type="button"
        className="pin-chip-open"
        onClick={onToggle}
        aria-expanded={open}
        title={`${what} the ${pin.quote}: ${plural(comments.length, 'comment')}${state}${lost ? ` (${lost})` : ''}`}
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
        <button type="button" className="pin-chip-unpin" onClick={unpin} aria-label={`Unpin the ${pin.quote}`} title="Unpin. Its thread goes with it.">
          <Icon name="x" />
        </button>
      )}
    </span>
  );
}

// On a website's card: its open threads, marked when one has news. It opens
// the full view at that one (or the first).
export function SiteThreadsChip({ blockId }: { blockId: string }) {
  const canvas = useCanvas();
  const open = (canvas.pins.get(blockId) ?? []).filter((p) => p.anchor.kind === 'site' && p.discussion && !p.discussion.resolved);
  if (open.length === 0) return null;
  const fresh = open.filter((p) => canvas.newItems.has(p.id));
  const asks = open.filter((p) => pinComments(p, { decision: canvas.decision, task: canvas.task }).some((c) => c.ask)).length;
  const what = [asks && `${plural(asks, 'request')} to agents`, open.length - asks && plural(open.length - asks, 'note')].filter(Boolean).join(' and ');
  return (
    <button
      type="button"
      className={`block-link-threads nodrag${fresh.length ? ' is-new' : ''}`}
      onClick={() => canvas.openOverlay(blockId, { pinId: (fresh[0] ?? open[0]).id })}
      onDoubleClick={(e) => e.stopPropagation()}
      title={`${what} on this website${fresh.length ? ', with new replies' : ''}. Open it there.`}
    >
      <Icon name={asks ? 'edit' : 'comment'} />
      {open.length}
      {fresh.length > 0 && <span className="pin-chip-new" aria-label="new replies" />}
    </button>
  );
}
