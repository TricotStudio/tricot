import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import type { ExtraProps } from 'react-markdown';
import { kindOf } from '../../core/blocks/registry';
import { blockLabel } from '../../core/canvas';
import { partHooks } from '../../core/parts';
import {
  canvasName,
  partQuote,
  pinComments,
  pinLost,
  pinPart,
  pinsTo,
  pinTarget,
  placePin,
  quoteAt,
  samePart,
  type PinPlace,
} from '../../core/pins';
import type { Block, Board, Comment, Pin } from '../../core/types';
import { api, type PinPart } from '../shared/api';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import { askToUnpin } from '../shared/confirm';
import { AsksYou, CommentText, MentionTextarea } from '../shared/mentions';
import { Reactions, showComments } from '../conversation';
import { go, linkTo } from '../shared/pages';
import { webKindOf } from './blocks/registry';
import { useCanvas, type PinDraft } from './context';
import { DRAFT, markClass, pieces, type TextMark } from './marks';

// ---- marking words --------------------------------------------------------------

export { DRAFT, rehypePins, type QuotedMark, type TextMark } from './marks';

// A note's <mark>: pinned words, or the chip of a pin that ends in this paragraph.
export function PinMark({ node: _node, children, ...props }: ComponentProps<'mark'> & ExtraProps) {
  const { pins } = useCanvas();
  const attributes = props as Record<string, unknown>;
  const chip = attributes['data-chip'];
  if (chip) {
    const pin = [...pins.values()].flat().find((p) => p.id === chip);
    return pin ? <PinChip pin={pin} /> : null;
  }
  return (
    <mark className={props.className} data-pin-draft={attributes['data-pin-draft'] ? '' : undefined}>
      {children}
    </mark>
  );
}

// Plain text with its pinned words marked, e.g. a Google Doc's paragraph.
export function MarkedText({ text, marks, focus }: { text: string; marks: TextMark[]; focus?: string | null }) {
  if (marks.length === 0) return <>{text}</>;
  return (
    <>
      {pieces(text.length, marks).map((piece) => {
        const value = text.slice(piece.start, piece.end);
        if (piece.covering.length === 0) return <span key={piece.start}>{value}</span>;
        const draft = piece.covering.some((m) => m.id === DRAFT);
        return (
          <mark key={piece.start} className={markClass(piece.covering, focus)} data-pin-draft={draft ? '' : undefined}>
            {value}
          </mark>
        );
      })}
    </>
  );
}

// ---- chips --------------------------------------------------------------------

// What a pin links to and where that stands, e.g. "T34 in progress". Opens it.
// `part` names the pinned part first, for pins drawn apart from their words:
// "Search row → T41 in progress". `lost` says the part has changed since.
// Hovering it shows an ✕ that unpins it; the work it links to stays.
export function PinChip({ pin, part, lost }: { pin: Pin; part?: string; lost?: string }) {
  const { board, readOnly, removeItem, focusPin } = useCanvas();
  const target = pinTarget(board, pin);
  if (pin.discussion) return <CommentChip pin={pin} part={part} lost={lost} />;
  if (!target) return null;
  const open = () => (pin.taskId ? go.task(board.id, pin.taskId) : go.decision(board.id, pin.decisionId!));
  const classes = ['pin-chip', 'nodrag', 'nopan', target.done && 'is-done', lost && 'is-lost', focusPin === pin.id && 'is-focus'];
  return (
    <span
      className={classes.filter(Boolean).join(' ')}
      data-pin-skip=""
      data-chip-pin={pin.id}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="pin-chip-open"
        onClick={open}
        title={`${target.ref}: ${target.title}${lost ? ` (pinned ${partHooks(pin.anchor.kind)?.words ? 'words' : 'part'} changed since)` : ''}`}
      >
        <span className="pin-chip-dot" aria-hidden />
        {part && (
          <>
            <span className="pin-chip-part">{part}</span>
            {lost && <span className="pin-chip-lost">{lost}</span>}
            <Icon name="arrow-right" className="pin-chip-arrow" />
          </>
        )}
        <span className="pin-chip-ref">{target.ref}</span>
        <span className="pin-chip-status">{target.status}</span>
      </button>
      {!readOnly && (
        <button
          type="button"
          className="pin-chip-unpin"
          onClick={() => removeItem(pin.id)}
          aria-label={`Unpin ${part ?? `“${pin.quote}”`} from ${target.ref}`}
          title={`Unpin. ${target.ref} stays.`}
        >
          <Icon name="x" />
        </button>
      )}
    </span>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// A part people commented on: how many comments, e.g. 💬 2. In a card it
// shows them in the discussion; on the board context it opens the pin's
// thread, quiet once resolved and marked while it has replies the viewer
// hasn't seen.
function CommentChip({ pin, part, lost }: { pin: Pin; part?: string; lost?: string }) {
  const canvas = useCanvas();
  const { readOnly, removeItem, focusPin, newItems, thread: openThread } = canvas;
  const comments = pinComments(pin, { decision: canvas.decision, task: canvas.task });
  const thread = Boolean(pin.discussion?.thread);
  const resolved = pin.discussion?.resolved;
  const open = openThread === pin.id;
  const fresh = thread && !resolved && !open && newItems.has(pin.id);
  const classes = [
    'pin-chip',
    'is-comment',
    'nodrag',
    'nopan',
    resolved && 'is-done',
    lost && 'is-lost',
    fresh && 'is-new',
    open && 'is-open',
    focusPin === pin.id && 'is-focus',
  ];
  const title = thread
    ? `${plural(comments.length, 'comment')} on this part${resolved ? `, resolved by ${resolved.by.name}` : ''}`
    : `${plural(comments.length, 'comment')} on this part in the discussion`;
  const unpin = async () => {
    if (thread && comments.length && !(await askToUnpin('this part', comments.length))) return;
    removeItem(pin.id);
  };
  return (
    <span
      className={classes.filter(Boolean).join(' ')}
      data-pin-skip=""
      data-chip-pin={pin.id}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="pin-chip-open"
        onClick={() => (thread ? canvas.openThread(pin.id) : showComments(comments.map((c) => c.id)))}
        title={thread ? title : `${title}. Show ${comments.length === 1 ? 'it' : 'them'}.`}
        aria-expanded={thread ? open : undefined}
      >
        {part && (
          <>
            <span className="pin-chip-part">{part}</span>
            {lost && <span className="pin-chip-lost">{lost}</span>}
            <Icon name="arrow-right" className="pin-chip-arrow" />
          </>
        )}
        <Icon name={resolved ? 'check' : 'comment'} className="pin-chip-icon" />
        <span className="pin-chip-ref">{comments.length}</span>
        {resolved && <span className="pin-chip-status">resolved</span>}
        {fresh && <span className="pin-chip-new" aria-label="new replies" />}
      </button>
      {!readOnly && (
        <button
          type="button"
          className="pin-chip-unpin"
          onClick={unpin}
          aria-label={`Unpin ${part ?? `“${pin.quote}”`}`}
          title={thread ? 'Unpin. Its thread goes with it.' : 'Unpin. Its comments stay in the discussion.'}
        >
          <Icon name="x" />
        </button>
      )}
    </span>
  );
}

export interface PlacedPin {
  pin: Pin;
  place: PinPlace | null; // null: its part has changed past finding
}

// The pins a block shows apart from its content, their chips in the strip
// under it naming the part: those whose part changed, those drawn on it
// (tinted cells, boxes on an image, a diagram's nodes and arrows, spots on a
// 3D scene: as the part's kind says), and whole blocks.
export function PinStrip({ block, placed }: { block: Block; placed: PlacedPin[] }) {
  const apart = placed.filter(
    ({ pin, place }) => !place || partHooks(pin.anchor.kind, block)?.drawn || (pin.anchor.kind === 'block' && !kindOf(block.type).pins?.whole),
  );
  if (apart.length === 0) return null;
  return (
    <div className="pin-strip" data-pin-skip="">
      {apart.map(({ pin, place }) => (
        <PinChip key={pin.id} pin={pin} part={pinPart(pin, block)} lost={place ? undefined : pinLost(pin, block)} />
      ))}
    </div>
  );
}

// ---- selecting words ----------------------------------------------------------------

// The text inside a pinnable element, as people read it: chips and strips aside.
function textNodes(container: HTMLElement): Text[] {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('[data-pin-skip]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

// Where a range boundary falls in the text of `nodes`, clamped to it.
function offsetOf(nodes: Text[], node: Node, offset: number): number {
  const boundary = document.createRange();
  boundary.setStart(node, offset);
  let at = 0;
  for (const text of nodes) {
    if (text === node) return at + offset;
    if (boundary.comparePoint(text, text.length) > 0) return at;
    at += text.length;
  }
  return at;
}

// The words selected in a pinnable element: their quote and the text either
// side, which finds them again after edits. Null when nothing is selected.
export function selectedWords(container: HTMLElement, range: Range): (PinPart & { kind: 'text' }) | null {
  const nodes = textNodes(container);
  const text = nodes.map((n) => n.data).join('');
  const start = offsetOf(nodes, range.startContainer, range.startOffset);
  const end = offsetOf(nodes, range.endContainer, range.endOffset);
  const words = end > start ? quoteAt(text, start, end) : null;
  return words && { kind: 'text', ...words };
}

// The words of a block on the canvas a press began in (a note's), or null for
// a press anywhere else: on the empty canvas, another part of a block, or a
// note's full view, which picks words its own way (noteView.tsx). A press
// with ⇧, ⌘ or Ctrl adds blocks to the selection or draws a box from
// anywhere, so it never begins words to pin.
export function wordsPressed(event: Pick<MouseEvent, 'target' | 'shiftKey' | 'metaKey' | 'ctrlKey'>): HTMLElement | null {
  if (event.shiftKey || event.metaKey || event.ctrlKey) return null;
  return (event.target as Element | null)?.closest?.<HTMLElement>('[data-pin-text][data-block-id]') ?? null;
}

// The words to pin as the button comes up: those selected in the words the
// press began in. Null for a press that began anywhere else, whatever the
// browser holds selected then: words left selected in some block earlier,
// or words it selected itself as a selection box was drawn from the empty
// canvas (it starts a selection in the first words on the canvas, which can
// be in any block).
export function wordsReleased(pressed: HTMLElement | null, selection: Selection | null): (PinPart & { kind: 'text' }) | null {
  if (!pressed?.isConnected || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return range.intersectsNode(pressed) ? selectedWords(pressed, range) : null;
}

// The text of a pinnable element as people read it, and where a point in it
// (a caret's node and offset) falls in that text: a note's full view takes
// the sentence under a click with them.
export function readText(container: HTMLElement): { text: string; at(node: Node, offset: number): number } {
  const nodes = textNodes(container);
  return { text: nodes.map((n) => n.data).join(''), at: (node, offset) => offsetOf(nodes, node, offset) };
}

// A single click picks a cell or a node, but the first click of a
// double-click (which edits it) must not: picking waits a moment to see.
export function useClickPick() {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    later: (pick: () => void) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(pick, 240);
    },
    cancel: () => clearTimeout(timer.current),
  };
}

// ---- the prompt -------------------------------------------------------------------

// A part as a prompt or a thread quotes it.
function PartQuote({ part, block }: { part: Parameters<typeof partQuote>[0]; block?: Block }) {
  return <>{partQuote(part, block)}</>;
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl';


// What a prompt's text can become, as its buttons say.
type Act = 'question' | 'task' | 'comment';

const ACT_LABEL: Record<Act, string> = { question: 'Ask a question', task: 'Create task', comment: 'Comment' };
const ACT_DOES: Record<Act, string> = { question: 'asks the question', task: 'creates the task', comment: 'comments' };

// The prompt under a part being pinned: it quotes the part, and turns it into
// a question, a task (in the backlog unless it's ready now) or a comment. On
// the board context, asking comes first, as the board goes: look, decide,
// then do. A question goes to the board as a decision pinned to the part, for
// agents to propose options, and a comment starts a thread on the pin for
// agents to answer. In a task or a decision, commenting comes first and goes
// in its discussion, then creating a task; there's no question to ask.
export function PinPrompt(props: {
  draft: PinDraft;
  block?: Block;
  name: string;
  style: CSSProperties;
  above: boolean;
  onChange: (draft: PinDraft) => void;
  onClose: () => void;
  onCommented: (pin: Pin, comment: Comment) => void;
}) {
  const { draft, block, name, style, above, onChange, onClose, onCommented } = props;
  const { decision, task } = useCanvas();
  const card = task ? 'task' : decision ? 'decision' : null;
  const acts: Act[] = card ? ['comment', 'task'] : ['question', 'task', 'comment'];
  const first = acts[0];
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = !text.trim();
  const Scope = block ? webKindOf(block.type).PinScope : undefined; // a kind's choice of how much of it to pin (a table's cells, rows or columns)

  // Clicking away closes an empty prompt. Once something is typed it stays,
  // and a new selection moves it to the new part, keeping the words.
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node) && !textRef.current.trim()) onClose();
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose]);

  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, [draft]);

  const submit = async (kind: Act) => {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'question') await api.pinQuestion(draft.blockId, name, { part: draft.part, text });
      else if (kind === 'task') await api.pinTask(draft.blockId, name, { part: draft.part, text, ready });
      else {
        const { pin, comment } = await api.pinComment(draft.blockId, name, { part: draft.part, body: text });
        onCommented(pin, comment);
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      ref={root}
      className={`pin-prompt nodrag nopan nowheel${above ? ' is-above' : ''}`}
      style={style}
      role="dialog"
      aria-label="Pin this part"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit(first);
        }
      }}
    >
      <div className="pin-prompt-head">
        <p className="pin-prompt-quote">
          <PartQuote part={{ anchor: draft.part, quote: draft.quote }} block={block} />
        </p>
        <button type="button" className="pin-prompt-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </div>
      {block && Scope && <Scope draft={draft} block={block} onChange={onChange} />}
      <MentionTextarea
        ref={field}
        rows={2}
        value={text}
        placeholder={
          card ? 'A comment, or a task to create (its first line titles it)' : 'What should be decided, or done? The first line is the question or the task.'
        }
        aria-label={card ? 'Comment or task' : 'Question, task or comment'}
        onValue={(value) => {
          setText(value);
          setError(null);
        }}
        onKeyDown={(e) => {
          // Copying straight after selecting copies the words, as it would have.
          const field = e.currentTarget;
          if (e.key === 'c' && (e.metaKey || e.ctrlKey) && field.selectionStart === field.selectionEnd) {
            void navigator.clipboard?.writeText(draft.quote).catch(() => {});
          }
        }}
      />
      {error && (
        <p className="pin-prompt-error" role="alert">
          {error}
        </p>
      )}
      {/* Three actions leave no room beside them for Ready now, so on the
          board context it sits under Create task, the one it's for. */}
      <div className={`pin-prompt-actions${card ? '' : ' is-three'}`}>
        {acts.map((kind) => (
          <button
            key={kind}
            type="button"
            className={`btn btn-small${kind === first ? ' btn-primary' : ''}`}
            disabled={empty || busy}
            onClick={() => void submit(kind)}
          >
            {ACT_LABEL[kind]}
          </button>
        ))}
        <label className="pin-ready" title="Put the task straight in To do for agents to pick up. Otherwise it waits in the backlog.">
          <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} />
          Ready now
        </label>
        <kbd className="pin-prompt-keys" title={`${MOD}+Enter ${ACT_DOES[first]}`}>
          {MOD === '⌘' ? '⌘↵' : 'Ctrl ↵'}
        </kbd>
      </div>
      <p className="pin-prompt-hint">
        {card
          ? `Comment goes in this ${card}'s discussion. Create task makes a separate task, linked here.`
          : 'Ask a question pins a decision here; agents propose options.'}
      </p>
    </div>
  );
}

// ---- a part's comment thread, on the board context ------------------------------------

// A board context pin's thread, opened from its chip: the part, its comments,
// a reply, and resolving it. Work pinned to the same part shows here too.
// `inline` draws it in place, under what it's about (a doc's paragraph),
// rather than over the canvas by its chip; there it shows the comments of a
// card's canvas too, which are in the card's discussion. In a piece's full
// view (canvas/pairing), `live` is said under the comments in place of the
// note about agents (what the agent is doing about the request), and
// `address` turns a reply into what is sent (to the agent paired with).
export function PinThread(props: {
  pin: Pin;
  block?: Block;
  name: string;
  style?: CSSProperties;
  above?: boolean;
  inline?: boolean;
  onClose: () => void;
  onHeight?: (height: number) => void; // how tall it's drawn, to place it
  live?: (note: ReactNode) => ReactNode; // given the note it would show while a person waits (or nothing)
  address?: (text: string) => string;
}) {
  const { pin, block, name, style, above, inline, onClose, onHeight, live, address } = props;
  const canvas = useCanvas();
  const { readOnly, pins } = canvas;
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const comments = pinComments(pin, { decision: canvas.decision, task: canvas.task });
  const threaded = Boolean(pin.discussion?.thread); // the board context's own thread, which can be resolved
  const resolved = pin.discussion?.resolved;
  // Work pinned to the same part, e.g. the decision an agent posted from this
  // thread: the same as its kind says (a box whatever its number, a website's
  // element whatever it reads).
  const alongside = (pins.get(pin.blockId) ?? []).filter((p) => p !== pin && !p.discussion && samePart(p.anchor, pin.anchor, block));
  const waiting = !resolved && comments.at(-1)?.author.kind === 'human';
  const asked = comments.some((c) => c.ask);

  // Clicking away closes it, unless a reply is being written. Drawn in place,
  // it stays until closed.
  const bodyRef = useRef(body);
  bodyRef.current = body;
  useEffect(() => {
    if (inline) return;
    const away = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Its own chip toggles it.
      if (root.current?.contains(target) || target.closest?.(`[data-chip-pin="${CSS.escape(pin.id)}"]`)) return;
      if (!bodyRef.current.trim()) onClose();
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', escape);
    };
  }, [onClose, pin.id, inline]);

  // The latest comment in view, as it arrives.
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [comments.length]);
  useLayoutEffect(() => {
    if (root.current) onHeight?.(root.current.offsetHeight);
  });

  const act = async (action: () => Promise<unknown>, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = () => body.trim() && void act(() => api.commentOnPin(pin.id, name, address ? address(body) : body), () => setBody(''));

  return (
    <div
      ref={root}
      className={`pin-prompt pin-thread nodrag nopan nowheel${above ? ' is-above' : ''}${resolved ? ' is-resolved' : ''}${inline ? ' is-inline' : ''}`}
      style={style}
      role={inline ? 'region' : 'dialog'}
      aria-label="Comments on this part"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="pin-prompt-head">
        <p className="pin-prompt-quote">
          <PartQuote part={pin} block={block} />
        </p>
        <button type="button" className="pin-prompt-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <Icon name="x" />
        </button>
      </div>
      <ol className="pin-thread-comments" ref={list}>
        {comments.map((comment) => (
          <li key={comment.id} className={`pin-thread-comment comment-${comment.author.kind}`}>
            <div className="comment-head">
              <ActorBadge actor={comment.author} /> <span className="faint small">{timeAgo(comment.createdAt)}</span>
              {comment.ask && <span className="pin-thread-ask">Asked agents</span>}
              <AsksYou comment={comment} thread={comments} />
            </div>
            <CommentText comment={comment} />
            <Reactions item={comment} place={{ pinId: pin.id }} name={name} />
          </li>
        ))}
      </ol>
      {(() => {
        const note = waiting && (
          <p className="pin-thread-note">
            {asked ? `Agents see this request in their updates, ${partHooks(pin.anchor.kind, block)?.askedTo ?? 'act on it'} and reply here.` : 'Agents see this in their updates and reply here.'}
          </p>
        );
        return live ? live(note) : note;
      })()}
      {alongside.length > 0 && (
        <div className="pin-thread-also">
          <span>Pinned here too</span>
          {alongside.map((p) => (
            <PinChip key={p.id} pin={p} />
          ))}
        </div>
      )}
      {resolved && (
        <p className="pin-thread-resolved">
          <Icon name="check" /> Resolved by {resolved.by.name} {timeAgo(resolved.at)}
        </p>
      )}
      {!readOnly && (
        <>
          <MentionTextarea
            rows={2}
            value={body}
            placeholder={resolved ? 'Reply to reopen it' : `Reply (${MOD === '⌘' ? '⌘↵' : 'Ctrl ↵'} to send)`}
            aria-label="Reply"
            onValue={(value) => {
              setBody(value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
          {error && (
            <p className="pin-prompt-error" role="alert">
              {error}
            </p>
          )}
          <div className="pin-prompt-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={!body.trim() || busy} onClick={send}>
              Reply
            </button>
            {threaded && (
              <button
                type="button"
                className="btn btn-small"
                disabled={busy}
                onClick={() => void act(() => api.resolvePin(pin.id, name, !resolved), resolved ? undefined : onClose)}
                title={resolved ? 'Open the thread again' : 'Mark the thread resolved: its chip goes quiet'}
              >
                {resolved ? 'Reopen' : 'Resolve'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}


// ---- where work was pinned from ------------------------------------------------------

function canvasHref(board: Board, owner: { decision?: { id: string }; task?: { id: string } }): string {
  if (owner.task) return linkTo.task(board.id, owner.task.id);
  return owner.decision ? linkTo.decision(board.id, owner.decision.id) : linkTo.board(board.id, 'canvas');
}

// A pinned task's detail, or a pinned question's context, ends quoting the
// part it was pinned from, for agents and for after the block is gone. While
// the panel shows the pin itself, the quote is left off so it isn't said twice.
export function besidePins(board: Board, target: { taskId?: string; decisionId?: string }, text?: string): string | undefined {
  if (!text || pinsTo(board, target).length === 0) return text;
  return text.replace(/(^|\n\n)Pinned from [^\n]*:\n> [^\n]*$/, '').trim() || undefined;
}

// For a task's or decision's panel: the parts of blocks it was pinned from,
// each quoted, with the block and canvas it's on.
export function PinnedFrom({ board, taskId, decisionId }: { board: Board; taskId?: string; decisionId?: string }): ReactNode {
  const pins = pinsTo(board, { taskId, decisionId });
  if (pins.length === 0) return null;
  return (
    <section className="section">
      <h3>Pinned from</h3>
      <ul className="pinned-from">
        {pins.map(({ pin, block, decision, task }) => {
          const lost = placePin(block, pin) ? null : pinLost(pin, block);
          const words = partHooks(pin.anchor.kind, block)?.words; // words people selected, quoted whole
          const where = canvasName({ decision, task });
          return (
            <li key={pin.id}>
              <blockquote className={lost ? 'is-lost' : undefined}>
                {words ? `“${pin.quote}”` : pinPart(pin, block)}
              </blockquote>
              <p className="pinned-from-where">
                <a href={canvasHref(board, { decision, task })}>
                  in {blockLabel(block)} · {where === 'board context' ? 'Board Context' : where}
                </a>
                {lost && <span className="tag tag-lost">{lost}</span>}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
