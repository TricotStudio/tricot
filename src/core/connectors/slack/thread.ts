// A Slack thread as a link card shows it, and the words for what can go wrong.
// Shared by the server, which fills it in from Slack, and the web UI.

export interface SlackThreadCard {
  channel: string; // the id: C…
  ts: string; // the thread's first message
  author: string; // who wrote it, by name
  text: string; // its words, as plain text
  replies: number;
  postedAt: string; // ISO
  latestReplyAt?: string;
}

// Why a card can't be shown, in words for the person: the card says it instead.
export interface SlackProblem {
  code: string; // not_connected, needs_sign_in, not_found, missing_scope, rate_limited, unavailable…
  message: string;
}

// What a share to Slack came to.
export interface SlackShared {
  channel: string;
  ts: string;
}

export const repliesText = (count: number): string => (count === 0 ? 'No replies' : count === 1 ? '1 reply' : `${count} replies`);
