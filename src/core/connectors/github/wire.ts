// What GitHub's REST routes send the web UI besides cards (card.ts). Browser-safe.

import type { ConnectorStatus } from '../connector';

// The code a person types on github.com while Tricot waits.
export interface DeviceView {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  interval: number; // seconds between checks
}

export type PollOutcome =
  | { state: 'pending'; interval: number }
  | { state: 'connected'; connector: ConnectorStatus }
  | { state: 'expired' | 'denied'; message: string };

export interface Repo {
  fullName: string;
  private: boolean;
}

export interface RepoList {
  via: 'device' | 'token';
  repos: Repo[];
  truncated: boolean;
  installations: { account: string; selection: 'all' | 'selected' }[]; // the app's installations (device sign-in)
  installUrl?: string; // where to install the app on more repos, when its public link is known
  manageUrl: string;
}
