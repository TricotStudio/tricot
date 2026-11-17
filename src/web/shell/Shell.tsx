import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { AdmissionBanners, ApprovalToasts, SeatPromptDialog, useApprovalAttention } from '../access';
import { tabTitleStore } from '../shared/tabTitle';
import { NameGate, useName } from './nameGate';

// What every page is shown in. A browser that hasn't said who you are asks
// first (NameGate); then the page, and what reaches every page: agents
// waiting for your OK (access/approvals.tsx), browsers and terminals asking
// to act for you and this browser asking (access/seats.tsx), and the tab's
// title (shared/tabTitle.ts). Each page's top bar is the shell's (TopBar,
// topBar.tsx), with your menu at its end.

interface You {
  name: string;
  rename: () => void; // asks for your name again
}

const YouContext = createContext<You>({ name: '', rename: () => {} });

// You, for your menu at the end of every top bar.
export function useYou(): You {
  return useContext(YouContext);
}

export function Shell({ children }: { children: (name: string) => ReactNode }) {
  const [name, setName] = useName();
  const rename = useCallback(() => setName(''), [setName]);
  const you = useMemo(() => ({ name, rename }), [name, rename]);
  if (!name) return <NameGate onSubmit={setName} />;
  return (
    <YouContext.Provider value={you}>
      {children(name)}
      <ApprovalToasts name={name} />
      <AdmissionBanners name={name} />
      <SeatPromptDialog />
      <Attention />
    </YouContext.Provider>
  );
}

// The tab's title, and a notification while it is in the background.
function Attention() {
  useApprovalAttention();
  useTabTitle();
  return null;
}

// Writes the tab's title each time a part of it changes (shared/tabTitle.ts),
// and tells it when the tab goes to the background and comes back.
function useTabTitle(): void {
  useEffect(() => {
    const write = () => {
      const title = tabTitleStore.title();
      if (document.title !== title) document.title = title;
    };
    const seen = () => tabTitleStore.set({ hidden: document.visibilityState === 'hidden' });
    const stop = tabTitleStore.subscribe(write);
    seen();
    document.addEventListener('visibilitychange', seen);
    return () => {
      document.removeEventListener('visibilitychange', seen);
      stop();
    };
  }, []);
}
