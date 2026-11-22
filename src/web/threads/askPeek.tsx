import type { KeyboardEvent, ReactNode } from 'react';
import { shownTitle } from '../../core/threads';
import type { Thread } from '../../core/types';
import { Icon } from '../shared/components';
import './askPeek.css';

// The answer to what was just asked from the floating chat bar, peeking over
// it (threads.tsx): a quick question stays in the board's conversation, on
// its Home, and the dock opens no thread for it. The card holds the exchange
// as it comes (`children`, drawn as a conversation is): the ask, the line
// under it that says an agent is on it, and the answer. Where the
// coordinator sends it on, its word says where and opens that thread. Taken
// on as work, or moved into the work it follows up (`work`), it says so, and
// opens that thread. Open on Home goes to the conversation at the latest of
// it; ✕ or Esc lets it go, and the next ask takes its place. It changes
// nothing: the ask is stored as every ask from the bar is.

interface Props {
  asked?: string; // where it was asked, as Home's conversation tags it: "asked on Tidy docs"
  work?: { thread: Thread; how: 'taken' | 'moved' }; // the work it is now part of
  onHome: () => void;
  onWork: (id: string) => void;
  onClose: () => void;
  children?: ReactNode; // the exchange; none once its thread has moved into work
}

export function AskPeek({ asked, work, onHome, onWork, onClose, children }: Props) {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    onClose();
  };
  const owner = work?.thread.owner?.split(' · ')[0];
  return (
    <section className="ask-peek" aria-label="The answer, in the conversation" onKeyDown={onKeyDown}>
      <header className="ask-peek-head">
        <span className="conversation-swatch" aria-hidden />
        <span className="ask-peek-where">
          <strong>In the conversation</strong>
          {asked && <span className="ask-peek-asked"> · {asked}</span>}
        </span>
        <button type="button" className="ask-peek-home" onClick={onHome} title="Open the board's conversation on its Home, at this">
          Open on Home <Icon name="arrow-right" />
        </button>
        <button type="button" className="ask-peek-close" onClick={onClose} aria-label="Dismiss" title="Dismiss (Esc)">
          <Icon name="x" />
        </button>
      </header>
      {children}
      {work && (
        <p className="ask-peek-work">
          <Icon name="thread" />
          <span className="ask-peek-work-what">
            {work.how === 'taken' ? (
              <>Taken on by {owner ?? 'an agent'} as work</>
            ) : (
              <>
                Moved into “{shownTitle(work.thread)}”, the work it follows up
              </>
            )}
          </span>
          <button type="button" className="ask-peek-open" onClick={() => onWork(work.thread.id)}>
            Open <Icon name="arrow-right" />
          </button>
        </p>
      )}
    </section>
  );
}
