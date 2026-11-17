import type { ReactNode, RefObject } from 'react';
import { Wordmark } from '../shared/components';
import { linkTo } from '../shared/pages';
import { useYou } from './Shell';
import { UserMenu } from './userMenu';

interface TopBarProps {
  home?: boolean; // Home's: the wordmark is where you are, not a link back to it
  left?: ReactNode; // after the wordmark: a board's heading
  right?: ReactNode; // before your menu: the page's own controls
  bar?: RefObject<HTMLElement | null>;
}

// The bar across the top of every page: the wordmark, which leads back to
// Home, what the page adds, and your menu at the end.
export function TopBar({ home = false, left, right, bar }: TopBarProps) {
  const { name, rename } = useYou();
  return (
    <header className="topbar" ref={bar}>
      {home ? (
        <div className="brand">
          <Wordmark />
        </div>
      ) : (
        <div className="topbar-left">
          <a className="brand" href={linkTo.home()} title="All boards">
            <Wordmark />
          </a>
          {left}
        </div>
      )}
      <div className="topbar-right">
        {right}
        <UserMenu name={name} onRename={rename} />
      </div>
    </header>
  );
}
