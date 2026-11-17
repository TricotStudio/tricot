// Tricot Studio's own Slack app, as shipped, and the client a person may bring
// instead. Slack's sign-in for desktop apps (OAuth v2 with PKCE) needs no
// client secret: only the app's Client ID, which is public. Nothing secret is
// kept here, and none is ever read from a person's file or sent to Slack.
//
// Fill in the Client ID below once, after creating Tricot Studio's Slack app
// (steps in docs/configuration.md, "Slack sign-in"). Until it is filled in, the
// connector says it isn't set up, and a person who runs Tricot can use an app
// of their own by putting its Client ID in slack-client.json in the data
// folder, which always takes over from this one.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface SlackEndpoints {
  auth: string; // the consent page
  api: string; // the Web API's base: oauth.v2.access, auth.test, conversations.replies, chat.postMessage…
}

export const SLACK_ENDPOINTS: SlackEndpoints = {
  auth: 'https://slack.com/oauth/v2/authorize',
  api: 'https://slack.com/api',
};

export interface BuiltInSlack {
  // The app's "Client ID" (Basic Information → App Credentials): digits, a dot, digits.
  clientId: string;
}

// What a value that hasn't been filled in starts with.
const PLACEHOLDER = 'FILL_IN';
export const CLIENT_ID_SHAPE = /^\d{6,}\.\d{6,}$/;

export const BUILT_IN_SLACK: BuiltInSlack = { clientId: PLACEHOLDER };

export const CLIENT_FILE = 'slack-client.json';

export interface SlackClient {
  source: 'built-in' | 'file';
  clientId: string;
  file?: string; // a person's own client: its name in the data folder
}

// `none`: there is no client file in the data folder (so the built-in client
// may stand in). A file that is there but can't be used says why, and is not
// stood in for.
export type ClientLookup = { client: SlackClient } | { missing: true; problem: string; file?: string; none?: true };

// The built-in client, once its Client ID is filled in: otherwise undefined, as if there were none.
export function builtInSlackClient(values: BuiltInSlack = BUILT_IN_SLACK): SlackClient | undefined {
  const clientId = values.clientId.trim();
  return CLIENT_ID_SHAPE.test(clientId) ? { source: 'built-in', clientId } : undefined;
}

// slack-client.json in the data folder: {"client_id": "123456.7890123"}.
export function findSlackClient(dataDir: string): ClientLookup {
  let text: string;
  try {
    text = readFileSync(path.join(dataDir, CLIENT_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true, none: true, problem: `No ${CLIENT_FILE} in the data folder yet.` };
    return { missing: true, file: CLIENT_FILE, problem: `${CLIENT_FILE} can't be read.` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { missing: true, file: CLIENT_FILE, problem: `${CLIENT_FILE} can't be read as JSON. It holds {"client_id": "123456.7890123"}.` };
  }
  const clientId = data && typeof data === 'object' ? (data as Record<string, unknown>).client_id : undefined;
  if (typeof clientId !== 'string' || !CLIENT_ID_SHAPE.test(clientId.trim())) {
    return { missing: true, file: CLIENT_FILE, problem: `${CLIENT_FILE} has no valid client_id: the app's Client ID, digits, a dot, digits (Basic Information on api.slack.com/apps).` };
  }
  return { client: { source: 'file', clientId: clientId.trim(), file: CLIENT_FILE } };
}

// The client that signs in: the one in the data folder, if there is one, else the one shipped with Tricot (once filled in).
export function resolveSlackClient(dataDir: string, builtIn?: SlackClient): ClientLookup {
  const lookup = findSlackClient(dataDir);
  if ('client' in lookup || !lookup.none || !builtIn) return lookup;
  return { client: builtIn };
}
