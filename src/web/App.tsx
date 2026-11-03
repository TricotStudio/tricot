import { BoardView } from './BoardView';
import { NameGate } from './components';
import { ConnectorsPage } from './connectors';
import { Home } from './Home';
import { useName, useRoute } from './hooks';

export function App() {
  const route = useRoute();
  const [name, setName] = useName();
  const rename = () => setName('');

  if (!name) return <NameGate onSubmit={setName} />;
  if (route.page === 'board') {
    return (
      <BoardView
        boardId={route.boardId}
        view={route.view}
        decisionId={route.decisionId}
        taskId={route.taskId}
        name={name}
        onRename={rename}
      />
    );
  }
  if (route.page === 'connectors') return <ConnectorsPage name={name} onRename={rename} from={route.from} />;
  return <Home name={name} onRename={rename} />;
}
