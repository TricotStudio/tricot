import { createContext, Fragment, useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import type { RefScanner } from '../../core/refText';
import type { Board } from '../../core/types';
import { RefKinds, type RefCard, type RefRow } from './refKinds';

// The cards on the board on screen, as the kinds of reference registered
// (refKinds.ts) know them, so text anywhere in it can link the #12 and T5 it
// mentions, and say so of those deleted since, and a composer's # can offer
// them. Missing off a board, e.g. on Home. With no kind registered it finds
// nothing: the text stays text.
interface Refs {
  // Whether the board has a card of this kind and number, or had one, deleted.
  known: (kind: string, number: number) => boolean;
  // How a text is searched for the kinds registered; none when none is.
  scanner: RefScanner | undefined;
  card(kind: string, number: number): RefCard | undefined;
  deletedBy(kind: string, number: number): string | undefined;
  // How a card of this kind reads (T5): none for a kind not registered.
  label(kind: string, number: number): string | undefined;
  // The # list, when the kinds registered offer one.
  picker: { name: string; read: (before: string) => { at: number; query: string } | null; pick: (typed: string) => RefRow[] } | undefined;
}

const RefsContext = createContext<Refs | null>(null);

export function useRefs(): Refs | null {
  return useContext(RefsContext);
}

// No kind registered: what a page that is given none sees.
const NO_KINDS = new RefKinds();

// `kinds` are registered by whoever builds the page (a part's, for a board's
// own), before it renders.
export function RefsProvider({ board, kinds = NO_KINDS, children }: { board: Board; kinds?: RefKinds; children: ReactNode }) {
  const value = useMemo((): Refs => {
    const on = new Map(kinds.kinds().map((kind) => [kind.id, kind.on(board)]));
    const known = (kind: string, number: number) => {
      const seen = on.get(kind);
      return Boolean(seen && (seen.card(number) || seen.deletedBy(number) !== undefined));
    };
    const picker = kinds.list();
    const pick = picker?.on(board);
    return {
      known,
      scanner: kinds.scanner(),
      card: (kind, number) => on.get(kind)?.card(number),
      deletedBy: (kind, number) => on.get(kind)?.deletedBy(number),
      label: (kind, number) => kinds.label(kind, number),
      picker: picker && pick && { name: picker.name, read: picker.read, pick },
    };
  }, [board, kinds]);
  return <RefsContext.Provider value={value}>{children}</RefsContext.Provider>;
}

// A card named in text: its status marker and number, its title on hover, and
// a link that opens it. In a canvas note it neither drags the block nor starts
// editing it. `inert` is for text inside a button (notification and activity rows),
// where a link can't go: the chip is a span that opens its card on a click.
export function RefChip(props: { kind: string; number: number; inert?: boolean; children?: ReactNode }) {
  const { kind, number, inert, children } = props;
  const refs = useRefs();
  const card = refs?.card(kind, number);
  const label = children ?? refs?.label(kind, number) ?? `${kind} ${number}`;
  const deletedBy = !card ? refs?.deletedBy(kind, number) : undefined;
  if (deletedBy !== undefined) {
    return (
      <span className={`ref-chip ref-deleted${inert ? ' is-inert' : ''}`} title={`Deleted by ${deletedBy}, for good`}>
        {label}
      </span>
    );
  }
  if (!card) return <>{label}</>;
  const shared = {
    className: `ref-chip ${card.marker}${inert ? ' is-inert' : ''} nodrag nopan`,
    title: `${card.title} · ${card.status}`,
    onMouseDown: (e: MouseEvent) => e.stopPropagation(),
    onDoubleClick: (e: MouseEvent) => e.stopPropagation(),
  };
  if (inert) {
    const open = (e: MouseEvent) => {
      e.stopPropagation();
      card.open();
    };
    return (
      <span {...shared} onClick={open}>
        {label}
      </span>
    );
  }
  // Not draggable, so a drag across it selects the words around it, as for pinning.
  return (
    <a {...shared} href={card.href} draggable={false} onClick={(e) => e.stopPropagation()}>
      {label}
    </a>
  );
}

// Plain text, e.g. a progress note or an event in the log, with the cards it
// names linked, each as written (T5, or #T5).
export function RefText({ text, inert }: { text: string; inert?: boolean }) {
  const refs = useRefs();
  if (!refs?.scanner) return <>{text}</>;
  return (
    <>
      {refs.scanner.split(text, refs.known).map((piece, i) =>
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
