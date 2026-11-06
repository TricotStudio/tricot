import type { Approval } from '../../core/approvals';

// The agents waiting for the person's OK, as the page holds them
// (access/approvals.tsx shows them). Kept apart from the board, as steps
// are, so a change redraws only what shows them, and with no imports of the
// page's own, so every stream can fill it.

export class ApprovalsStore {
  private list: Approval[] = [];
  private shown: Approval[] = [];
  private answered = new Set<string>(); // answered from this page: gone before the stream says so
  private readonly listeners = new Set<() => void>();

  set(list: Approval[]): void {
    this.list = list;
    this.answered = new Set([...this.answered].filter((id) => list.some((a) => a.id === id)));
    this.tell();
  }

  drop(id: string): void {
    this.answered.add(id);
    this.tell();
  }

  get = (): Approval[] => this.shown;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private tell(): void {
    this.shown = this.list.filter((a) => !this.answered.has(a.id));
    for (const listener of this.listeners) listener();
  }
}

// The page's one list, whichever stream fills it: a board's (liveBoard.ts),
// Home's steps stream (steps.tsx), or, on a page with neither, the
// approvals' own (approvals.tsx useApprovalsStream). Each frame is the whole
// list, so a stream joining again needs nothing more. A browser holds only a
// few streams per server across all its tabs, so a page opens no more than one.
export const approvalsStore = new ApprovalsStore();
