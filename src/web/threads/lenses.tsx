import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { samePerson } from '../../core/format';
import { LENS_BRIEF_LIMIT, LENS_NAME_LIMIT, LENSES, presetLens } from '../../core/threads';
import type { ThreadLens } from '../../core/types';
import { Icon } from '../shared/components';
import { useDismiss } from '../shared/hooks';
import { useRoster } from '../shared/mentions';
import { LENS_MENU_WIDTH, lensMenuPlace, type LensMenuPlace } from './lensPlace';
import { lensTone } from './lensTone';

// A thread's lens, as people see and pick it: a quiet tinted chip under the
// open thread's title, which is the button for changing it. It opens a small
// menu over the conversation, inside the window (lensPlace.ts), with the
// lenses as pills, one of your own (a name and a brief), and which agent
// answers what mentions nobody. A new thread has a line above its composer
// that picks the lens it starts with.

const GENERAL_LINE = 'Agents answer as they see fit.';

export function LensChip({ lens, children }: { lens: ThreadLens | undefined; children?: ReactNode }) {
  return <span className={`lens-chip ${lensTone(lens)}`}>{children ?? lens?.name ?? 'General'}</span>;
}

// A lens as the API takes it: a preset by name, one's own with its brief;
// null for General answered by any agent.
export function lensChoice(name: string, brief: string | undefined, agent: string | undefined): ThreadLens | null {
  const preset = presetLens(name);
  if (preset?.name === 'General' && !agent) return null;
  return { name: preset?.name ?? name, ...(!preset && brief ? { brief } : {}), ...(agent ? { agent } : {}) };
}

// A lens chip that is the button for changing it: it opens the menu under
// it, which says the briefs. `onPick` gets null for General; the caller
// reports what it refuses. Read-only, it is only the chip.
export function LensPicker(props: {
  lens: ThreadLens | undefined;
  readOnly?: boolean;
  onPick: (lens: ThreadLens | null) => void;
  label?: string; // the chip's words, else the lens's name
  note?: string; // said instead of General's line when the lens has no brief
}) {
  const { lens, readOnly, onPick, label, note } = props;
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<LensMenuPlace | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const name = lens?.name ?? 'General';
  const chip = <LensChip lens={lens}>{label ?? name}</LensChip>;
  const close = useCallback((escape = true) => {
    setOpen(false);
    if (escape) button.current?.focus();
  }, []);
  useDismiss(open, close, anchor);

  // Fixed by the chip, so the list or panel it sits in doesn't clip it, and
  // inside the window (lensPlace.ts); it follows the chip while either
  // scrolls or the window resizes. Whether it fits under the chip takes its
  // height, drawn at its width: so it is placed again, before it shows, each
  // time it is drawn at a new width (opening the first time, it had none).
  const width = place?.width;
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = button.current?.getBoundingClientRect();
      if (!box) return;
      const view = { width: window.innerWidth, height: window.innerHeight };
      setPlace(lensMenuPlace(box, { width: LENS_MENU_WIDTH, height: fullHeight(menu.current) }, view));
    };
    measure();
    window.addEventListener('resize', measure);
    document.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      document.removeEventListener('scroll', measure, true);
    };
  }, [open, width]);

  // Esc closes the menu, not the panel around it: it stops here, before the
  // panel's own listener on the document hears it.
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open || e.key !== 'Escape') return;
    e.stopPropagation();
    close();
  };

  if (readOnly) return chip;
  return (
    <span className="lens-anchor" ref={anchor} onKeyDown={onKeyDown}>
      <button
        ref={button}
        type="button"
        className="lens-pick"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={`${label ?? `${name} lens`}, change it`}
        title="Change the lens"
        onClick={() => setOpen(!open)}
      >
        {chip}
      </button>
      {open && place && (
        <LensMenu
          id={id}
          root={menu}
          lens={lens}
          generalLine={note}
          place={place}
          onPick={(next) => {
            close();
            onPick(next);
          }}
        />
      )}
    </span>
  );
}

// The menu's height with all it holds, though a short window scrolls it.
function fullHeight(menu: HTMLElement | null): number {
  return menu ? menu.scrollHeight + menu.offsetHeight - menu.clientHeight : 0;
}

// A new thread's line above its composer: the lens it starts with, and who
// answers by it.
export function LensLine(props: { lens: ThreadLens | undefined; onPick: (lens: ThreadLens | null) => void }) {
  const { lens, onPick } = props;
  return (
    <div className="lens-line">
      <LensPicker lens={lens} label={`${lens?.name ?? 'General'} lens`} onPick={onPick} />
      <AnswersLine lens={lens} />
    </div>
  );
}

// Who answers, when the lens is routed to an agent; the brief shows only in
// the menu.
export function AnswersLine({ lens, className }: { lens: ThreadLens | undefined; className?: string }) {
  if (!lens?.agent) return null;
  return (
    <span className={className} title={`Messages that @-mention nobody go to ${lens.agent}`}>
      {lens.agent} answers
    </span>
  );
}

const OWN_LINE = 'Name it, and say how agents should answer.';

// The lenses as pills, with the brief of the one pointed at (else the
// current one) under them, so no brief is said twice; one of your own opens
// its form; who answers is the last line.
function LensMenu(props: {
  id: string;
  root: RefObject<HTMLDivElement | null>; // for the picker to measure it
  lens: ThreadLens | undefined;
  generalLine?: string; // said instead of General's line
  place: LensMenuPlace;
  onPick: (lens: ThreadLens | null) => void;
}) {
  const { id, root, lens, generalLine, place, onPick } = props;
  const { agents } = useRoster();
  const current = lens?.name ?? 'General';
  const isOwn = !presetLens(current);
  const [own, setOwn] = useState(isOwn);
  const [ownName, setOwnName] = useState(isOwn ? current : '');
  const [ownBrief, setOwnBrief] = useState(isOwn ? (lens?.brief ?? '') : '');
  const [agent, setAgent] = useState(lens?.agent ?? '');
  const [pointed, setPointed] = useState<string | null>(null); // the pill under the pointer or the focus
  const ownReady = Boolean(ownName.trim() && ownBrief.trim()) && !presetLens(ownName);
  // An agent no longer on the board stays a choice while it's the lens's.
  const choices = [...agents.map((a) => a.name), ...(lens?.agent && !agents.some((a) => samePerson(a.name, lens.agent!)) ? [lens.agent] : [])];
  const chosen = own ? '' : current;
  const shown = pointed ?? chosen;
  const brief = shown === '' ? OWN_LINE : (presetLens(shown)?.brief ?? generalLine ?? GENERAL_LINE);

  // Opening, the focus goes to the current choice.
  useEffect(() => {
    if (!isOwn) root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [isOwn]);

  // Arrows move between the pills; Enter or Space on one picks it.
  const onPillKey = (e: KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const pills = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
    const at = pills.indexOf(document.activeElement as HTMLElement);
    pills[(at + step + pills.length) % pills.length]?.focus();
  };
  const point = (name: string | null) => ({
    onMouseEnter: () => setPointed(name),
    onMouseLeave: () => setPointed(null),
    onFocus: () => setPointed(name),
    onBlur: () => setPointed(null),
  });

  return (
    <div id={id} ref={root} className="lens-menu" tabIndex={-1} style={place}>
      <div className="lens-pills" role="radiogroup" aria-label="Lens" onKeyDown={onPillKey}>
        {LENSES.map((preset) => {
          const checked = chosen === preset.name;
          return (
            <button
              key={preset.name}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className="lens-pill"
              onClick={() => onPick(lensChoice(preset.name, undefined, agent || undefined))}
              {...point(preset.name)}
            >
              <LensChip lens={preset}>
                {preset.name}
                {checked && <Icon name="check" className="lens-check" />}
              </LensChip>
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={own}
          tabIndex={own ? 0 : -1}
          className="lens-pill"
          onClick={() => setOwn(true)}
          {...point('')}
        >
          <LensChip lens={{ name: '' }}>
            Your own
            {own && <Icon name="check" className="lens-check" />}
          </LensChip>
        </button>
      </div>
      <p className="lens-menu-brief" aria-live="polite">
        {brief}
      </p>
      {own && (
        <form
          className="lens-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (ownReady) onPick(lensChoice(ownName.trim(), ownBrief.trim(), agent || undefined));
          }}
        >
          <input
            value={ownName}
            maxLength={LENS_NAME_LIMIT}
            onChange={(e) => setOwnName(e.target.value)}
            placeholder="Name, e.g. Pricing"
            aria-label="Lens name"
            autoFocus
          />
          <textarea
            rows={2}
            value={ownBrief}
            maxLength={LENS_BRIEF_LIMIT}
            onChange={(e) => setOwnBrief(e.target.value)}
            placeholder="How agents should answer, in a sentence or two"
            aria-label="Lens brief"
          />
          <button type="submit" className="btn btn-small" disabled={!ownReady}>
            Use this lens
          </button>
        </form>
      )}
      <label className="lens-agent">
        <span>Who answers</span>
        <select
          value={agent}
          onChange={(e) => {
            setAgent(e.target.value);
            // A preset applies at once; one's own waits for its form.
            if (!own) onPick(lensChoice(current, undefined, e.target.value || undefined));
          }}
        >
          <option value="">Any agent, the first to reply</option>
          {choices.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
