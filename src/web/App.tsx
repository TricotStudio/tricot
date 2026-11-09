import { useApprovalsStream } from './access';
import { BoardView } from './board';
import { ConnectorsPage } from './connectors';
import { Home } from './home';
import { useRoute } from './shared/pages';
import { Shell } from './shell';

// The page the address opens (core/pages.ts), in the shell every page is
// shown in (shell/).
export function App() {
  return <Shell>{(name) => <Page name={name} />}</Shell>;
}

function Page({ name }: { name: string }) {
  const route = useRoute();
  // A board's stream and Home's carry the agents waiting for your OK; any other page listens for them itself.
  useApprovalsStream(route.page !== 'board' && route.page !== 'home');
  if (route.page === 'board') {
    return <BoardView boardId={route.boardId} view={route.view} decisionId={route.decisionId} taskId={route.taskId} pinId={route.pinId} name={name} />;
  }
  if (route.page === 'connectors') return <ConnectorsPage from={route.from} />;
  return <Home name={name} />;
}
