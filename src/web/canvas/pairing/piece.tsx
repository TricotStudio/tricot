// A canvas block's full view in the pairing shell (shell.tsx), for the kinds
// whose own parts take requests: a code block's lines, a note's words, a
// diagram's nodes and arrows, boxes on an image (core/parts.ts). The same as
// a website's or a Google Doc's: Read (or View) on your own, or "Pair with
// <agent>", where pointing at a part opens a prompt by it to ask the agent
// to change it, or to leave a note. A request goes straight to the agent
// paired with (core/pairing.ts addressTo); its thread opens on the part,
// with the agent's live steps under it (pinLine.tsx); and the session's list
// is beside the piece. When the agent's change lands (a new revision of the
// block, live from the board), the piece shows it where it was, and its pins
// stay on their parts as far as the kind finds them again; those it can't
// are listed under it, threads and all.
//
// A kind the canvas lets people edit can be edited here too (edit.tsx): Edit
// in the bar, or a double-click while reading, opens its editor in place of
// the piece, until they go back to Read or Pair, press Esc or close it.
//
// The piece draws the body: its parts, marked where they are pinned, and
// how pointing at one works. It marks each pinned part's element with
// data-pair-anchor="<pin ids>", and the part being asked about with
// data-pair-anchor="draft": the prompt and threads open by those.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { atVersion } from '../../../core/canvas';
import { partQuote, pinLost, pinPart, placePin } from '../../../core/pins';
import type { Block, BlockVersion, Pin } from '../../../core/types';
import { api } from '../../shared/api';
import { typing } from '../../shared/hooks';
import { useCanvas, type PinDraft } from '../context';
import { PinThread, type PlacedPin } from '../pins';
import { PairAskPrompt, PairPinChip } from './ask';
import { useHandEdit, type HandEdit, type PieceEdit } from './edit';
import { PinLine } from './pinLine';
import { placeBy, unionRect, type Rect } from './pointing';
import { usePairing } from './session';
import { PairingShell, panelOpen, reachWords } from './shell';
import './piece.css';

const THREAD_WIDTH = 340;
const PROMPT_HEIGHT = 230;
const THREAD_HEIGHT = 300;
const CHANGED_MS = 3200; // how long "Claude changed the code" stays

export const DRAFT_ANCHOR = 'draft';

// What the piece's body is given to draw.
export interface PieceBodyProps<B extends Block = Block> {
  block: B; // as shown: an earlier version, when one is being looked at
  placed: PlacedPin[]; // its pins people talk about, where each is now (null: lost); none on an earlier version
  pointing: boolean; // pairing: pointing at a part picks it
  chosen: PinDraft | null; // the part being asked about, until it is
  open: string | null; // the pin whose thread is open
  pick(draft: PinDraft): void;
  openPin(id: string): void;
}

// The elements marked for a pin (or the draft), and the box round them in the stage.
function anchorRect(stage: HTMLElement, id: string): Rect | null {
  const found = stage.querySelectorAll(`[data-pair-anchor~="${CSS.escape(id)}"]`);
  if (found.length === 0) return null;
  const from = stage.getBoundingClientRect();
  const rects = [...found].flatMap((element) => {
    const r = element.getBoundingClientRect();
    return r.width || r.height ? [{ x: r.left - from.left, y: r.top - from.top, w: r.width, h: r.height }] : [];
  });
  return unionRect(rects);
}

// Where the marked part `id` is in the stage, as it scrolls, zooms and
// redraws: measured each frame while something is open by it.
function useAnchor(stage: React.RefObject<HTMLDivElement | null>, id: string | null): { rect: Rect | null; size: { w: number; h: number } } {
  const [state, setState] = useState<{ rect: Rect | null; size: { w: number; h: number } }>({ rect: null, size: { w: 0, h: 0 } });
  useLayoutEffect(() => {
    if (!id) return setState((was) => (was.rect ? { ...was, rect: null } : was));
    let frame = 0;
    const measure = () => {
      const element = stage.current;
      if (element) {
        const rect = anchorRect(element, id);
        const size = { w: element.clientWidth, h: element.clientHeight };
        setState((was) => {
          const same = (a: Rect | null, b: Rect | null) => (a && b ? a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h : a === b);
          return same(was.rect, rect) && was.size.w === size.w && was.size.h === size.h ? was : { rect, size };
        });
      }
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [stage, id]);
  return state;
}

export function PieceView<B extends Block>(props: {
  block: B; // as the board has it now
  name: string;
  version?: BlockVersion; // an earlier version: shown, not paired on
  pinId?: string; // a thread to open at
  part: string; // its part's name (core/parts.ts): 'code', 'note', 'diagram', 'image'
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
  const { block, name, version, pinId, part, label, icon, title, from, fromTitle, browse, it, point, does, example, controls, className, body, edit, onClose } = props;
  const canvas = useCanvas();
  const { seeItem } = canvas;
  const shown = useMemo(() => (version ? (atVersion(block, version) as B) : block), [block, version]);
  const pairing = usePairing(block, name, part, { readOnly: Boolean(version) });
  const pointing = pairing.mode === 'pair';
  const stage = useRef<HTMLDivElement>(null);
  const [chosen, setChosen] = useState<PinDraft | null>(null);
  const [askText, setAskText] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [thread, setThread] = useState<string | null>(pinId ?? null);
  const [justPinned, setJustPinned] = useState<Pin | null>(null);
  const [threadHeight, setThreadHeight] = useState(THREAD_HEIGHT); // as the open thread is drawn, to place it
  const hand = useHandEdit(block, name, edit, Boolean(edit) && !pairing.readOnly);
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

  // The pins people talk about on its parts, with one just made until the board has it.
  const boardPins = canvas.pins.get(block.id);
  const pins = useMemo(() => {
    if (version) return [];
    const talked = (boardPins ?? []).filter((p) => p.discussion && p.anchor.kind !== 'block');
    return justPinned && !talked.some((p) => p.id === justPinned.id) ? [...talked, justPinned] : talked;
  }, [boardPins, justPinned, version]);
  useEffect(() => {
    if (justPinned && boardPins?.some((p) => p.id === justPinned.id)) setJustPinned(null);
  }, [boardPins, justPinned]);
  const placed = useMemo<PlacedPin[]>(() => pins.map((pin) => ({ pin, place: placePin(shown, pin) })), [pins, shown]);
  // Drawn on its part: found, and open unless resolved (or it is the one open).
  const drawn = useMemo(() => placed.filter(({ pin, place }) => place && (!pin.discussion?.resolved || pin.id === thread)), [placed, thread]);
  const lost = useMemo(() => placed.filter(({ pin, place }) => !place && (!pin.discussion?.resolved || pin.id === thread)).map(({ pin }) => pin), [placed, thread]);

  // Leaving Pair drops the part being asked about, and what was typed for it.
  useEffect(() => {
    if (pointing) return;
    setChosen(null);
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

  const closeAsk = useCallback(() => {
    setChosen(null);
    setAskText('');
  }, []);
  const pick = useCallback(
    (draft: PinDraft) => {
      // Once a person types about one part, pointing at another moves the prompt there, keeping it.
      setChosen(draft);
      setAskError(null);
      setThread(null);
    },
    [],
  );
  const openPin = useCallback(
    (id: string) => {
      setThread((was) => (was === id ? null : id));
      setChosen(null);
      seeItem(id);
    },
    [seeItem],
  );

  // A pin opened from elsewhere, or from the session's list: its part in view.
  const reveal = useCallback((id: string) => {
    requestAnimationFrame(() => {
      const element = stage.current?.querySelector(`[data-pair-anchor~="${CSS.escape(id)}"]`) ?? stage.current?.querySelector(`[data-chip-pin="${CSS.escape(id)}"]`);
      element?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    });
  }, []);
  useEffect(() => {
    if (!pinId) return;
    setThread(pinId);
    reveal(pinId);
  }, [pinId, reveal]);
  const openRequest = (pin: Pin) => {
    setThread(pin.id);
    setChosen(null);
    seeItem(pin.id);
    reveal(pin.id);
  };

  // Escape ends editing (saving it), or closes the prompt, then a thread, then
  // the view (once the agent picker is closed). In a cell being edited, it
  // leaves the cell first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || panelOpen()) return;
      if (hand.on) {
        if (!(hand.live && typing(e.target))) void hand.stop();
      } else if (chosen) closeAsk();
      else if (thread) setThread(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chosen, thread, onClose, closeAsk, hand]);

  // A request to the agent paired with, or a note on the part.
  const submit = async (ask: boolean) => {
    if (!chosen || !askText.trim() || askBusy) return;
    setAskBusy(true);
    setAskError(null);
    try {
      const body = ask ? pairing.address(askText) : askText;
      const { pin } = await api.pinComment(block.id, name, { part: chosen.part, body, ask });
      setJustPinned(pin);
      setThread(pin.id);
      setChosen(null);
      setAskText('');
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setAskBusy(false);
    }
  };

  const open = pins.find((p) => p.id === thread);
  const openDrawn = open && drawn.some(({ pin }) => pin.id === open.id) ? open : undefined;
  const openLost = open && lost.includes(open) ? open : undefined;
  const promptAnchor = useAnchor(stage, chosen ? DRAFT_ANCHOR : null);
  const threadAnchor = useAnchor(stage, openDrawn ? openDrawn.id : null);
  const promptAt = chosen && promptAnchor.rect && placeBy(promptAnchor.rect, promptAnchor.size, { width: THREAD_WIDTH, height: PROMPT_HEIGHT });
  const threadAt = openDrawn && threadAnchor.rect && placeBy(threadAnchor.rect, threadAnchor.size, { width: THREAD_WIDTH, height: threadHeight });
  // Under a request on a thread opened here: what the agent is doing about it.
  const live = (pin: Pin) => (note: ReactNode) => <PinLine pin={pin} fallback={note} />;

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
  return (
    <PairingShell
      pairing={pairing}
      edit={canEdit && edit ? { on: hand.on, hint: edit.hint, start: startEdit, stop: hand.stop } : undefined}
      className={`piece-view${className ? ` ${className}` : ''}`}
      label={label}
      icon={icon}
      title={title}
      from={from}
      fromTitle={fromTitle}
      browse={browse}
      pairHint={`Point at any part to ask the agent to change it, or to leave a note on it.`}
      pairBand={
        <>
          {who ? `Pairing with ${who}: ${point} to ask ${who} to change it, or to leave a note.` : `${point[0].toUpperCase()}${point.slice(1)} to leave a note on it or ask an agent to change it.`}
          {who ? ` ${reachWords(choice, who)}` : ''}
        </>
      }
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
      open={thread}
      onOpenRequest={openRequest}
      onClose={close}
    >
      <div className={`piece-stage${pointing ? ' is-pointing' : ''}${hand.on ? ' is-editing' : ''}`} ref={stage} onDoubleClick={onDoubleClick}>
        {hand.on ? hand.editor : body({ block: shown, placed: version ? [] : drawn, pointing, chosen, open: thread, pick, openPin })}
        <div className="piece-layer" hidden={hand.on}>
          {openDrawn && threadAt && (
            <PinThread
              key={openDrawn.id}
              pin={openDrawn}
              block={shown}
              name={name}
              above={threadAt.above}
              style={{ left: threadAt.left, top: threadAt.top, width: THREAD_WIDTH }}
              onClose={() => setThread(null)}
              onHeight={setThreadHeight}
              live={live(openDrawn)}
              address={pairing.address}
            />
          )}
          {chosen && promptAt && (
            <PairAskPrompt
              key={JSON.stringify(chosen.part)}
              quote={partQuote({ anchor: chosen.part, quote: chosen.quote }, shown)}
              style={{ left: promptAt.left, top: promptAt.top, width: THREAD_WIDTH }}
              above={promptAt.above}
              text={askText}
              busy={askBusy}
              error={askError}
              agent={pairing.agent}
              does={does}
              example={example}
              onText={(text) => {
                setAskText(text);
                setAskError(null);
              }}
              onSubmit={(ask) => void submit(ask)}
              onClose={closeAsk}
            />
          )}
        </div>
      </div>
      {lost.length > 0 && !hand.on && (
        <footer className="piece-apart">
          <div className="piece-apart-chips">
            <span className="faint small">No longer where they were</span>
            {lost.map((pin) => (
              <PairPinChip key={pin.id} pin={pin} open={pin.id === thread} part={pinPart(pin, shown)} lost={pinLost(pin, shown)} onToggle={() => openPin(pin.id)} />
            ))}
          </div>
          {openLost && (
            <PinThread key={openLost.id} inline pin={openLost} block={shown} name={name} onClose={() => setThread(null)} live={live(openLost)} address={pairing.address} />
          )}
        </footer>
      )}
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
