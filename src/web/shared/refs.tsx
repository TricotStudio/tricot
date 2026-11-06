import { createContext, Fragment, useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import { TASK_STATUS_WORDS } from '../../core/pins';
import { refLabel, splitRefs, type KnownRef, type RefKind } from '../../core/refs';
import type { Board, Decision, DeletedCard, Task } from '../../core/types';
import { go, linkTo } from './pages';

// The cards on the board on screen, by number, so text anywhere in it can
// link the #12 and T5 it mentions, and say so of those deleted since. Missing
// off a board, e.g. on Home.
interface Refs {
  boardId: string;
  decisions: ReadonlyMap<number, Decision>;
  tasks: ReadonlyMap<number, Task>;
  deleted: ReadonlyMap<string, DeletedCard>; // by refLabel: #8, T12
  known: KnownRef;
}

const RefsContext = createContext<Refs | null>(null);

export function useRefs(): Refs | null {
  return useContext(RefsContext);
}

export function RefsProvider({ board, children }: { board: Board; children: ReactNode }) {
  const value = useMemo(() => {
    const decisions = new Map(board.decisions.map((d) => [d.number, d]));
    const tasks = new Map(board.tasks.map((t) => [t.number, t]));
    const deleted = new Map((board.deletedCards ?? []).map((c) => [refLabel(c), c]));
    const known: KnownRef = (kind, number) => (kind === 'decision' ? decisions : tasks).has(number) || deleted.has(refLabel({ kind, number }));
    return { boardId: board.id, decisions, tasks, deleted, known };
  }, [board]);
  return <RefsContext.Provider value={value}>{children}</RefsContext.Provider>;
}

// A card named in text: its status marker and number, its title on hover, and
// a link that opens it. In a canvas note it neither drags the block nor starts
// editing it. `inert` is for text inside a button (inbox and activity rows),
// where a link can't go: the chip is a span that opens its card on a click.
export function RefChip(props: { kind: RefKind; number: number; inert?: boolean; children?: ReactNode }) {
  const { kind, number, inert, children } = props;
  const refs = useRefs();
  const decision = kind === 'decision' ? refs?.decisions.get(number) : undefined;
  const task = kind === 'task' ? refs?.tasks.get(number) : undefined;
  const label = children ?? refLabel({ kind, number });
  const deleted = !decision && !task ? refs?.deleted.get(refLabel({ kind, number })) : undefined;
  if (deleted) {
    return (
      <span className={`ref-chip ref-deleted${inert ? ' is-inert' : ''}`} title={`Deleted by ${deleted.by.name}, for good`}>
        {label}
      </span>
    );
  }
  if (!refs || (!decision && !task)) return <>{label}</>;
  const status = decision ? decision.status : TASK_STATUS_WORDS[task!.status];
  const shared = {
    className: `ref-chip ${decision ? `ref-${decision.status}` : `ref-task-${task!.status}`}${inert ? ' is-inert' : ''} nodrag nopan`,
    title: `${decision ? decision.question : task!.title} · ${status}`,
    onMouseDown: (e: MouseEvent) => e.stopPropagation(),
    onDoubleClick: (e: MouseEvent) => e.stopPropagation(),
  };
  if (inert) {
    const open = (e: MouseEvent) => {
      e.stopPropagation();
      if (decision) go.decision(refs.boardId, decision.id);
      else go.task(refs.boardId, task!.id);
    };
    return (
      <span {...shared} onClick={open}>
        {label}
      </span>
    );
  }
  const href = decision ? linkTo.decision(refs.boardId, decision.id) : linkTo.task(refs.boardId, task!.id);
  // Not draggable, so a drag across it selects the words around it, as for pinning.
  return (
    <a {...shared} href={href} draggable={false} onClick={(e) => e.stopPropagation()}>
      {label}
    </a>
  );
}

// Plain text, e.g. a progress note or an event in the log, with the cards it
// names linked, each as written (T5, or #T5).
export function RefText({ text, inert }: { text: string; inert?: boolean }) {
  const refs = useRefs();
  if (!refs) return <>{text}</>;
  return (
    <>
      {splitRefs(text, refs.known).map((piece, i) =>
        typeof piece === 'string' ? (
          <Fragment key={i}>{piece}</Fragment>
        ) : (
          <RefChip key={i} kind={piece.kind} number={piece.number} inert={inert}>
            {text.slice(piece.start, piece.end)}
          </RefChip>
        ),
      )}
    </>
  );
}
