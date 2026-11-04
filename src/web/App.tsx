import { ApprovalToasts, useApprovalAttention, useApprovalsStream } from './approvals';
import { BoardView } from './BoardView';
import { NameGate } from './components';
import { ConnectorsPage } from './connectors';
import { Home } from './Home';
import { useName, useRoute } from './hooks';
import { AdmissionBanners, SeatPromptDialog } from './seats';

export function App() {
  const [name, setName] = useName();
  if (!name) return <NameGate onSubmit={setName} />;
  // Agents waiting for your OK reach every page (approvals.tsx), and so do
  // browsers and terminals asking to act for you, and this browser asking (seats.tsx).
  return (
    <>
      <Page name={name} onRename={() => setName('')} />
      <ApprovalToasts name={name} />
      <AdmissionBanners name={name} />
      <SeatPromptDialog />
      <Attention />
    </>
  );
}

function Page({ name, onRename }: { name: string; onRename: () => void }) {
  const route = useRoute();
  // A board's stream and Home's carry the agents waiting for your OK; any other page listens for them itself.
  useApprovalsStream(route.page !== 'board' && route.page !== 'home');
  if (route.page === 'board') {
    return (
      <BoardView
        boardId={route.boardId}
        view={route.view}
        decisionId={route.decisionId}
        taskId={route.taskId}
        name={name}
        onRename={onRename}
      />
    );
  }
  if (route.page === 'connectors') return <ConnectorsPage name={name} onRename={onRename} from={route.from} />;
  return <Home name={name} onRename={onRename} />;
}

// The tab's title and a notification, while it is in the background.
function Attention() {
  useApprovalAttention();
  return null;
}
