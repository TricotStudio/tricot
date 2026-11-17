// What a Linear address points to, and an issue as a link card shows it.
// Shared by the server, which fills the card in from Linear, and the web UI.
// Browser-safe.

// An issue's identifier: its team's key, a dash and its number ("ENG-123").
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/;

// The identifier in upper case, which is how Linear writes it, or null when the text isn't one.
export function normalIdentifier(text: string): string | null {
  const found = text.trim();
  return IDENTIFIER.test(found) ? found.toUpperCase() : null;
}

// The identifier in a linear.app path, split into its parts: /<workspace>/issue/ENG-123/<title slug>.
export function issueIdentifier(parts: string[]): string | null {
  if (parts[1] !== 'issue') return null;
  return normalIdentifier(parts[2] ?? '');
}

// An issue's link: linear.app/<workspace>/issue/ENG-123, with the title's slug after it.
export function linearIssueTarget(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname.replace(/^www\./, '') !== 'linear.app') return null;
  return issueIdentifier(url.pathname.split('/').filter(Boolean));
}

// Whatever an agent or a person gave for an issue: a link, or an identifier.
export function linearIssueRef(text: string): string | null {
  return normalIdentifier(text) ?? linearIssueTarget(text.trim());
}

// An issue as a link card shows it.
export interface LinearCard {
  identifier: string;
  title: string;
  url: string;
  status: { name: string; kind: string }; // "In Review", and the kind Linear groups it in: started
  assignee: string | null; // by display name
  priority: string; // "High", "No priority"
  team: string; // the team's name
  updatedAt: string;
}

// Why a card can't be shown, in words for the person: the card says it instead.
export interface LinearProblem {
  code: string; // not_connected, needs_sign_in, not_found, rate_limited, unavailable…
  message: string;
}

export type CardAnswer = { card: LinearCard; problem?: undefined } | { card?: undefined; problem: LinearProblem };
