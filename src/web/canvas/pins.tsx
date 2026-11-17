import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import type { ExtraProps } from 'react-markdown';
import { kindOf } from '../../core/blocks/registry';
import { blockLabel } from '../../core/canvas';
import { namedCards, cardOwning } from '../../core/cards';
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
  type OwnedCanvas,
  type PinPlace,
} from '../../core/pins';
import type { Block, Board, Comment, Pin } from '../../core/types';
import { api, type PinPart } from '../shared/api';
import { ActorBadge, Icon, timeAgo } from '../shared/components';
import type { CardKinds, PinAction, PinWords } from '../shared/cardKinds';
import { CardAnchor, useCardKinds } from '../shared/cardKindsContext';
import { askToUnpin } from '../shared/confirm';
import { AsksYou, CommentText, MentionTextarea, COMMENT_LENSES, CommentLens, ViaSkill } from '../shared/mentions';
import { Reactions, showComments } from '../conversation';
import { linkTo } from '../shared/pages';
import { webKindOf } from './blocks/registry';
import { ownedBy, useCanvas, type PinDraft } from './context';
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
  const cards = useCardKinds();
  const target = pinTarget(board, pin);
  if (pin.discussion) return <CommentChip pin={pin} part={part} lost={lost} />;
  if (!target) return null;
  // Where the card it links to is, from the kind of card registered for it: with none, the chip says where it stands and opens nothing.
  const [pinned] = namedCards(pin);
  const link = pinned && cards.byId(pinned.kind, board.id, pinned.id);
  const classes = ['pin-chip', 'nodrag', 'nopan', target.done && 'is-done', lost && 'is-lost', focusPin === pin.id && 'is-focus'];
  const title = `${target.ref}: ${target.title}${lost ? ` (pinned ${partHooks(pin.anchor.kind)?.words ? 'words' : 'part'} changed since)` : ''}`;
  const face = (
    <>
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
    </>
  );
  return (
    <span
      className={classes.filter(Boolean).join(' ')}
      data-pin-skip=""
      data-chip-pin={pin.id}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {link ? (
        <button type="button" className="pin-chip-open" onClick={() => link.open()} title={title}>
          {face}
        </button>
      ) : (
        <span className="pin-chip-open" title={title}>
          {face}
        </span>
      )}
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
  const comments = pinComments(pin, ownedBy(canvas));
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


// What a prompt's text can become, as its buttons say: a comment, and what the
// kinds of card registered offer (shared/cardKinds.ts), each with how it is made.
type Act = Pick<PinAction, 'id' | 'label' | 'does'> & Partial<Pick<PinAction, 'make'>>;

const COMMENT: Act = { id: 'comment', label: 'Comment', does: 'comments' };

// The prompt's words where no kind of card registered says them: a comment is all it offers.
const COMMENT_WORDS: PinWords = { placeholder: 'A comment on this part', label: 'Comment', hint: '', line: 'Click a line to comment on it', becomes: 'a comment' };

// What a pinnable thing's tooltip says it can be pinned to (PinWords `line` and `becomes`), on any canvas.
export function usePinTitles(): { line: string; becomes: string } {
  const words = useCardKinds().pinWords(null) ?? COMMENT_WORDS;
  return { line: words.line ?? COMMENT_WORDS.line!, becomes: words.becomes ?? COMMENT_WORDS.becomes! };
}

// The buttons of a prompt on this canvas, in order: what the kinds registered offer before a
// comment (on the board context, asking comes first, as the board goes: look, decide, then do),
// then Comment, then what they offer after it (in a task or a decision, commenting comes first).
function actsOn(cards: CardKinds, card: string | null): { offered: PinAction[]; acts: Act[] } {
  const offered = cards.pinActions({ card });
  return { offered, acts: [...offered.filter((a) => !a.afterComment), COMMENT, ...offered.filter((a) => a.afterComment)] };
}

// The prompt under a part being pinned: it quotes the part, and turns it into
// a comment, which starts a thread on the pin for agents to answer, or, where
// the page has kinds of card, a card made from it: a part's turn it into a
// question (a decision pinned to the part, for agents to propose options) or a
// task (in the backlog unless it's ready now). In a task or a decision, a
// comment goes in its discussion.
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
  const canvas = useCanvas();
  const cards = useCardKinds();
  const card = cardOwning(ownedBy(canvas))?.kind.kind ?? null;
  const { offered, acts } = actsOn(cards, card);
  const words = cards.pinWords(card) ?? COMMENT_WORDS;
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

  const submit = async (act: Act) => {
    if (empty || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (act.make) await act.make(draft.blockId, name, { part: draft.part, text, ready });
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
        skills
        lenses={COMMENT_LENSES}
        ref={field}
        rows={2}
        value={text}
        placeholder={words.placeholder}
        aria-label={words.label}
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
      {/* Three actions leave no room beside them for Ready now, so with three
          it sits under Create task, the one it's for. */}
      <div className={`pin-prompt-actions${acts.length > 2 ? ' is-three' : ''}`}>
        {acts.map((act) => (
          <button
            key={act.id}
            type="button"
            className={`btn btn-small${act === first ? ' btn-primary' : ''}`}
            disabled={empty || busy}
            onClick={() => void submit(act)}
          >
            {act.label}
          </button>
        ))}
        {offered.some((a) => a.ready) && (
          <label className="pin-ready" title={words.ready?.title}>
            <input type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} />
            {words.ready?.label ?? 'Ready now'}
          </label>
        )}
        <kbd className="pin-prompt-keys" title={`${MOD}+Enter ${first.does}`}>
          {MOD === '⌘' ? '⌘↵' : 'Ctrl ↵'}
        </kbd>
      </div>
      {words.hint && <p className="pin-prompt-hint">{words.hint}</p>}
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
  const comments = pinComments(pin, ownedBy(canvas));
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
              <CommentLens lens={comment.lens} />
              <ViaSkill via={comment.via} />
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
            skills
            lenses={COMMENT_LENSES}
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

// Where a canvas is: a card's from the kind registered for it (none, no link), a page's, the board context's.
function canvasHref(cards: CardKinds, board: Board, owner: OwnedCanvas): string | undefined {
  const card = cardOwning(owner);
  if (card) return cards.byId(card.kind.kind, board.id, card.id)?.href;
  if (owner.page) return linkTo.page(board.id, owner.page.id);
  return linkTo.context(board.id);
}

// A pinned card's detail (a task's), or context (a decision's), ends quoting the part it was pinned from, for agents and for
// after the block is gone. `link` names the card, as a pin's link does (`{ taskId }`). While the panel shows the pin itself,
// the quote is left off so it isn't said twice.
export function besidePins(board: Board, link: Record<string, string | undefined>, text?: string): string | undefined {
  if (!text || pinsTo(board, link).length === 0) return text;
  return text.replace(/(^|\n\n)Pinned from [^\n]*:\n> [^\n]*$/, '').trim() || undefined;
}

// For a card's panel: the parts of blocks it was pinned from, each quoted, with the block and canvas it's on. `link` names the
// card, as a pin's link does (`{ decisionId }`).
export function PinnedFrom({ board, link }: { board: Board; link: Record<string, string | undefined> }): ReactNode {
  const cards = useCardKinds();
  const pins = pinsTo(board, link);
  if (pins.length === 0) return null;
  return (
    <section className="section">
      <h3>Pinned from</h3>
      <ul className="pinned-from">
        {pins.map((owned) => {
          const { pin, block } = owned;
          const lost = placePin(block, pin) ? null : pinLost(pin, block);
          const words = partHooks(pin.anchor.kind, block)?.words; // words people selected, quoted whole
          const where = canvasName(owned);
          return (
            <li key={pin.id}>
              <blockquote className={lost ? 'is-lost' : undefined}>
                {words ? `“${pin.quote}”` : pinPart(pin, block)}
              </blockquote>
              <p className="pinned-from-where">
                <CardAnchor href={canvasHref(cards, board, owned)}>
                  in {blockLabel(block)} · {where === 'board context' ? 'Board Context' : where}
                </CardAnchor>
                {lost && <span className="tag tag-lost">{lost}</span>}
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
