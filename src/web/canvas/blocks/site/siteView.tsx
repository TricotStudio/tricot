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
import { siteName, siteSourceWords } from '../../../../core/blocks/site/site';
import type { Block, Pin } from '../../../../core/types';
import { api } from '../../../shared/api';
import { Icon } from '../../../shared/components';
import { useCanvas } from '../../context';
import { PinLine } from '../../pairing/pinLine';
import { usePairing } from '../../pairing/session';
import { PairingShell, panelOpen, reachWords } from '../../pairing/shell';
import { PinThread } from '../../pins';
import type { OverlayProps } from '../kind';
import { ApartStrip } from './apart';
import { SANDBOX, pageAddress, pinsOnPage, siteChanged, tell, useFrameMessages, useSiteAddress } from './frame';
import { SiteAskPrompt, SitePinChip } from './pins';

type SiteBlock = Extract<Block, { type: 'site' }>;

const PHONE_WIDTH = 390;
const THREAD_WIDTH = 340;
const PROMPT_HEIGHT = 230;
// What the frame says is believed only so far: its page runs the site's own
// scripts too, which could say the same things.
const READY_LIMIT = { count: 12, ms: 5000 }; // pages shown, at most, so fast
const SAVE_MS = 1500; // the page and title shown are kept on the block once they settle
const RELOAD_MS = 1500; // a change to the files reloads the page at most so often
const REVEAL_MS = 3000; // an element asked into view is asked again, as its page is laid out, for so long

const pageWords = (page: string) => (page === '/' ? 'Home page' : page);

// Where a prompt or a thread goes by an element: under it, or above it when
// there's no room under; beside a phone's screen, which is too narrow for it.
function placeBy(rect: Rect, screen: { w: number; h: number }, phone: boolean, height: number) {
  if (phone) return { left: screen.w + 16, top: Math.max(8, Math.min(rect.y, screen.h - height - 8)), above: false };
  const left = Math.max(12, Math.min(rect.x, screen.w - THREAD_WIDTH - 12));
  const below = rect.y + rect.h + 10;
  const above = below + height > screen.h && rect.y - 10 > height;
  return { left, top: above ? rect.y - 10 : Math.min(below, Math.max(12, screen.h - 60)), above };
}

export function SiteView({ block, name, pinId, pinAsked, onClose }: OverlayProps<SiteBlock>) {
  const canvas = useCanvas();
  const { seeItem, readOnly } = canvas;
  const { address, error, blocked } = useSiteAddress(block.id);
  const siteOrigin = address?.origin;
  const frame = useRef<HTMLIFrameElement>(null);
  const screen = useRef<HTMLDivElement>(null);

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
  const [thread, setThread] = useState<string | null>(pinId ?? null);
  const [justPinned, setJustPinned] = useState<Pin | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [changedAt, setChangedAt] = useState<number | null>(null);
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
  const elsewhere = useMemo(() => sitePins.filter((p) => p.anchor.kind === 'site' && p.anchor.page !== page && (!p.discussion?.resolved || p.id === thread)), [sitePins, page, thread]);
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
    if (!editing) {
      setChosen(null);
      setAskText('');
      tell(frame.current, siteOrigin, { type: 'choose', selector: null });
    }
  }, [editing]);
  useEffect(() => {
    if (ready.current) tell(frame.current, siteOrigin, { type: 'pins', pins: JSON.parse(targetKey) });
  }, [targetKey]);
  useEffect(() => {
    if (!changedAt) return;
    const timer = setTimeout(() => setChangedAt(null), 2400);
    return () => clearTimeout(timer);
  }, [changedAt]);

  // Closing the prompt drops what was typed in it: a draft belongs to the element it was about.
  const closeAsk = useCallback(() => {
    setChosen(null);
    setAskText('');
    tell(frame.current, siteOrigin, { type: 'choose', selector: null });
  }, [siteOrigin]);

  // Escape closes the prompt, then a thread, then the view (once the agent picker is closed).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || panelOpen()) return;
      if (chosen) closeAsk();
      else if (thread) setThread(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chosen, thread, onClose, closeAsk]);

  const reload = () => {
    ready.current = false;
    setLoad((now) => ({ page, n: now.n + 1, scrollY: 0 }));
  };
  const goTo = (pin: Pin) => {
    if (pin.anchor.kind !== 'site') return;
    setThread(pin.id);
    seeItem(pin.id);
    opened.current = pin.id;
    ready.current = false;
    setLoad((now) => ({ page: (pin.anchor as { page: string }).page, n: now.n + 1, scrollY: 0 }));
  };
  const toggleThread = (id: string) => {
    setThread((open) => (open === id ? null : id));
    setChosen(null);
    seeItem(id);
  };
  // A request in the session's list: its thread opens on its element, on its page.
  const openRequest = (pin: Pin) => {
    if (pin.anchor.kind !== 'site') return;
    if (pin.anchor.page !== page) return goTo(pin);
    setThread(pin.id);
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
      setJustPinned(pin);
      setThread(pin.id);
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
  const openRect = open && open.anchor.kind === 'site' && open.anchor.page === page ? rects[open.id] : null;
  const lostHere = here.filter((p) => (lost.includes(p.id) || (p.anchor as { gone?: true }).gone) && (!p.discussion?.resolved || p.id === thread));
  const promptAt = chosen && chosenRect && placeBy(chosenRect, size, phone, PROMPT_HEIGHT);
  const threadAt = open && openRect ? placeBy(openRect, size, phone, 260) : null;
  const src = address && pageAddress(address, load.page);

  // Under a request on a thread opened here: what the agent is doing about it.
  const live = (pin: Pin) => (note: ReactNode) => <PinLine pin={pin} fallback={note} />;

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
                    <SitePinChip pin={pin} open={opened} onToggle={() => toggleThread(pin.id)} />
                  </span>
                </div>
              );
            })}
            {open && threadAt && (
              <PinThread
                key={open.id}
                pin={open}
                block={block}
                name={name}
                above={threadAt.above}
                style={{ left: threadAt.left, top: threadAt.top, width: THREAD_WIDTH }}
                onClose={() => setThread(null)}
                live={live(open)}
                address={pairing.address}
              />
            )}
            {chosen && promptAt && (
              <SiteAskPrompt
                key={chosen.selector}
                element={chosen}
                style={{ left: promptAt.left, top: promptAt.top, width: THREAD_WIDTH }}
                above={promptAt.above}
                text={askText}
                busy={askBusy}
                error={askError}
                agent={pairing.agent}
                onText={(text) => {
                  setAskText(text);
                  setAskError(null);
                }}
                onSubmit={(ask) => void submitAsk(ask)}
                onClose={closeAsk}
              />
            )}
          </div>
        </div>
      </div>
    );
  }

  // Threads not drawn on an element: lost from this page, or on another page,
  // in one row under the page (apart.tsx), with what doesn't fit under More.
  const apart = [...lostHere, ...elsewhere];
  const apartOpen = open && apart.includes(open) ? open : undefined;

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
      pairBand={
        <>
          {who ? `Pairing with ${who}: click any part of the page to ask ${who} to change it, or to leave a note.` : 'Click any part of the page to leave a note on it or ask an agent to change it.'}{' '}
          Links don't open; switch to Browse to move around.{who ? ` ${reachWords(choice, who)}` : ''}
        </>
      }
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
      <div className="site-view-body">{body}</div>
      {apart.length > 0 && (
        <footer className="site-view-apart">
          <ApartStrip
            open={thread}
            groups={[
              { label: 'No longer on this page', pins: lostHere.map((pin) => ({ pin, part: pin.quote, lost: 'not found', onToggle: () => toggleThread(pin.id) })) },
              {
                label: 'On other pages',
                pins: elsewhere.map((pin) => ({ pin, part: `${pageWords((pin.anchor as { page: string }).page)} · ${pin.quote}`, onToggle: () => goTo(pin) })),
              },
            ].filter((group) => group.pins.length > 0)}
          />
          {apartOpen && (
            <div className="site-view-apart-thread">
              <PinThread key={apartOpen.id} inline pin={apartOpen} block={block} name={name} onClose={() => setThread(null)} live={live(apartOpen)} address={pairing.address} />
            </div>
          )}
        </footer>
      )}
    </PairingShell>
  );
}
