import { createContext, useContext, type MouseEventHandler, type ReactNode } from 'react';
import { CardKinds } from './cardKinds';

// The kinds of card the page has registered (cardKinds.ts), for every
// component of the canvas side to ask. Wrapped round the page where it is
// built (App.tsx); without a provider, as in a test, the page has none, and is
// the canvas alone.
const NO_KINDS = new CardKinds();
const CardKindsContext = createContext<CardKinds>(NO_KINDS);

export function CardKindsProvider({ kinds, children }: { kinds: CardKinds; children: ReactNode }) {
  return <CardKindsContext.Provider value={kinds}>{children}</CardKindsContext.Provider>;
}

export function useCardKinds(): CardKinds {
  return useContext(CardKindsContext);
}

// A link to a card, drawn as it always was, or, where no kind of card says
// where it is (none registered), the same words as plain text in a span of the
// same class, with nothing to press.
export function CardAnchor(props: { href: string | undefined; className?: string; title?: string; onClick?: MouseEventHandler<HTMLAnchorElement>; children?: ReactNode }) {
  const { href, className, title, onClick, children } = props;
  if (href === undefined) {
    return (
      <span className={className} title={title}>
        {children}
      </span>
    );
  }
  return (
    <a className={className} href={href} title={title} onClick={onClick}>
      {children}
    </a>
  );
}
