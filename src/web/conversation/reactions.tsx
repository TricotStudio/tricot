import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { samePerson } from '../../core/format';
import { EMOJIS, EMOJI_NAMES, hasReaction, reactionGroups, type Emoji, type Reactable } from '../../core/reactions';
import type { ReactionPlace } from '../../core/store/reactions';
import type { Actor, Reaction } from '../../core/types';
import { api } from '../shared/api';
import { Icon, timeAgo } from '../shared/components';
import { menuStep, useDismiss, useReadOnly } from '../shared/hooks';
import './reactions.css';

// Under a comment or a thread message: a chip for each of 👍, 👎 and 👀 left on
// it, naming who (the viewer's own in the focus tint, and a click takes it back
// or adds theirs), then the smiley that opens the three (core/reactions.ts).
// Nobody reacts to their own, so the viewer's comments show the chips alone.
// What changes comes back with the board, live: an agent's 👀 shows up the
// moment the comment reaches it.

// Names on a chip before the rest are counted: "Claude, Codex +2".
const NAMED = 2;

interface Props {
  item: Reactable;
  place: ReactionPlace; // the card, thread or pin it is in
  name: string; // the viewer
}

export function Reactions({ item, place, name }: Props) {
  const readOnly = useReadOnly();
  const me: Actor = { kind: 'human', name };
  const own = item.author.kind === 'human' && samePerson(item.author.name, name);
  const can = !readOnly && !own && Boolean(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = reactionGroups(item.reactions);

  const toggle = async (emoji: Emoji) => {
    if (busy || !can) return;
    setBusy(true);
    setError(null);
    try {
      await api.react(place, item.id, name, emoji, hasReaction(item, emoji, me));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (groups.length === 0 && !can) return null;
  return (
    <div className="reactions">
      {groups.map(({ emoji, reactions }) => {
        const mine = hasReaction(item, emoji, me);
        const label = `${EMOJI_NAMES[emoji]} from ${names(reactions, reactions.length)}${mine && can ? '. Yours: press to take it back' : ''}`;
        const content = (
          <>
            <span className="reaction-emoji" aria-hidden>
              {emoji}
            </span>
            <span className="reaction-names">{names(reactions, NAMED)}</span>
          </>
        );
        return can ? (
          <button
            key={emoji}
            type="button"
            className={`reaction${mine ? ' is-mine' : ''}`}
            aria-pressed={mine}
            aria-label={label}
            title={tooltip(emoji, reactions)}
            disabled={busy}
            onClick={() => void toggle(emoji)}
          >
            {content}
          </button>
        ) : (
          <span key={emoji} className={`reaction${mine ? ' is-mine' : ''}`} role="img" aria-label={label} title={tooltip(emoji, reactions)}>
            {content}
          </span>
        );
      })}
      {can && <Picker item={item} me={me} busy={busy} onPick={(emoji) => void toggle(emoji)} />}
      {error && (
        <span className="reactions-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// "Sam", "Claude, Codex", "Claude, Codex +2".
function names(reactions: Reaction[], shown: number): string {
  const all = reactions.map((r) => r.by.name);
  const more = all.length - shown;
  return more > 0 ? `${all.slice(0, shown).join(', ')} +${more}` : all.join(', ');
}

// Who and when, one a line: "👍 Thumbs up · Sam, 4m ago · Claude, just now".
function tooltip(emoji: Emoji, reactions: Reaction[]): string {
  return [`${emoji} ${EMOJI_NAMES[emoji]}`, ...reactions.map((r) => `${r.by.name}, ${timeAgo(r.at)}`)].join('\n');
}

// The smiley-plus button and the three it opens, above it. Arrow keys move
// between them; Escape, Tab or a click outside closes it, focus going back to
// the button.
function Picker({ item, me, busy, onPick }: { item: Reactable; me: Actor; busy: boolean; onPick: (emoji: Emoji) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback((escape: boolean) => {
    setOpen(false);
    if (escape) button.current?.focus();
  }, []);
  useDismiss(open, close, root);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open]);

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      return close(true);
    }
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const to = menuStep(e.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length);
    if (to === undefined) return;
    e.preventDefault();
    items[to]?.focus();
  };

  return (
    <span className="reaction-adder" ref={root}>
      <button
        ref={button}
        type="button"
        className="reaction-add"
        aria-label="Add a reaction"
        title="Add a reaction"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="react" />
      </button>
      {open && (
        <div className="reaction-picker" role="menu" aria-label="Reactions" ref={menu} onKeyDown={move}>
          {EMOJIS.map((emoji) => {
            const mine = hasReaction(item, emoji, me);
            return (
              <button
                key={emoji}
                type="button"
                role="menuitemcheckbox"
                aria-checked={mine}
                aria-label={EMOJI_NAMES[emoji]}
                title={mine ? `${EMOJI_NAMES[emoji]}: take yours back` : EMOJI_NAMES[emoji]}
                tabIndex={-1}
                disabled={busy}
                onClick={() => {
                  onPick(emoji);
                  close(true);
                }}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
