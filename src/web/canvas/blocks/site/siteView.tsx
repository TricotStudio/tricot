// A website's full view, in the pairing shell (canvas/pairing): the site
// takes the whole canvas, live, as a Google Doc does. In Browse people
// scroll, click and move between its pages, at a desktop's width or a
// phone's; the block keeps the page shown. Paired with an agent, the element
// under the pointer is outlined, and a click picks it: a request to the
// agent to change it, or a note on it, pins it, and its thread opens on it,
// with the agent's steps under the request as it works. The page reloads in
// place, where it was scrolled to, when the site's files change. The frame
// runs sandboxed at the site server's address (server/sites/), and only says
// where things are.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FromFrame, PickedElement, Rect } from '../../../../core/blocks/site/messages';
import { elementQuote, siteName, siteSourceWords } from '../../../../core/blocks/site/site';
import { clip } from '../../../../core/format';
import type { Block, Pin } from '../../../../core/types';
import { api } from '../../../shared/api';
import { Icon } from '../../../shared/components';
import { useCanvas } from '../../context';
import { PairAskPrompt, PairPinChip } from '../../pairing/ask';
import { bodyOf, chipAt, focusBack } from '../../pairing/piece';
import { PinLine } from '../../pairing/pinLine';
import type { PartAt } from '../../pairing/pointing';
import { PinPopover } from '../../pairing/popover';
import { usePairing } from '../../pairing/session';
import { PairingShell, reachWords, useEscapeSteps } from '../../pairing/shell';
import { PinStrip, stripAnchor, type StripPin } from '../../pairing/strip';
import { PinThread } from '../../pins';
import type { OverlayProps } from '../kind';
import { SANDBOX, pageAddress, pinsOnPage, siteChanged, tell, useFrameMessages, useSiteAddress } from './frame';

type SiteBlock = Extract<Block, { type: 'site' }>;

const PHONE_WIDTH = 390;
// What the frame says is believed only so far: its page runs the site's own
// scripts too, which could say the same things.
const READY_LIMIT = { count: 12, ms: 5000 }; // pages shown, at most, so fast
const SAVE_MS = 1500; // the page and title shown are kept on the block once they settle
const RELOAD_MS = 1500; // a change to the files reloads the page at most so often
const REVEAL_MS = 3000; // an element asked into view is asked again, as its page is laid out, for so long

const pageWords = (page: string) => (page === '/' ? 'Home page' : page);
// What was typed about an element is kept by its page and its selector: another page's h1 is another element.
const draftKey = (page: string, selector: string) => `${page} ${selector}`;

// An element the frame says is at `rect` (in the page shown) as the window
// has it, for the popover by it: beside a phone's screen when there's room,
// as beside a sheet (pairing/pointing.ts).
function elementAt(screen: HTMLElement | null, rect: Rect | null | undefined, phone: boolean): PartAt | null {
  if (!screen || !rect) return null;
  const at = screen.getBoundingClientRect();
  const part = { left: at.left + rect.x, top: at.top + rect.y, right: at.left + rect.x + rect.w, bottom: at.top + rect.y + rect.h };
  return phone ? { part, sheet: { left: at.left, top: at.top, right: at.right, bottom: at.bottom } } : { part };
}

export function SiteView({ block, name, pinId, pinAsked, onClose }: OverlayProps<SiteBlock>) {
  const canvas = useCanvas();
  const { seeItem, readOnly } = canvas;
  const { address, error, blocked } = useSiteAddress(block.id);
  const siteOrigin = address?.origin;
  const frame = useRef<HTMLIFrameElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null); // the body, which is drawn as the site loads: its popovers belong to it

  // Pairing with an agent is picking parts of the page to ask it about.
  const pairing = usePairing(block, name, 'site');
  const editing = pairing.mode === 'pair';
  const [phone, setPhone] = useState(false);
  const [page, setPage] = useState(block.page);
  const [title, setTitle] = useState(block.pages?.find((p) => p.path === block.page)?.title ?? '');
  // The page the frame loads, and how many times: a new load reloads it.
  const [load, setLoad] = useState({ page: block.page, n: 0, scrollY: 0 });
  const [rects, setRects] = useState<Record<string, Rect | null>>({});
  const [lost, setLost] = useState<string[]>([]);
  const [chosen, setChosen] = useState<PickedElement | null>(null);
  const [chosenRect, setChosenRect] = useState<Rect | null>(null);
  const [askText, setAskText] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const drafts = useRef(new Map<string, string>()); // what was typed about an element, kept as its prompt closes
  const [thread, setThread] = useState<string | null>(pinId ?? null);
  const threadNow = useRef(thread);
  threadNow.current = thread;
  const [threadBy, setThreadBy] = useState<'part' | 'strip'>('part'); // what the open thread opened from
  const [justPinned, setJustPinned] = useState<Pin | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [changedAt, setChangedAt] = useState<number | null>(null);
  const foot = useRef<HTMLElement>(null);
  const ready = useRef(false); // the frame said which page it shows, since it last loaded
  // Since the frame last loaded: whether it was scrolled back to where it was.
  const loaded = useRef({ restored: false });
  const readies = useRef<number[]>([]);
  const reloadedAt = useRef(0);
  const saving = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(saving.current), []);
  useEffect(() => {
    // A new load: what it was told, it is told again.
    ready.current = false;
    loaded.current = { restored: false };
  }, [load]);

  // The pins on its elements, with one just made until the board has it.
  const boardPins = canvas.pins.get(block.id);
  const sitePins = useMemo(() => {
    const pins = (boardPins ?? []).filter((p) => p.anchor.kind === 'site' && p.discussion);
    return justPinned && !pins.some((p) => p.id === justPinned.id) ? [...pins, justPinned] : pins;
  }, [boardPins, justPinned]);
  useEffect(() => {
    if (justPinned && boardPins?.some((p) => p.id === justPinned.id)) setJustPinned(null);
  }, [boardPins, justPinned]);
  const here = useMemo(() => sitePins.filter((p) => p.anchor.kind === 'site' && p.anchor.page === page), [sitePins, page]);
  const elsewhere = useMemo(() => sitePins.filter((p) => p.anchor.kind === 'site' && p.anchor.page !== page), [sitePins, page]);
  const targets = useMemo(() => pinsOnPage(here, page), [here, page]);
  const targetKey = JSON.stringify(targets);

  // The screen's size, for placing what is drawn over it.
  useEffect(() => {
    const element = screen.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ w: element.clientWidth, h: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, [address]);

  // A pinned element brought into view. A frame just loaded may lay its page
  // out before it knows its own size, which leaves it where it was, so it is
  // asked again as the frame says where the element is, until it is on screen.
  const revealing = useRef<{ id: string; until: number } | null>(null);
  const reveal = (id: string) => {
    revealing.current = { id, until: Date.now() + REVEAL_MS };
    tell(frame.current, siteOrigin, { type: 'reveal', id });
  };

  // A pin opened from elsewhere (its chip on the card, a comment about it, a
  // Needs you item) opens its thread on its element, on its page, brought into
  // view: once the frame finds it, or now, when the frame shows its page and
  // has found its pins. Asked again, even for the pin already open, the same.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!pinId) return;
    setThread(pinId);
    const pin = sitePins.find((p) => p.id === pinId);
    const on = pin?.anchor.kind === 'site' ? pin.anchor.page : page;
    if (on !== page) {
      opened.current = pinId;
      ready.current = false;
      setLoad((now) => ({ page: on, n: now.n + 1, scrollY: 0 }));
    } else if (ready.current) reveal(pinId);
    else opened.current = pinId;
  }, [pinId, pinAsked]); // only when asked to open at a pin

  // The page shown, and its title, kept on the block for everyone and for
  // agents once it settles: what a person looking at the site moved to, not
  // each thing its scripts say.
  const keep = (shown: string, shownTitle: string) => {
    clearTimeout(saving.current);
    if (readOnly) return;
    saving.current = setTimeout(() => {
      const known = block.pages?.find((p) => p.path === shown)?.title;
      if (shown === block.page && (!shownTitle || shownTitle === known)) return;
      void api.updateBlock(block.id, name, { page: shown, pageTitle: shownTitle }).catch(() => undefined);
    }, SAVE_MS);
  };

  const onMessage = (message: FromFrame) => {
    switch (message.type) {
      case 'ready': {
        const now = Date.now();
        readies.current = [...readies.current.filter((at) => now - at < READY_LIMIT.ms), now];
        if (readies.current.length > READY_LIMIT.count) break; // a page saying so this fast isn't a person moving around
        const moved = message.page !== page;
        ready.current = true;
        setPage(message.page);
        setTitle(message.title);
        if (moved) {
          setChosen(null);
          setRects({});
          setLost([]);
        }
        tell(frame.current, siteOrigin, { type: 'mode', edit: editing });
        tell(frame.current, siteOrigin, { type: 'pins', pins: pinsOnPage(sitePins, message.page) });
        // Each page the frame moves to listens for changes; one already listening keeps its one stream.
        tell(frame.current, siteOrigin, { type: 'watch' });
        if (!loaded.current.restored) {
          loaded.current.restored = true;
          if (load.scrollY) tell(frame.current, siteOrigin, { type: 'scrollTo', y: load.scrollY });
        }
        keep(message.page, message.title);
        break;
      }
      case 'rects': {
        setRects(message.pins);
        setChosenRect(message.chosen);
        const asked = revealing.current;
        if (!asked) break;
        const rect = message.pins[asked.id];
        const height = screen.current?.clientHeight ?? 0;
        const shown = rect && rect.w > 0 && rect.y < height && rect.y + rect.h > 0;
        if (!rect || shown || Date.now() > asked.until) revealing.current = null;
        else tell(frame.current, siteOrigin, { type: 'reveal', id: asked.id });
        break;
      }
      case 'found':
        // Lost is this view's word only: the board keeps the pin as it was.
        setLost(message.lost);
        if (opened.current && message.found.includes(opened.current)) {
          reveal(opened.current);
          opened.current = null;
        }
        break;
      case 'select':
        // Once a person types about one element, another can't take its place.
        if (readOnly || (chosen && askText.trim())) break;
        setChosen(message.element);
        setChosenRect(message.element.rect);
        // What was kept for it comes back into its prompt, kept again as that closes.
        setAskText(drafts.current.get(draftKey(page, message.element.selector)) ?? '');
        drafts.current.delete(draftKey(page, message.element.selector));
        setAskError(null);
        setThread(null);
        break;
      case 'changed': {
        const now = Date.now();
        if (now - reloadedAt.current < RELOAD_MS) break;
        reloadedAt.current = now;
        setChangedAt(now);
        siteChanged(block.id);
        setLoad((was) => ({ page, n: was.n + 1, scrollY: message.scrollY }));
        break;
      }
    }
  };
  useFrameMessages(frame, address?.origin, onMessage);

  // What the frame is told as things change here.
  useEffect(() => {
    if (ready.current) tell(frame.current, siteOrigin, { type: 'mode', edit: editing });
    if (!editing) closeAsk();
  }, [editing]);
  useEffect(() => {
    if (ready.current) tell(frame.current, siteOrigin, { type: 'pins', pins: JSON.parse(targetKey) });
  }, [targetKey]);
  useEffect(() => {
    if (!changedAt) return;
    const timer = setTimeout(() => setChangedAt(null), 2400);
    return () => clearTimeout(timer);
  }, [changedAt]);

  // Closing the prompt keeps what was typed in it for its element, on its
  // page, for when it is picked again.
  const asking = useRef({ chosen, askText, page });
  asking.current = { chosen, askText, page };
  const closeAsk = useCallback(() => {
    const { chosen: was, askText: typed, page: on } = asking.current;
    if (was && typed.trim()) drafts.current.set(draftKey(on, was.selector), typed);
    setChosen(null);
    setAskText('');
    tell(frame.current, siteOrigin, { type: 'choose', selector: null });
  }, [siteOrigin]);

  // Escape closes the prompt, then a thread, then the view (once a panel of
  // the shell, the agent picker or a list of the row under the page, is closed).
  useEscapeSteps(
    Boolean(chosen || thread),
    () => {
      if (asking.current.chosen) closeAsk();
      else if (threadNow.current) setThread(null);
      else return false;
      return true;
    },
    onClose,
  );

  const reload = () => {
    ready.current = false;
    setLoad((now) => ({ page, n: now.n + 1, scrollY: 0 }));
  };
  const goTo = (pin: Pin) => {
    if (pin.anchor.kind !== 'site') return;
    setThread(pin.id);
    setThreadBy('part');
    seeItem(pin.id);
    opened.current = pin.id;
    ready.current = false;
    setLoad((now) => ({ page: (pin.anchor as { page: string }).page, n: now.n + 1, scrollY: 0 }));
  };
  // From its chip on its element, or from the row under the page (`by`).
  const toggleThread = (id: string, by: 'part' | 'strip' = 'part') => {
    setThread((open) => (open === id ? null : id));
    setThreadBy(by);
    setChosen(null);
    seeItem(id);
  };
  // A request in the session's list: its thread opens on its element, on its page.
  const openRequest = (pin: Pin) => {
    if (pin.anchor.kind !== 'site') return;
    if (pin.anchor.page !== page) return goTo(pin);
    setThread(pin.id);
    setThreadBy('part');
    setChosen(null);
    seeItem(pin.id);
    reveal(pin.id);
  };

  // A note on the element picked, or a request to change it: to the agent
  // paired with, or for agents.
  const submitAsk = async (ask: boolean) => {
    if (!chosen || !askText.trim() || askBusy) return;
    setAskBusy(true);
    setAskError(null);
    try {
      const { selector, tag, text, file, line } = chosen;
      const body = ask ? pairing.address(askText) : askText;
      const { pin } = await api.pinComment(block.id, name, { part: { kind: 'site', page, selector, tag, text, file, line }, body, ask });
      drafts.current.delete(draftKey(page, selector));
      setJustPinned(pin);
      setThread(pin.id);
      setThreadBy('part');
      setChosen(null);
      setAskText('');
      tell(frame.current, siteOrigin, { type: 'choose', selector: null });
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setAskBusy(false);
    }
  };

  const heading = block.title || title || siteName(block);
  const open = sitePins.find((p) => p.id === thread);
  const isLost = (p: Pin) => lost.includes(p.id) || Boolean((p.anchor as { gone?: true }).gone);
  const lostHere = here.filter(isLost);
  const src = address && pageAddress(address, load.page);

  // Under a request on a thread opened here: what the agent is doing about it.
  const live = (pin: Pin) => (note: ReactNode) => <PinLine pin={pin} fallback={note} />;

  // Threads not drawn on an element, in one row under the page (strip.tsx):
  // lost from this page, on another page, and, folded under Done, those
  // resolved here. Opening one on another page goes there; one resolved here
  // opens on its element.
  const strip: StripPin[] = [
    ...lostHere.map((pin) => ({ pin, part: clip(pin.quote, 30), lost: 'not found on this page' })),
    ...elsewhere.map((pin) => ({ pin, part: clip(`${pageWords((pin.anchor as { page: string }).page)} · ${pin.quote}`, 36) })),
    ...here.filter((pin) => !isLost(pin) && pin.discussion?.resolved).map((pin) => ({ pin, part: clip(pin.quote, 30) })),
  ];
  const openFromStrip = (pin: Pin, from: 'row' | 'list') => {
    if (pin.anchor.kind !== 'site') return;
    if (pin.anchor.page !== page) return goTo(pin);
    if (isLost(pin)) {
      if (from === 'row') return toggleThread(pin.id, 'strip');
      setThread(pin.id);
      setThreadBy('strip');
    } else {
      setThread(pin.id);
      setThreadBy('part');
      reveal(pin.id);
    }
    setChosen(null);
    seeItem(pin.id);
  };

  // The popover: the prompt by the element picked, or the thread open, by its
  // element or by its chip under the page. Where the frame says they are is
  // read as they move.
  const placing = useRef({ rects, chosenRect, phone });
  placing.current = { rects, chosenRect, phone };
  const within = () => bodyOf(view.current);
  let popover: ReactNode = null;
  if (chosen) {
    popover = (
      <PinPopover
        key="ask"
        from={view}
        at={() => elementAt(screen.current, placing.current.chosenRect, placing.current.phone)}
        within={within}
        opens="under"
        giveBack={() => focusBack(screen.current, foot.current, null, false)}
      >
        <PairAskPrompt
          key={chosen.selector}
          quote={elementQuote(chosen.tag, chosen.text, chosen.selector)}
          label="Ask about this part of the page"
          text={askText}
          busy={askBusy}
          error={askError}
          agent={pairing.agent}
          does={`changes the site's ${chosen.file ? `file (${chosen.file}${chosen.line ? `, line ${chosen.line}` : ''})` : 'files'}`}
          example="make this shorter, say"
          hint={pairing.requests.length === 0}
          onText={(text) => {
            setAskText(text);
            setAskError(null);
          }}
          onSubmit={(ask) => void submitAsk(ask)}
          onClose={closeAsk}
        />
      </PinPopover>
    );
  } else if (open) {
    const id = open.id;
    const byPart = threadBy === 'part' && open.anchor.kind === 'site' && open.anchor.page === page && !isLost(open);
    popover = (
      <PinPopover
        key={`thread ${id}`}
        from={view}
        at={() => (byPart ? elementAt(screen.current, placing.current.rects[id], placing.current.phone) : chipAt(stripAnchor(foot.current, id)))}
        within={within}
        opens={byPart ? 'under' : 'over'}
        takeFocus
        giveBack={() => focusBack(screen.current, foot.current, id, !byPart)}
      >
        <PinThread pin={open} block={block} name={name} onClose={() => setThread(null)} live={live(open)} address={pairing.address} />
      </PinPopover>
    );
  }

  let body;
  if (error) {
    body = (
      <div className="site-view-state" role="status">
        <p>{error}</p>
      </div>
    );
  } else if (blocked) {
    body = (
      <div className="site-view-state" role="status">
        <p>Tricot started showing websites after this page opened. Load the page again to show this one.</p>
        <button className="btn btn-small" onClick={() => location.reload()}>
          Load again
        </button>
      </div>
    );
  } else if (!address || !src) {
    body = (
      <div className="site-view-state" role="status">
        <span className="connector-spinner" aria-hidden />
        Opening the website…
      </div>
    );
  } else {
    body = (
      <div className={`site-view-stage${phone ? ' is-phone' : ''}`}>
        <div className="site-view-screen" ref={screen} style={phone ? { width: PHONE_WIDTH } : undefined}>
          <iframe
            key={`${load.page}:${load.n}`}
            ref={frame}
            name="tricot-site"
            src={src}
            title={heading}
            sandbox={SANDBOX}
            referrerPolicy="strict-origin-when-cross-origin"
            onLoad={() => {
              // A page with no frame script (a file that isn't HTML) says nothing: it is still shown.
              if (!ready.current) setRects({});
            }}
          />
          <div className="site-view-marks" aria-hidden={false}>
            {here.map((pin) => {
              const rect = rects[pin.id];
              if (!rect || (pin.discussion?.resolved && pin.id !== thread)) return null;
              const opened = pin.id === thread;
              return (
                <div key={pin.id}>
                  <span
                    className={`site-pin-mark${opened ? ' is-open' : ''}`}
                    style={{ left: rect.x - 3, top: rect.y - 3, width: rect.w + 6, height: rect.h + 6 }}
                  />
                  <span className="site-pin" style={{ left: Math.min(rect.x + rect.w, size.w - 8), top: Math.max(rect.y, 12) }}>
                    <PairPinChip pin={pin} open={opened} noun="this element" onToggle={() => toggleThread(pin.id)} />
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  const who = pairing.agent;
  const choice = pairing.agents.find((a) => a.name === who);

  return (
    <PairingShell
      pairing={pairing}
      className="site-view"
      label={`Website ${heading}`}
      icon={<Icon name="globe" />}
      title={heading}
      from={`${pageWords(page)} · ${block.folder ? `folder ${siteName({ ...block, title: undefined })}` : siteSourceWords(block)}`}
      fromTitle={block.folder ?? block.url}
      browse={{ label: 'Browse', hint: 'Scroll, click and move between pages' }}
      pairHint="Pick any part of the page to ask the agent to change it, or to leave a note on it."
      pairBand={`${
        who ? `Pairing with ${who}: click any part of the page to ask for a change, or to leave a note.` : 'Click any part of the page to leave a note on it or ask an agent to change it.'
      } Links don't open; Browse moves around.${who ? ` ${reachWords(choice, who)}` : ''}`}
      band={
        changedAt && (
          <div className="pair-band is-changed" role="status">
            The site's files changed: reloaded where you were.
          </div>
        )
      }
      controls={
        <>
          <div className="pair-segments" role="group" aria-label="Width">
            <button className={!phone ? 'is-on' : ''} aria-pressed={!phone} onClick={() => setPhone(false)} aria-label="Desktop width" title="Desktop width">
              <Icon name="desktop" />
            </button>
            <button className={phone ? 'is-on' : ''} aria-pressed={phone} onClick={() => setPhone(true)} aria-label="Phone width" title={`Phone width (${PHONE_WIDTH}px)`}>
              <Icon name="phone" />
            </button>
          </div>
          <button className="btn btn-small btn-quiet" onClick={reload} aria-label="Reload" title="Reload the page">
            <Icon name="sync" />
          </button>
          {address && (
            <a className="btn btn-small" href={pageAddress(address, page)} target="_blank" rel="noreferrer">
              Open in a tab
              <Icon name="external" />
            </a>
          )}
        </>
      }
      open={thread}
      onOpenRequest={openRequest}
      onClose={onClose}
    >
      <div className="site-view-body" ref={view}>
        {body}
      </div>
      {strip.length > 0 && (
        <footer className="piece-apart" ref={foot}>
          <PinStrip pins={strip} open={thread} noun="this element" onOpen={openFromStrip} />
        </footer>
      )}
      {popover}
    </PairingShell>
  );
}
