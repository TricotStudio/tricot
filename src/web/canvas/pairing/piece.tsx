// A canvas block's full view in the pairing shell (shell.tsx), for the kinds
// whose own parts take requests: a code block's lines, a note's words, a
// diagram's nodes and arrows, boxes on an image (core/parts.ts). The same as
// a website's or a Google Doc's: Read (or View) on your own, or "Pair with
// <agent>", where pointing at a part opens a prompt by it to ask the agent
// to change it, or to leave a note. A request goes straight to the agent
// paired with (core/pairing.ts addressTo); its thread opens on the part,
// with the agent's live steps under it (pinLine.tsx); and the session's list
// is beside the piece once it has a request. When the agent's change lands
// (a new revision of the block, live from the board), the piece shows it
// where it was, and its pins stay on their parts as far as the kind finds
// them again; those it can't are listed under it, threads and all.
//
// A kind the canvas lets people edit can be edited here too (edit.tsx): Edit
// in the bar, or a double-click while reading, opens its editor in place of
// the piece, until they go back to Read or Pair, press Esc or close it.
//
// A kind whose parts take comments but no requests (a diff's lines,
// core/parts.ts) says `asks={false}`: it has no Pair, its parts are pointed
// at while reading, and the prompt is the canvas's (a comment, or what the
// page's kinds of card make of it). The work made so is drawn on its part
// too, as the canvas draws it.
//
// The prompt and a thread open in the view's popover (popover.tsx), drawn on
// top and placed by their part as the kind opens (`opens`: beside it, or
// under it for words in a paragraph). The pins the piece draws no chip for
// are in one row under it (strip.tsx): those on the whole block, those whose
// part it can't find any more, and, for a kind that marks its parts without
// a chip (`listed`: a box on a picture, a cell, a node), its parts' own. A
// chip there opens its thread by itself; a card's opens the card. What is
// settled folds into the row's "N done".
//
// Escape closes the popover, then the view; a half-typed ask stays for when
// its part is pointed at again, as a half-typed reply stays on its thread
// (pins.tsx).
//
// The piece draws the body: its parts, marked where they are pinned, and
// how pointing at one works. It marks each pinned part's element with
// data-pair-anchor="<pin ids>", and the part being asked about with
// data-pair-anchor="draft": the prompt and threads open by those. Inside a
// marked part, what it marks data-pair-reach (a line's words and its chips)
// is what the popover goes beside, rather than all of it.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { atVersion } from '../../../core/canvas';
import { clip } from '../../../core/format';
import { partQuote, pinLost, pinPart, placePin } from '../../../core/pins';
import type { Block, BlockVersion, Pin } from '../../../core/types';
import { api } from '../../shared/api';
import { typing } from '../../shared/hooks';
import type { Box } from '../../shared/onTop';
import { useCanvas, type PinDraft } from '../context';
import { PinPrompt, PinThread, type PlacedPin } from '../pins';
import { PairAskPrompt } from './ask';
import { useHandEdit, type HandEdit, type PieceEdit } from './edit';
import { PinLine } from './pinLine';
import { unionBox, type Opens, type PartAt } from './pointing';
import { PinPopover } from './popover';
import { usePairing } from './session';
import { PairingShell, reachWords, useEscapeSteps } from './shell';
import { PinStrip, stripAnchor, type StripPin } from './strip';
import { quietFocus } from './zoom';
import './piece.css';

const CHANGED_MS = 3200; // how long "Claude changed the code" stays

export const DRAFT_ANCHOR = 'draft';

// What the piece's body is given to draw.
export interface PieceBodyProps<B extends Block = Block> {
  block: B; // as shown: an earlier version, when one is being looked at
  placed: PlacedPin[]; // its parts' pins people talk about (with `asks={false}`, the work pinned to them too), where each is now (null: lost); none on an earlier version
  pointing: boolean; // pairing: pointing at a part picks it
  chosen: PinDraft | null; // the part being asked about, until it is
  open: string | null; // the pin whose thread is open
  pick(draft: PinDraft): void;
  openPin(id: string): void; // opens its thread by its part
}

const boxOf = (r: DOMRect): Box => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

// Where the part marked for a pin (or the draft) is, in the window: round
// what it marks to go beside (data-pair-reach), or the whole of it, and the
// sheet it is on. Of its chips, their faces: the ✕ that slides out of one
// on hover doesn't move the popover.
export function partAt(stage: Element | null, id: string): PartAt | null {
  const found = stage ? [...stage.querySelectorAll(`[data-pair-anchor~="${CSS.escape(id)}"]`)] : [];
  if (found.length === 0) return null;
  const boxes = found.flatMap((element) => {
    const reach = [...element.querySelectorAll('[data-pair-reach]')].flatMap((e) => {
      const faces = e.querySelectorAll('.pin-chip-open');
      return faces.length ? [...faces] : [e];
    });
    return [...(reach.length ? reach : [element])].map((e) => e.getBoundingClientRect()).filter((r) => r.width || r.height).map(boxOf);
  });
  const part = unionBox(boxes);
  const sheet = found[0].closest('.piece-sheet')?.getBoundingClientRect();
  return part && { part, ...(sheet && { sheet: boxOf(sheet) }) };
}

// The view's body, which a popover stays inside.
export const bodyOf = (element: Element | null | undefined) => {
  const body = element?.closest('.pair-body')?.getBoundingClientRect();
  return body ? boxOf(body) : null;
};

// The focus, back where a closed popover was opened from: the pin's chip
// (under the piece first when it opened there), or a button on its part (an
// image's box number), else the piece itself.
export function focusBack(stage: Element | null, foot: Element | null, id: string | null, fromStrip: boolean) {
  const at = id && CSS.escape(id);
  const onPart = () => at && (stage?.querySelector<HTMLElement>(`[data-chip-pin="${at}"] .pin-chip-open`) ?? stage?.querySelector<HTMLElement>(`[data-pair-anchor~="${at}"] button`));
  const inStrip = () => {
    const chip = id ? stripAnchor(foot, id) : null;
    return (chip?.matches('button') ? chip : chip?.querySelector('.pin-chip-open')) as HTMLElement | null | undefined;
  };
  const target = fromStrip ? (inStrip() ?? onPart()) : (onPart() ?? inStrip());
  if (target) return target.focus({ preventScroll: true });
  quietFocus(stage?.querySelector<HTMLElement>('.zoom-stage') ?? stage?.closest<HTMLElement>('.pair-shell'));
}

// A chip's (or a button's) place, for a popover opened from it.
export const chipAt = (chip: Element | null): PartAt | null => (chip ? { part: boxOf(chip.getBoundingClientRect()) } : null);

// A part as its chip under the piece names it, short: by its name where the
// piece marks it without a chip (box 2, node "Retry"); else, a line or words
// found no more or resolved, by the text it was on, as it read then.
const shortPart = (pin: Pin, block: Block, byName: boolean) => clip(byName ? pinPart(pin, block) : pin.quote, 30);
// The whole block, as its chip names it: "Whole drawing".
export const wholePart =(pin: Pin, block: Block) => pinPart(pin, block).replace(/^the /, '').replace(/^./, (c) => c.toUpperCase());

export function PieceView<B extends Block>(props: {
  block: B; // as the board has it now
  name: string;
  version?: BlockVersion; // an earlier version: shown, not paired on
  pinId?: string; // a thread to open at
  pinAsked?: number; // counts the asks to open at pinId: asked again for the same pin, it opens it again
  paired?: boolean; // it opens already paired
  part: string; // its part's name (core/parts.ts): 'code', 'note', 'diagram', 'image'
  asks?: false; // its parts take no requests: no Pair, and pointing works while reading
  opens?: Opens; // where a popover goes by a part: beside it (the default), or under it (words in a paragraph)
  listed?: true; // it marks its parts without a chip of their own: their pins are listed under it too
  label: string;
  icon: ReactNode;
  title: string;
  from: ReactNode;
  fromTitle?: string;
  browse: { label: string; hint: string };
  it: string; // the piece as a change to it is said: "the code"
  point: string; // how to point at a part, in the band: "click a line, or drag over several"
  does: string; // what the agent does with a request: "changes the code"
  example: string; // what a request might say: "rename it, say"
  controls?: ReactNode;
  className?: string;
  body: (props: PieceBodyProps<B>) => ReactNode;
  edit?: PieceEdit<B>; // how a person edits it by hand, for a kind they can
  onClose(): void;
}) {
  const { block, name, version, pinId, pinAsked, part, label, icon, title, from, fromTitle, browse, it, point, does, example, controls, className, body, edit, onClose } = props;
  const opens = props.opens ?? 'beside';
  const canvas = useCanvas();
  const { seeItem } = canvas;
  const shown = useMemo(() => (version ? (atVersion(block, version) as B) : block), [block, version]);
  const asks = props.asks !== false;
  const pairing = usePairing(block, name, part, { readOnly: Boolean(version), start: props.paired && asks ? 'pair' : undefined });
  const stage = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLElement>(null);
  const [chosen, setChosen] = useState<PinDraft | null>(null);
  const [askText, setAskText] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const drafts = useRef(new Map<string, string>()); // what was typed about a part, kept as its prompt closes
  const [thread, setThread] = useState<string | null>(pinId ?? null);
  const [threadBy, setThreadBy] = useState<'part' | 'strip'>('part'); // what the open thread opened from
  const [justPinned, setJustPinned] = useState<Pin | null>(null);
  const hand = useHandEdit(block, name, edit, Boolean(edit) && !pairing.readOnly);
  const pointing = asks ? pairing.mode === 'pair' : !pairing.readOnly && !hand.on;
  const editingRef = useRef(hand.on);
  editingRef.current = hand.on;
  const startEdit = useCallback(() => {
    if (pairing.mode === 'pair') pairing.browse();
    setChosen(null);
    setThread(null);
    hand.start();
  }, [pairing, hand]);
  // Closing saves what was typed first; it stays open if that can't be saved yet.
  const close = useCallback(() => {
    void hand.stop().then((closed) => closed && onClose());
  }, [hand, onClose]);

  // The pins people talk about on its parts, with one just made until the
  // board has it, and, where the prompt is the canvas's, the work it pinned
  // there; and the pins on the whole block.
  const boardPins = canvas.pins.get(block.id);
  const pins = useMemo(() => {
    if (version) return [];
    const talked = (boardPins ?? []).filter((p) => p.anchor.kind !== 'block' && (p.discussion || !asks));
    return justPinned && !talked.some((p) => p.id === justPinned.id) ? [...talked, justPinned] : talked;
  }, [boardPins, justPinned, version, asks]);
  const whole = useMemo(() => (version ? [] : (boardPins ?? []).filter((p) => p.anchor.kind === 'block')), [boardPins, version]);
  useEffect(() => {
    if (justPinned && boardPins?.some((p) => p.id === justPinned.id)) setJustPinned(null);
  }, [boardPins, justPinned]);
  const placed = useMemo<PlacedPin[]>(() => pins.map((pin) => ({ pin, place: placePin(shown, pin) })), [pins, shown]);
  // Drawn on its part: found, and open unless resolved (or it is the one open).
  const drawn = useMemo(() => placed.filter(({ pin, place }) => place && (!pin.discussion?.resolved || pin.id === thread)), [placed, thread]);
  // Under it: the whole block's, those lost, those resolved (folded under
  // Done, to open again), and, for a kind that lists them, every part's.
  const listed = props.listed === true;
  const strip = useMemo<StripPin[]>(
    () => [
      ...whole.map((pin) => ({ pin, ...(pin.discussion && { part: wholePart(pin, shown) }) })),
      ...placed
        .filter(({ pin, place }) => !place || listed || pin.discussion?.resolved)
        .map(({ pin, place }) => ({ pin, part: shortPart(pin, shown, Boolean(place) && listed), ...(!place && { lost: pinLost(pin, shown) }) })),
    ],
    [whole, placed, listed, shown],
  );

  // Leaving Pair drops the part being asked about, keeping what was typed for it.
  useEffect(() => {
    if (pointing) return;
    setChosen((was) => {
      if (was && askText.trim()) drafts.current.set(JSON.stringify(was.part), askText);
      return null;
    });
    setAskText('');
  }, [pointing]);

  // The agent's change landing: said for a moment, the piece shown anew where it was.
  const [changed, setChanged] = useState<string | null>(null);
  const rev = useRef(block.rev);
  useEffect(() => {
    if (block.rev === rev.current) return;
    rev.current = block.rev;
    const by = block.updatedBy;
    if (by.kind === 'human' && by.name === name) return; // their own edit, elsewhere or here
    if (editingRef.current) return; // the editing band says it, with what to do
    setChanged(`${by.name} changed ${it}: showing the new version, where you were.`);
  }, [block.rev]); // who changed it is read as the revision lands
  useEffect(() => {
    if (!changed) return;
    const timer = setTimeout(() => setChanged(null), CHANGED_MS);
    return () => clearTimeout(timer);
  }, [changed]);

  // Closing the prompt keeps what was typed in it for its part, for when it is pointed at again.
  const askTextRef = useRef(askText);
  askTextRef.current = askText;
  const closeAsk = useCallback(() => {
    setChosen((was) => {
      const text = askTextRef.current;
      if (was && text.trim()) drafts.current.set(JSON.stringify(was.part), text);
      return null;
    });
    setAskText('');
  }, []);
  const pick = useCallback((draft: PinDraft) => {
    // Once a person types about one part, pointing at another moves the prompt
    // there, keeping it. What was kept for a part comes back into its prompt,
    // and is kept again only as that closes: carried to another part and
    // sent, it doesn't come back on the first.
    const typed = askTextRef.current;
    const key = JSON.stringify(draft.part);
    const kept = typed.trim() ? undefined : drafts.current.get(key);
    if (kept !== undefined) drafts.current.delete(key);
    setChosen(draft);
    setAskText(typed.trim() ? typed : (kept ?? ''));
    setAskError(null);
    setThread(null);
  }, []);
  const openPin = useCallback(
    (id: string) => {
      setThread((was) => (was === id ? null : id));
      setThreadBy('part');
      setChosen(null);
      seeItem(id);
    },
    [seeItem],
  );

  // A pin opened from elsewhere, or from the session's list: its part in view,
  // or its chip under the piece. Asked again for the same pin, it opens again.
  const reveal = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const element = stage.current?.querySelector(`[data-pair-anchor~="${CSS.escape(id)}"]`) ?? stage.current?.querySelector(`[data-chip-pin="${CSS.escape(id)}"]`);
      if (element) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    });
  }, []);
  useEffect(() => {
    if (!pinId) return;
    setThread(pinId);
    setThreadBy('part');
    reveal(pinId);
  }, [pinId, pinAsked, reveal]);
  const openRequest = (pin: Pin) => {
    setThread(pin.id);
    setThreadBy('part');
    setChosen(null);
    seeItem(pin.id);
    reveal(pin.id);
  };
  // From the row under the piece, a chip opens its thread by itself; from its
  // lists (More, Done), by its part where the piece draws it, else by the list's button.
  const openFromStrip = (pin: Pin, from: 'row' | 'list') => {
    const onPart = from === 'list' && Boolean(placePin(shown, pin)) && pin.anchor.kind !== 'block';
    setThread((was) => (was === pin.id && from === 'row' ? null : pin.id));
    setThreadBy(onPart ? 'part' : 'strip');
    setChosen(null);
    seeItem(pin.id);
    if (onPart) reveal(pin.id);
  };

  // The thread open, and whether it opens by its part or by its chip under the piece.
  const open = [...pins, ...whole].find((p) => p.id === thread && p.discussion);
  const byPart = Boolean(open && threadBy === 'part' && drawn.some(({ pin }) => pin.id === open.id));
  const closeThread = useCallback(() => setThread(null), []);

  // Escape ends editing (saving it), or closes the prompt, then a thread, then
  // the view (once the agent picker is closed). In a cell being edited, it
  // leaves the cell first.
  useEscapeSteps(
    Boolean(chosen || open),
    (e) => {
      if (hand.on) {
        if (!(hand.live && typing(e.target))) void hand.stop();
      } else if (chosen) closeAsk();
      else if (open) setThread(null);
      else return false;
      return true;
    },
    onClose,
  );

  // A request to the agent paired with, or a note on the part.
  const submit = async (ask: boolean) => {
    if (!chosen || !askText.trim() || askBusy) return;
    setAskBusy(true);
    setAskError(null);
    try {
      const body = ask ? pairing.address(askText) : askText;
      const { pin } = await api.pinComment(block.id, name, { part: chosen.part, body, ask });
      drafts.current.delete(JSON.stringify(chosen.part));
      setJustPinned(pin);
      setThread(pin.id);
      setThreadBy('part');
      setChosen(null);
      setAskText('');
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setAskBusy(false);
    }
  };

  // Under a request on a thread opened here: what the agent is doing about it.
  const live = (pin: Pin) => (note: ReactNode) => <PinLine pin={pin} fallback={note} />;
  const within = () => bodyOf(stage.current);

  const who = pairing.agent;
  const choice = pairing.agents.find((a) => a.name === who);
  const canEdit = Boolean(edit) && !pairing.readOnly;
  // Reading, a double-click on the piece opens its editor, unless it was on a control or a pin.
  const onDoubleClick = (e: React.MouseEvent) => {
    if (!canEdit || edit?.doubleClick === false || hand.on || pointing) return;
    if ((e.target as Element).closest('a, button, input, textarea, select, [data-chip-pin], .pair-pin-chip, .pin-thread, .pin-prompt')) return;
    window.getSelection()?.removeAllRanges(); // the word the double-click selected
    startEdit();
  };
  // Pair, for parts that take requests: what it does, and how to point at one while pairing.
  const pairs = asks
    ? {
        pairing,
        pairHint: `Point at any part to ask the agent to change it, or to leave a note on it.`,
        pairBand: who
          ? `Pairing with ${who}: ${point} to ask for a change, or to leave a note. ${reachWords(choice, who)}`
          : `${point[0].toUpperCase()}${point.slice(1)} to leave a note on it or ask an agent to change it.`,
        open: thread,
        onOpenRequest: openRequest,
      }
    : { pairs: false as const };

  // The popover: the prompt by the part being asked about, or the thread open.
  let popover: ReactNode = null;
  if (!hand.on && chosen) {
    popover = (
      <PinPopover key="ask" from={stage} at={() => partAt(stage.current, DRAFT_ANCHOR)} within={within} opens={opens} giveBack={() => focusBack(stage.current, foot.current, null, false)}>
        {asks ? (
          <PairAskPrompt
            key={JSON.stringify(chosen.part)}
            quote={partQuote({ anchor: chosen.part, quote: chosen.quote }, shown)}
            text={askText}
            busy={askBusy}
            error={askError}
            agent={pairing.agent}
            does={does}
            example={example}
            hint={pairing.requests.length === 0}
            onText={(text) => {
              setAskText(text);
              setAskError(null);
            }}
            onSubmit={(ask) => void submit(ask)}
            onClose={closeAsk}
          />
        ) : (
          <PinPrompt
            draft={chosen}
            block={shown}
            name={name}
            style={{}}
            above={false}
            onChange={setChosen}
            onClose={closeAsk}
            onCommented={(pin) => {
              setJustPinned(pin);
              setThread(pin.id);
              setThreadBy('part');
            }}
          />
        )}
      </PinPopover>
    );
  } else if (!hand.on && open) {
    const id = open.id;
    popover = (
      <PinPopover
        key={`thread ${id}`}
        from={stage}
        at={() => (byPart ? partAt(stage.current, id) : chipAt(stripAnchor(foot.current, id)))}
        within={within}
        opens={byPart ? opens : 'over'}
        takeFocus
        giveBack={() => focusBack(stage.current, foot.current, id, !byPart)}
      >
        <PinThread pin={open} block={shown} name={name} onClose={closeThread} live={live(open)} address={pairing.address} />
      </PinPopover>
    );
  }

  return (
    <PairingShell
      {...pairs}
      edit={canEdit && edit ? { on: hand.on, hint: edit.hint, start: startEdit, stop: hand.stop } : undefined}
      className={`piece-view${className ? ` ${className}` : ''}`}
      label={label}
      icon={icon}
      title={title}
      from={from}
      fromTitle={fromTitle}
      browse={browse}
      band={
        hand.on ? (
          <EditBands hand={hand} it={it} back={browse.label} />
        ) : (
          changed && (
            <div className="pair-band is-changed" role="status">
              {changed}
            </div>
          )
        )
      }
      controls={hand.on ? undefined : controls}
      onClose={close}
    >
      <div className={`piece-stage${pointing ? ' is-pointing' : ''}${hand.on ? ' is-editing' : ''}`} ref={stage} onDoubleClick={onDoubleClick}>
        {hand.on ? hand.editor : body({ block: shown, placed: version ? [] : drawn, pointing, chosen, open: thread, pick, openPin })}
      </div>
      {strip.length > 0 && !hand.on && (
        <footer className="piece-apart" ref={foot}>
          <PinStrip pins={strip} open={thread} onOpen={openFromStrip} />
        </footer>
      )}
      {popover}
    </PairingShell>
  );
}

// While editing: how it saves, and, if the piece changed meanwhile, whose
// change it was and what to do about the two.
function EditBands({ hand, it, back }: { hand: HandEdit<Block>; it: string; back: string }) {
  if (hand.theirs) {
    return (
      <div className="pair-band is-conflict" role="alert">
        <span>
          {hand.theirs} changed {it} while you were editing. Keep yours to save it over their change, or take theirs to start again from it.
        </span>
        <span className="pair-band-actions">
          <button type="button" className="btn btn-small" onClick={hand.takeTheirs}>
            Take theirs
          </button>
          <button type="button" className="btn btn-small btn-primary" onClick={hand.keepMine}>
            Keep yours
          </button>
        </span>
      </div>
    );
  }
  return (
    <div className={`pair-band is-editing${hand.error ? ' is-error' : ''}`} role="status">
      <span>
        {hand.error ??
          (hand.saving
            ? 'Saving…'
            : hand.live
              ? `Editing on your own: each change saves as you make it. ${back} or Esc goes back.`
              : `Editing on your own: it saves as you go back to ${back}, or press Esc.`)}
      </span>
      {!hand.live && (
        <span className="pair-band-actions">
          <button type="button" className="btn btn-small btn-quiet" onClick={hand.discard} disabled={hand.saving}>
            Discard changes
          </button>
        </span>
      )}
    </div>
  );
}
