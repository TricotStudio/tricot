import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { draftAuthors, draftRows, listNumbers, STYLE_LABEL, type DocChange, type DraftRow } from '../../../core/connectors/google/doc';
import { findQuote, quoteAt } from '../../../core/pins';
import { linkSource } from '../../../core/sources';
import type { Actor, Block, DocConflict, DocDraft, Pin, PinAnchor } from '../../../core/types';
import { api, type RequestError } from '../../api';
import { SourceIcon } from '../../canvas/sources/icon';
import { useCanvas } from '../../canvas/context';
import { PinLine } from '../../canvas/pairing/pinLine';
import { usePairing } from '../../canvas/pairing/session';
import { PairingShell, panelOpen, reachWords } from '../../canvas/pairing/shell';
import { DRAFT, MarkedText, PinThread, type TextMark } from '../../canvas/pins';
import { ActorBadge, Icon, timeAgo } from '../../components';
import { onConnectorMessage, useLinkFile } from '../live';
import { googleApi, type DocView, type DocWords } from './api';
import { chooseGoogleDocs } from './choose';
import { DocAskPrompt, DocPinChip } from './docPins';
import './docEditor.css';

// A Google Doc's draft, edited over the canvas (#34: save only what changed).
// The doc comes through the server, which holds the Google sign-in; the draft
// lives on the link block, so agents' edits show up here as they make them.
// Each paragraph is plain text in its own box, styled as the doc styles it;
// what the draft changes is marked with who changed it. Saving sends Google
// only those paragraphs, and stops (showing both versions) if the doc changed
// in Google meanwhile. Selecting words in a paragraph opens the canvas's pin
// prompt, to ask an agent to edit it (or only comment): the thread is pinned
// to the paragraph, marked by it, and opens under it. It is shown in the
// pairing shell (canvas/pairing): Read, on your own, or paired with an agent,
// whom requests then go straight to, with its steps on the pin as it works.

type LinkBlock = Extract<Block, { type: 'link' }>;
type DocAnchor = Extract<PinAnchor, { kind: 'doc' }>;

const NOTED = 'tricot:docs-save-noted'; // this browser has seen what saving does to formatting
const COMMIT_MS = 700;
const PROMPT_HEIGHT = 240; // about: whether the prompt fits under the words

function readFlag(): boolean {
  try {
    return localStorage.getItem(NOTED) === '1';
  } catch {
    return false;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// A textarea as tall as its text. `paragraph` is the id of the paragraph it edits.
function AutoText(props: {
  value: string;
  className: string;
  paragraph: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onMouseDown: (e: MouseEvent<HTMLTextAreaElement>) => void;
  inputRef: (el: HTMLTextAreaElement | null) => void;
  label: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [props.value]);
  return (
    <textarea
      ref={(el) => {
        ref.current = el;
        props.inputRef(el);
      }}
      rows={1}
      className={props.className}
      value={props.value}
      aria-label={props.label}
      data-paragraph={props.paragraph}
      spellCheck
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={props.onBlur}
      onKeyDown={props.onKeyDown}
      onMouseDown={props.onMouseDown}
    />
  );
}

function Who({ actor, me }: { actor: Actor; me: string }) {
  const you = actor.kind === 'human' && actor.name.trim().toLowerCase() === me.trim().toLowerCase();
  if (!you) return <ActorBadge actor={actor} />;
  // Their own mark and colour, named "You".
  return (
    <span className="actor actor-human" title={`${actor.name} (you)`}>
      <ActorBadge actor={actor} showName={false} title={`${actor.name} (you)`} />
      <span className="actor-name">You</span>
    </span>
  );
}

type Problem = { message: string; code?: string };

// `pinId` opens the editor at a thread on one of its paragraphs.
export function DocEditor({ block, name, pinId, onClose }: { block: LinkBlock; name: string; pinId?: string; onClose: () => void }) {
  const [view, setView] = useState<DocView | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  // Signing in on Google's tab; blocked: the browser kept the tab from opening, so the person opens it from here.
  const [waiting, setWaiting] = useState<{ url?: string; blocked?: boolean } | null>(null);
  const [optimistic, setOptimistic] = useState<{ draft: DocDraft | undefined; from: DocDraft | undefined } | null>(null);
  const [local, setLocal] = useState<Map<string, string>>(new Map()); // typed, not yet in the draft
  const [busy, setBusy] = useState<'save' | 'discard' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false); // Google's Picker is open
  const [saved, setSaved] = useState<{ paragraphs: number; at: string } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [noted, setNoted] = useState(readFlag);
  const boxes = useRef(new Map<string, HTMLTextAreaElement>());
  const focusNext = useRef<{ id: string; at: 'start' | 'end' } | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const localRef = useRef(local);
  localRef.current = local;
  // Asking about selected words: the prompt's words, what's typed in it, and
  // where it's drawn on the page. One thread opens at a time, under its paragraph.
  const canvas = useCanvas();
  const { seeItem } = canvas;
  const [asking, setAsking] = useState<DocWords | null>(null);
  const [askText, setAskText] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [promptAt, setPromptAt] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null);
  const [thread, setThread] = useState<string | null>(pinId ?? null);
  const [justPinned, setJustPinned] = useState<Pin | null>(null); // shown until the board has it
  const page = useRef<HTMLDivElement>(null);
  const selecting = useRef<HTMLTextAreaElement | null>(null);
  const pairing = usePairing(block, name, 'doc');
  const pairedWith = pairing.mode === 'pair' ? pairing.agent : null;

  const drive = useLinkFile(useMemo(() => linkSource(block.url), [block.url]));
  const title = block.title || view?.doc.title || drive?.name || 'Google Doc';
  // The draft as the board has it, or as the last change returned it until the board catches up.
  const draft = optimistic && optimistic.from === block.docDraft ? optimistic.draft : block.docDraft;

  const load = useCallback(async () => {
    try {
      const next = await googleApi.googleDoc(block.id, name);
      setView(next);
      setProblem(null);
      return true;
    } catch (e) {
      const err = e as RequestError;
      setProblem({ message: err.message, code: err.code });
      return false;
    }
  }, [block.id, name]);

  useEffect(() => {
    void load();
  }, [load]);

  // The draft moved onto a newer version of the doc (after a save stopped):
  // paragraph ids follow that version, so the doc is read again.
  const revision = block.docDraft?.revision;
  useEffect(() => {
    if (view && revision && revision !== view.doc.revision) void load();
  }, [revision, view, load]);

  // Signing in on Google's tab: done when the doc opens.
  useEffect(() => {
    if (!waiting) return;
    const stop = onConnectorMessage((message) => {
      if (message.id !== 'google') return;
      if (message.ok) void load().then((ok) => ok && setWaiting(null));
      else {
        setWaiting(null);
        setError(message.message ?? 'The sign-in failed.');
      }
    });
    const timer = setInterval(() => void load().then((ok) => ok && setWaiting(null)), 2500);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [waiting, load]);

  // Escape closes the prompt, then an open thread, then the editor (once the agent picker is closed).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || panelOpen()) return;
      if (asking) setAsking(null);
      else if (thread) setThread(null);
      else if (!confirmDiscard) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, confirmDiscard, asking, thread]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(timer);
  }, [error]);

  const rows = useMemo(() => (view ? draftRows(view.doc.paragraphs, draft) : []), [view, draft]);
  const numbers = useMemo(() => listNumbers(rows), [rows]);

  // Threads on the doc's paragraphs, by the paragraph they're on in the
  // version shown. One whose paragraph is gone goes in a strip at the end;
  // one on another version waits for the board to follow it onto this one.
  const boardPins = canvas.pins.get(block.id);
  const docPins = useMemo(() => {
    const pins = (boardPins ?? []).filter((p) => p.anchor.kind === 'doc' && p.discussion);
    return justPinned && !pins.some((p) => p.id === justPinned.id) ? [...pins, justPinned] : pins;
  }, [boardPins, justPinned]);
  useEffect(() => {
    if (justPinned && boardPins?.some((p) => p.id === justPinned.id)) setJustPinned(null);
  }, [boardPins, justPinned]);
  const { byRow, gone } = useMemo(() => {
    const byRow = new Map<string, Pin[]>();
    const gone: Pin[] = [];
    if (!view) return { byRow, gone };
    const ids = new Set(rows.map((r) => r.id));
    for (const pin of docPins) {
      const anchor = pin.anchor as DocAnchor;
      if (anchor.gone || (anchor.revision === view.doc.revision && !ids.has(anchor.paragraph))) {
        if (!pin.discussion?.resolved || pin.id === thread) gone.push(pin);
      } else if (anchor.revision === view.doc.revision) byRow.set(anchor.paragraph, [...(byRow.get(anchor.paragraph) ?? []), pin]);
    }
    return { byRow, gone };
  }, [docPins, rows, view, thread]);

  const toggleThread = (id: string) => {
    setThread((open) => (open === id ? null : id));
    seeItem(id);
  };
  // A request in the session's list: its thread opens under its paragraph, in view.
  const openRequest = (pin: Pin) => {
    setThread(pin.id);
    seeItem(pin.id);
    requestAnimationFrame(() => {
      const chip = page.current?.querySelector(`[data-doc-chip="${CSS.escape(pin.id)}"]`);
      (chip?.closest('.doc-row, .doc-gone') ?? chip)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };
  // Under a request on a thread opened here: what the agent is doing about it.
  const live = (pin: Pin) => (note: ReactNode) => <PinLine pin={pin} fallback={note} />;

  // Opened at a thread (or sent to one while open): it comes into view once the doc is drawn.
  const shown = useRef(false);
  useEffect(() => {
    if (!pinId) return;
    setThread(pinId);
    shown.current = false;
  }, [pinId]);
  useEffect(() => {
    if (!pinId || shown.current || !view) return;
    const chip = page.current?.querySelector(`[data-doc-chip="${CSS.escape(pinId)}"]`);
    if (!chip) return;
    shown.current = true;
    (chip.closest('.doc-row, .doc-gone') ?? chip).scrollIntoView({ block: 'start' });
    seeItem(pinId);
  });

  // Words selected with the mouse in a paragraph open the prompt for them.
  // The selection stays in the paragraph: typing over it edits the doc.
  useEffect(() => {
    if (!view) return;
    const onUp = (e: globalThis.MouseEvent) => {
      const box = selecting.current;
      selecting.current = null;
      if (!box || e.button !== 0) return;
      setTimeout(() => {
        const paragraph = box.dataset.paragraph;
        const { selectionStart: start, selectionEnd: end, value } = box;
        const words = paragraph && end > start ? quoteAt(value, start, end) : null;
        if (!words) return;
        setAsking({ paragraph: paragraph!, revision: view.doc.revision, ...words });
        setAskError(null);
      }, 0);
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, [view]);

  // The prompt goes under the words, on the page (above them near the end
  // of the doc, where there's no page under them), and comes into view.
  useLayoutEffect(() => {
    if (!asking) return setPromptAt(null);
    const root = page.current;
    const row = root?.querySelector(`[data-row="${CSS.escape(asking.paragraph)}"]`);
    const rects = [...(row?.querySelectorAll('[data-pin-draft]') ?? [])].flatMap((m) => [...m.getClientRects()]);
    if (!root || rects.length === 0) return; // the words changed: it stays where it was
    const frame = root.getBoundingClientRect();
    const width = Math.min(380, frame.width - 24);
    const left = Math.max(12, Math.min(rects[0].left - frame.left - 12, frame.width - width - 12));
    const below = rects.at(-1)!.bottom - frame.top + 8;
    const above = below + PROMPT_HEIGHT > frame.height && rects[0].top - frame.top > PROMPT_HEIGHT;
    setPromptAt({ left, width, above, top: above ? rects[0].top - frame.top - 8 : below });
  }, [asking, rows, local]);
  useEffect(() => {
    if (promptAt) page.current?.querySelector('.doc-ask')?.scrollIntoView({ block: 'nearest' });
  }, [promptAt]);
  const closeAsk = useCallback(() => setAsking(null), []);

  const marksOf = (row: DraftRow, text: string): TextMark[] => {
    const marks: TextMark[] = [];
    for (const pin of byRow.get(row.id) ?? []) {
      if (pin.discussion?.resolved && pin.id !== thread) continue;
      const at = findQuote(text, pin.quote, pin.anchor as DocAnchor);
      if (at) marks.push({ id: pin.id, ...at });
    }
    const at = asking?.paragraph === row.id ? findQuote(text, asking.quote, asking) : null;
    if (at) marks.push({ id: DRAFT, ...at });
    return marks;
  };
  const authors = useMemo(() => draftAuthors(draft), [draft]);
  const changed = draft?.edits.length ?? 0;
  const conflicts = draft?.conflicts ?? [];

  useLayoutEffect(() => {
    const want = focusNext.current;
    const box = want && boxes.current.get(want.id);
    if (!want || !box) return;
    focusNext.current = null;
    box.focus();
    const at = want.at === 'start' ? 0 : box.value.length;
    box.setSelectionRange(at, at);
  });

  // Changes go to the server one after another, so they land in order.
  const send = useCallback(
    (changes: DocChange[]) => {
      if (!view) return Promise.resolve(undefined);
      const run = queue.current.then(async () => {
        const from = block.docDraft;
        try {
          const result = await googleApi.editDocDraft(block.id, name, view.doc.revision, changes);
          setOptimistic({ draft: result.draft, from });
          setSaved(null);
          return result;
        } catch (e) {
          const err = e as RequestError;
          setError(err.message);
          if (err.status === 409) void load();
          return undefined;
        }
      });
      queue.current = run;
      return run;
    },
    [view, block.id, block.docDraft, name, load],
  );

  const commit = useCallback(
    (id: string) => {
      clearTimeout(timers.current.get(id));
      timers.current.delete(id);
      const text = localRef.current.get(id);
      if (text === undefined) return Promise.resolve();
      return send([{ kind: 'text', id, text }]).then((result) => {
        if (!result) return;
        setLocal((current) => {
          if (current.get(id) !== text) return current;
          const next = new Map(current);
          next.delete(id);
          return next;
        });
      });
    },
    [send],
  );

  const flush = () => Promise.all([...localRef.current.keys()].map((id) => commit(id)));

  const type = (id: string, text: string) => {
    if (asking?.paragraph === id && !askText.trim()) setAsking(null); // typing over the words
    setLocal((current) => new Map(current).set(id, text));
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => void commit(id), COMMIT_MS));
  };

  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  // Enter splits a paragraph, Shift+Enter breaks a line inside it, and
  // Backspace in an empty one removes it.
  const onKeyDown = (row: DraftRow, index: number) => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const box = e.currentTarget;
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const text = box.value;
      const caret = box.selectionStart ?? text.length;
      const head = text.slice(0, caret);
      const tail = text.slice(box.selectionEnd ?? caret);
      clearTimeout(timers.current.get(row.id));
      timers.current.delete(row.id);
      setLocal((current) => {
        const next = new Map(current);
        next.delete(row.id);
        return next;
      });
      const changes: DocChange[] = [];
      if (head !== row.text || localRef.current.has(row.id)) changes.push({ kind: 'text', id: row.id, text: head });
      changes.push({ kind: 'add', after: row.id, text: tail, list: row.list ? (row.list.ordered ? 'numbered' : 'bullet') : null });
      void send(changes).then((result) => {
        const added = result?.added[0];
        if (added) focusNext.current = { id: added, at: 'start' };
      });
    } else if (e.key === 'Backspace' && box.value === '' && box.selectionStart === 0) {
      e.preventDefault();
      const before = rows.slice(0, index).findLast((r) => r.state !== 'removed' && !r.locked);
      if (before) focusNext.current = { id: before.id, at: 'end' };
      void send([{ kind: 'delete', id: row.id }]);
    }
  };

  const allow = async () => {
    const tab = window.open('', '_blank');
    setError(null);
    setWaiting({});
    try {
      const { url } = await api.startConnector('google');
      if (tab) tab.location.href = url;
      setWaiting({ url, blocked: !tab });
    } catch (e) {
      tab?.close();
      setWaiting(null);
      setError((e as Error).message);
    }
  };

  // The doc Tricot couldn't open: Google's Picker, showing just that doc, to choose it.
  const choose = async () => {
    const fileId = linkSource(block.url)?.fileId;
    setError(null);
    setChoosing(true);
    try {
      const docs = await chooseGoogleDocs({ fileIds: fileId ? [fileId] : undefined, title: `Choose "${title}"` });
      if (docs.length && fileId && !docs.some((d) => d.id === fileId)) setError(`That's another doc. Choose "${title}" to open it here.`);
      else if (docs.length) await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChoosing(false);
    }
  };

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      await flush();
      await queue.current;
      const result = await googleApi.saveDocDraft(block.id, name);
      if (result.outcome === 'saved') {
        setSaved({ paragraphs: result.paragraphs, at: new Date().toISOString() });
        setOptimistic({ draft: undefined, from: block.docDraft });
        try {
          localStorage.setItem(NOTED, '1');
        } catch {
          // Storage unavailable: the note shows again next time.
        }
        setNoted(true);
        await load();
      } else {
        setOptimistic({ draft: result.draft, from: block.docDraft });
        await load();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    setBusy('discard');
    try {
      await googleApi.discardDocDraft(block.id, name);
      setOptimistic({ draft: undefined, from: block.docDraft });
      setLocal(new Map());
      setConfirmDiscard(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Asks agents to edit the paragraph (or only comments), once the words as
  // typed are in the draft. Its thread opens under the paragraph.
  const submitAsk = async (ask: boolean) => {
    if (!asking || !askText.trim() || askBusy) return;
    setAskBusy(true);
    setAskError(null);
    try {
      await commit(asking.paragraph);
      await queue.current;
      const { pin } = await googleApi.pinDocWords(block.id, name, { ...asking, body: ask ? pairing.address(askText) : askText, ask });
      setJustPinned(pin);
      setThread(pin.id);
      setAsking(null);
      setAskText('');
    } catch (e) {
      setAskError((e as Error).message);
    } finally {
      setAskBusy(false);
    }
  };

  const resolve = async (conflict: DocConflict, keep: 'mine' | 'theirs') => {
    try {
      const { draft: next } = await googleApi.resolveDocConflict(block.id, name, conflict.id, keep);
      setOptimistic({ draft: next ?? undefined, from: block.docDraft });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openInGoogle = (
    <a className="btn btn-small" href={block.url} target="_blank" rel="noreferrer">
      Open in Google
      <Icon name="external" />
    </a>
  );

  let body;
  if (problem && !view) {
    body = (
      <AccessPanel
        problem={problem}
        title={title}
        waiting={waiting}
        choosing={choosing}
        error={error}
        onAllow={allow}
        onChoose={() => void choose()}
        onCancelWait={() => setWaiting(null)}
        onRetry={load}
        openInGoogle={openInGoogle}
      />
    );
  } else if (!view) {
    body = (
      <div className="doc-editor-state" role="status">
        <span className="connector-spinner" aria-hidden />
        Opening from Google…
      </div>
    );
  } else if (conflicts.length) {
    body = <ConflictView conflicts={conflicts} draft={draft!} me={name} onResolve={resolve} />;
  } else {
    body = (
      <div className="doc-page" ref={page}>
        {rows.map((row, i) => {
          const text = local.get(row.id) ?? row.text;
          const pins = byRow.get(row.id) ?? [];
          const open = pins.find((p) => p.id === thread);
          return (
            <Row
              key={row.id}
              row={row}
              number={numbers.get(row.id)}
              me={name}
              text={text}
              marks={marksOf(row, text)}
              focus={thread}
              chips={pins.map((pin) => (
                <DocPinChip
                  key={pin.id}
                  pin={pin}
                  open={pin.id === thread}
                  lost={row.state === 'removed' ? 'paragraph removed' : undefined}
                  onToggle={() => toggleThread(pin.id)}
                />
              ))}
              after={open && <PinThread key={open.id} inline pin={open} block={block} name={name} onClose={() => setThread(null)} live={live(open)} address={pairing.address} />}
              onPress={(e) => {
                if (e.button === 0) selecting.current = e.currentTarget;
              }}
              onType={(text) => type(row.id, text)}
              onBlur={() => void commit(row.id)}
              onKeyDown={onKeyDown(row, i)}
              inputRef={(el) => (el ? boxes.current.set(row.id, el) : boxes.current.delete(row.id))}
              onRemove={() => void send([{ kind: 'delete', id: row.id }])}
              onRestore={() => {
                setLocal((current) => {
                  const next = new Map(current);
                  next.delete(row.id);
                  return next;
                });
                void send([{ kind: 'restore', id: row.id }]);
              }}
              onFormat={(style, list) => void send([{ kind: 'format', id: row.id, style, list }])}
            />
          );
        })}
        {gone.length > 0 && (
          <div className="doc-gone">
            <div className="doc-gone-chips">
              <span className="faint small">No longer in the doc</span>
              {gone.map((pin) => (
                <DocPinChip
                  key={pin.id}
                  pin={pin}
                  open={pin.id === thread}
                  part={`“${pin.quote.length > 40 ? `${pin.quote.slice(0, 39)}…` : pin.quote}”`}
                  lost="paragraph removed"
                  onToggle={() => toggleThread(pin.id)}
                />
              ))}
            </div>
            {gone.some((p) => p.id === thread) && (
              <PinThread
                key={thread}
                inline
                pin={gone.find((p) => p.id === thread)!}
                block={block}
                name={name}
                onClose={() => setThread(null)}
                live={live(gone.find((p) => p.id === thread)!)}
                address={pairing.address}
              />
            )}
          </div>
        )}
        <button
          className="doc-add"
          onClick={() => {
            const last = rows.findLast((r) => r.state !== 'removed');
            void send([{ kind: 'add', after: last?.id ?? '', text: '' }]).then((result) => {
              if (result?.added[0]) focusNext.current = { id: result.added[0], at: 'start' };
            });
          }}
        >
          <Icon name="plus" /> Add a paragraph
        </button>
        {asking && promptAt && (
          <DocAskPrompt
            key={`${asking.paragraph}:${asking.quote}`}
            words={asking}
            style={{ left: promptAt.left, top: promptAt.top, width: promptAt.width }}
            above={promptAt.above}
            text={askText}
            busy={askBusy}
            error={askError}
            agent={pairedWith}
            onText={(text) => {
              setAskText(text);
              setAskError(null);
            }}
            onSubmit={(ask) => void submitAsk(ask)}
            onClose={closeAsk}
          />
        )}
      </div>
    );
  }

  const choice = pairing.agents.find((a) => a.name === pairing.agent);
  return (
    <PairingShell
      pairing={pairing}
      className="doc-editor"
      label={`Edit ${title}`}
      icon={<SourceIcon mark="google-docs" />}
      title={title}
      from={`Google Doc · ${view ? (draft ? `draft in Tricot, from the version of ${timeAgo(view.doc.pulledAt)}` : `as Google has it, ${timeAgo(view.doc.pulledAt)}`) : 'in Tricot'}`}
      browse={{ label: 'Read', hint: 'Read and edit the draft on your own; select words to ask agents or comment' }}
      pairHint="Select words to ask the agent to change them in the draft, or to comment."
      pairBand={
        pairing.agent
          ? `Pairing with ${pairing.agent}: select words to ask ${pairing.agent} to change them; ${pairing.agent} edits the draft and replies on the pin. ${reachWords(choice, pairing.agent)}`
          : 'Select words to ask an agent to change them, or to comment.'
      }
      controls={openInGoogle}
      open={thread}
      onOpenRequest={openRequest}
      onClose={onClose}
      foot={
        <>
          {view && !conflicts.length && (
            <footer className="doc-editor-foot">
              {changed > 0 && !noted && (
                <p className="doc-note">
                  <strong>Saving changes only the paragraphs marked here.</strong> Inside a changed paragraph, formatting can simplify: new words
                  take the style around them, and a link or chip in the changed part goes. Tables, images and comments elsewhere stay as they are.
                </p>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="doc-editor-actions">
                {confirmDiscard ? (
                  <>
                    <span className="small">Discard {plural(changed, 'change')}? Google's doc stays as it is.</span>
                    <button className="btn btn-small" disabled={busy !== null} onClick={discard}>
                      Discard
                    </button>
                    <button className="btn btn-small btn-quiet" onClick={() => setConfirmDiscard(false)}>
                      Keep editing
                    </button>
                  </>
                ) : (
                  <>
                    <span className="faint small doc-editor-hint">Enter adds a paragraph · Shift+Enter breaks a line</span>
                    <button className="btn btn-small btn-quiet" disabled={!changed || busy !== null} onClick={() => setConfirmDiscard(true)}>
                      Discard draft
                    </button>
                    <button className="btn btn-primary" disabled={!changed || busy !== null} onClick={save}>
                      {busy === 'save' ? 'Saving to Google…' : changed ? `Save to Google · ${plural(changed, 'paragraph')} changed` : 'Nothing to save yet'}
                    </button>
                  </>
                )}
              </div>
            </footer>
          )}
          {view && conflicts.length > 0 && error && (
            <footer className="doc-editor-foot">
              <p className="error" role="alert">
                {error}
              </p>
            </footer>
          )}
        </>
      }
      band={
        view &&
        (authors.length > 0 || saved || draft?.rebased) && (
          <div className="doc-editor-band">
            {saved && !changed ? (
              <span className="doc-saved" role="status">
                <Icon name="check" /> Saved {plural(saved.paragraphs, 'paragraph')} to Google · {timeAgo(saved.at)}. The rest of the doc is as it was.
              </span>
            ) : (
              <>
                {authors.length > 0 && (
                  <span className="doc-authors">
                    <span className="faint">Changes in this draft</span>
                    {authors.map((a) => (
                      <span key={`${a.by.kind}:${a.by.name}`} className="doc-author">
                        <Who actor={a.by} me={name} />
                        <span className="doc-author-count">{a.count}</span>
                      </span>
                    ))}
                  </span>
                )}
                {draft?.rebased && !conflicts.length && (
                  <span className="doc-rebased">
                    Moved onto the latest version from Google{draft.rebased.theirs ? ` (${plural(draft.rebased.theirs, 'paragraph')} changed there)` : ''}. Check it, then save again.
                  </span>
                )}
              </>
            )}
          </div>
        )
      }
    >
      <div className="doc-editor-body">{body}</div>
    </PairingShell>
  );
}

// ---- a paragraph ----------------------------------------------------------------

const STYLE_CLASS: Record<string, string> = {
  TITLE: 'is-title',
  SUBTITLE: 'is-subtitle',
  HEADING_1: 'is-h1',
  HEADING_2: 'is-h2',
  HEADING_3: 'is-h3',
  HEADING_4: 'is-h4',
  HEADING_5: 'is-h4',
  HEADING_6: 'is-h4',
};

const NEW_STYLES: { value: string; label: string; style: string; list: 'bullet' | 'numbered' | null }[] = [
  { value: 'text', label: 'Text', style: 'NORMAL_TEXT', list: null },
  { value: 'h1', label: 'Heading 1', style: 'HEADING_1', list: null },
  { value: 'h2', label: 'Heading 2', style: 'HEADING_2', list: null },
  { value: 'h3', label: 'Heading 3', style: 'HEADING_3', list: null },
  { value: 'bullet', label: 'Bulleted', style: 'NORMAL_TEXT', list: 'bullet' },
  { value: 'numbered', label: 'Numbered', style: 'NORMAL_TEXT', list: 'numbered' },
];

// `marks` are words to mark in its text: pinned (blue) or being asked about
// (amber), drawn behind the text box. `chips` mark its threads; `after` is
// what opens under it, a thread.
function Row(props: {
  row: DraftRow;
  number?: number;
  me: string;
  text: string;
  marks: TextMark[];
  focus: string | null;
  chips: ReactNode[];
  after: ReactNode;
  onPress: (e: MouseEvent<HTMLTextAreaElement>) => void;
  onType: (text: string) => void;
  onBlur: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  inputRef: (el: HTMLTextAreaElement | null) => void;
  onRemove: () => void;
  onRestore: () => void;
  onFormat: (style: string, list: 'bullet' | 'numbered' | null) => void;
}) {
  const { row, number, me, text, marks, chips } = props;
  const styleClass = STYLE_CLASS[row.style] ?? '';
  if (row.locked) {
    return (
      <div className="doc-row is-locked">
        <div className="doc-locked">
          <span className="doc-locked-label">
            {row.locked}: edit in Google
          </span>
          {(row.detail || row.text) && <span className="faint small doc-locked-detail">{[row.detail, row.text].filter(Boolean).join(' · ')}</span>}
        </div>
      </div>
    );
  }
  const marker = row.list ? (row.list.ordered ? `${number ?? 1}.` : '•') : null;
  const level = row.list?.level ?? 0;
  const edited = row.state === 'changed' || (row.state === 'same' && text !== row.text);
  const state = row.state === 'same' && edited ? 'changed' : row.state;
  const current = NEW_STYLES.find((s) => s.style === row.style && (s.list ?? undefined) === (row.list ? (row.list.ordered ? 'numbered' : 'bullet') : undefined));
  return (
    <div className={`doc-row is-${state}`} data-row={row.id}>
      <div className="doc-text" style={{ paddingLeft: row.list ? 22 + level * 22 : 0 }}>
        {marker && <span className="doc-list-mark" style={{ left: level * 22 }}>{marker}</span>}
        {row.state === 'removed' ? (
          <p className={`doc-removed ${styleClass}`}>{row.was || ' '}</p>
        ) : (
          <div className="doc-field">
            {marks.length > 0 && (
              <div className={`doc-input doc-marks ${styleClass}`} aria-hidden>
                <MarkedText text={text} marks={marks} focus={props.focus} />
              </div>
            )}
            <AutoText
              className={`doc-input ${styleClass}`}
              value={text}
              paragraph={row.id}
              label={`${STYLE_LABEL[row.style] ?? 'Paragraph'} ${row.id}`}
              onChange={props.onType}
              onBlur={props.onBlur}
              onKeyDown={props.onKeyDown}
              onMouseDown={props.onPress}
              inputRef={props.inputRef}
            />
          </div>
        )}
        {row.state === 'changed' && row.was !== undefined && (
          <p className="doc-was" title="As the doc has it in Google">
            <span className="doc-was-label">In Google:</span> {row.was || '(empty)'}
          </p>
        )}
      </div>
      <div className="doc-meta">
        {chips}
        {state !== 'same' && (
          <span className={`doc-state is-${state}`}>{state === 'changed' ? 'Edited' : state === 'added' ? 'New' : 'Removed'}</span>
        )}
        {row.by && <Who actor={row.by} me={me} />}
        {row.state === 'added' && (
          <select
            className="doc-style"
            value={current?.value ?? 'text'}
            onChange={(e) => {
              const pick = NEW_STYLES.find((s) => s.value === e.target.value)!;
              props.onFormat(pick.style, pick.list);
            }}
            aria-label="Paragraph style"
          >
            {NEW_STYLES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <span className="doc-actions">
          {(row.state === 'changed' || row.state === 'removed') && (
            <button className="btn btn-small btn-quiet" onClick={props.onRestore} title="Back to how the doc has it">
              {row.state === 'removed' ? 'Restore' : 'Undo'}
            </button>
          )}
          {row.state !== 'removed' && (
            <button className="btn btn-small btn-quiet doc-remove" onClick={props.onRemove} title="Remove this paragraph" aria-label="Remove this paragraph">
              <Icon name="x" />
            </button>
          )}
        </span>
      </div>
      {props.after && <div className="doc-row-after">{props.after}</div>}
    </div>
  );
}

// ---- when the doc changed in Google meanwhile ----------------------------------------

function ConflictView(props: { conflicts: DocConflict[]; draft: DocDraft; me: string; onResolve: (c: DocConflict, keep: 'mine' | 'theirs') => void }) {
  const { conflicts, draft, me, onResolve } = props;
  const carried = draft.edits.length;
  return (
    <div className="doc-conflicts">
      <div className="doc-conflict-intro" role="status">
        <h3>Someone edited this doc in Google since the draft began</h3>
        <p>
          Nothing was saved, and nothing was overwritten. {conflicts.length === 1 ? 'One paragraph was' : `${conflicts.length} paragraphs were`} changed on
          both sides: choose which version to keep{conflicts.length === 1 ? '' : ' for each'}. {carried > 0 && `The draft's ${plural(carried, 'other change')} carried over onto the latest version.`}
        </p>
      </div>
      {conflicts.map((c) => (
        <article key={c.id} className="doc-conflict">
          <p className="faint small doc-conflict-was">
            Was: <span>{c.was || '(empty)'}</span>
          </p>
          <div className="doc-conflict-sides">
            <div className="doc-side is-theirs">
              <span className="doc-side-label">In Google now</span>
              <p className={c.theirs === undefined ? 'is-gone' : undefined}>{c.theirs ?? 'Removed in Google'}</p>
              <button className="btn btn-small" onClick={() => onResolve(c, 'theirs')}>
                Take theirs
              </button>
            </div>
            <div className="doc-side is-mine">
              <span className="doc-side-label">
                Your draft · <Who actor={c.by} me={me} />
              </span>
              <p className={c.mine === undefined ? 'is-gone' : undefined}>{c.mine ?? 'Removed in the draft'}</p>
              <button className="btn btn-small btn-primary" onClick={() => onResolve(c, 'mine')}>
                Keep mine
              </button>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}

// ---- signing in, and choosing the doc ---------------------------------------------

function AccessPanel(props: {
  problem: Problem;
  title: string;
  waiting: { url?: string; blocked?: boolean } | null;
  choosing: boolean;
  error: string | null;
  onAllow: () => void;
  onChoose: () => void;
  onCancelWait: () => void;
  onRetry: () => void;
  openInGoogle: ReactNode;
}) {
  const { problem, title, waiting, choosing, error, onAllow, onChoose, onCancelWait, onRetry, openInGoogle } = props;
  const ask: Record<string, { heading: string; action: string }> = {
    no_docs_permission: { heading: 'Connect Google again', action: 'Connect Google again' },
    not_connected: { heading: 'Connect Google to edit this doc', action: 'Connect Google' },
    needs_sign_in: { heading: 'Sign in to Google again', action: 'Sign in again' },
  };
  const step = problem.code ? ask[problem.code] : undefined;
  const notChosen = problem.code === 'not_picked';
  return (
    <div className="doc-access">
      <span className="doc-access-mark" aria-hidden>
        <Icon name={step || notChosen ? 'edit' : 'x'} />
      </span>
      <h3>{notChosen ? 'Choose this doc in Google once' : (step?.heading ?? (problem.code === 'not_set_up' ? 'Set up Google first' : "Can't open this doc"))}</h3>
      {notChosen ? (
        <>
          <p>
            Choose <strong>{title}</strong> in Google once to let Tricot open it.
          </p>
          <ul className="doc-access-points">
            <li>Tricot can open only the Google Docs you choose, never the rest of your Drive.</li>
            <li>Tricot changes a doc only when someone presses Save, and only the paragraphs edited here.</li>
            <li>Agents can read a doc and suggest edits in the draft. They can't save.</li>
          </ul>
        </>
      ) : (
        <p>{problem.message}</p>
      )}
      {waiting ? (
        <div className="row doc-access-actions">
          <span className="connector-waiting" role="status">
            <span className="connector-spinner" aria-hidden />
            {waiting.blocked ? "The browser didn't open a new tab. Open Google to sign in, then come back here." : 'Finish on the Google tab…'}
          </span>
          {waiting.url && (
            <a className={`btn btn-small${waiting.blocked ? ' btn-primary' : ''}`} href={waiting.url} target="_blank" rel="noreferrer">
              {waiting.blocked ? 'Open Google' : 'Open it again'} <Icon name="external" />
            </a>
          )}
          <button className="btn btn-small btn-quiet" onClick={onCancelWait}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="row doc-access-actions">
          {notChosen && (
            <button className="btn btn-primary" disabled={choosing} onClick={onChoose}>
              {choosing ? 'Choosing…' : 'Choose in Google'}
            </button>
          )}
          {step && (
            <button className="btn btn-primary" onClick={onAllow}>
              {step.action}
            </button>
          )}
          {problem.code === 'not_set_up' && (
            <a className="btn btn-primary" href="#/connectors">
              Go to Connectors
            </a>
          )}
          {!step && !notChosen && problem.code !== 'not_set_up' && (
            <button className="btn" onClick={onRetry}>
              Try again
            </button>
          )}
          {!step && !notChosen && openInGoogle}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
