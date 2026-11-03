import { useState, type ReactNode } from 'react';
import type { Board, Decision } from '../core/types';
import { CanvasView } from './canvas/CanvasView';
import { CardMenu } from './cardActions';
import { CardBar } from './CardBar';
import { StatusPill } from './components';
import { DecisionPanel } from './DecisionPanel';
import { CardViewBody } from './panelWidth';

interface Props {
  board: Board;
  decision: Decision;
  name: string;
  onClose: () => void;
  newItems: ReadonlySet<string>;
  onSeeItem: (id: string) => void;
  topbar: ReactNode;
  notice?: ReactNode; // under the top bar, e.g. that the board is archived
  needsYou?: ReactNode; // at the right of the bar under it
  unreadSince: string | null;
}

// A decision opened up: its canvas fills the room, and the structured
// decision stays in a panel beside it, as wide as the person drags it.
export function CardView(props: Props) {
  const { board, decision, name, onClose, newItems, onSeeItem, topbar, notice, needsYou, unreadSince } = props;
  // Hovering an option highlights the canvas blocks pinned to it.
  const [hoveredOption, setHoveredOption] = useState<string | null>(null);
  // Retire it instead, from the delete dialog, opens the panel's retire form.
  const [retireAsk, setRetireAsk] = useState(0);

  return (
    <div className="card-view">
      {topbar}
      {notice}
      <CardBar
        back="Decisions"
        onClose={onClose}
        meta={
          <>
            <span className="card-number">#{decision.number}</span>
            <StatusPill status={decision.status} />
            {decision.blocking && decision.status === 'open' && <span className="tag tag-blocking">blocking</span>}
          </>
        }
        title={decision.question}
        menu={<CardMenu board={board} card={{ decision }} name={name} onRetire={() => setRetireAsk((n) => n + 1)} />}
        end={needsYou}
      />
      <CardViewBody
        canvas={
          <section className="card-view-canvas" aria-label="Canvas">
            <CanvasView
              board={board}
              decision={decision}
              name={name}
              highlightOption={hoveredOption}
              newItems={newItems}
              onSeeItem={onSeeItem}
            />
          </section>
        }
        panel={
          <DecisionPanel
            board={board}
            decision={decision}
            name={name}
            onHoverOption={setHoveredOption}
            unreadSince={unreadSince}
            retireAsk={retireAsk}
          />
        }
      />
    </div>
  );
}
