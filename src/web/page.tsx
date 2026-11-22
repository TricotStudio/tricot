import { useApprovalsStream } from './access';
import { BoardView } from './board';
import { ConnectorsPage } from './connectors';
import { Projects } from './projects';
import { useRoute } from './shared/pages';

// The page the address opens (core/pages.ts), in the shell every page is shown
// in (shell/): Projects, a board, or the Connectors page. What each of them shows
// of a part's is registered where the page is built (App.tsx, canvasApp.tsx).
export function Page({ name }: { name: string }) {
  const route = useRoute();
  // A board's stream and Projects' carry the agents waiting for your OK; any other page listens for them itself.
  useApprovalsStream(route.page !== 'board' && route.page !== 'projects');
  if (route.page === 'board') {
    return <BoardView route={route} name={name} />;
  }
  if (route.page === 'connectors') return <ConnectorsPage from={route.from} />;
  return <Projects name={name} />;
}
