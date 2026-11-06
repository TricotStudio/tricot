import type { ReactNode } from 'react';
import { Icon } from '../shared/components';

interface Props {
  back: string; // the tab the card is on: Decisions or Tasks
  onClose: () => void;
  meta: ReactNode; // its number and where it stands
  title: string;
  menu?: ReactNode; // the card's ⋯, after its title
  end?: ReactNode;
}

// The bar under the top bar on a decision or task, where the tabs are on the
// board: a way back to its tab, the card's number and status, its title and
// its ⋯ menu.
export function CardBar({ back, onClose, meta, title, menu, end }: Props) {
  return (
    <div className="attention card-bar">
      <button className="btn btn-quiet btn-small back" onClick={onClose} title={`Back to the ${back.toLowerCase()}`}>
        <Icon name="arrow-left" /> {back}
      </button>
      <div className="card-bar-meta">{meta}</div>
      <h1 className="card-bar-title" title={title}>
        {title}
      </h1>
      {menu}
      {end && <div className="attention-end">{end}</div>}
    </div>
  );
}
