// Tricot Studio's own Google sign-in client, shipped with Tricot so people
// just click "Connect Google". Fill in the three values below once, after
// creating the client in Tricot Studio's Google Cloud project (steps in
// docs/configuration.md, "Google sign-in"). Until all of the client's values are
// filled in, Tricot behaves as it did before: it asks people for a client file
// of their own (see findGoogleClient in ./connector.ts).
//
// Google treats a "Desktop app" client as public: its ID and "secret" are meant
// to ship in the app, and what keeps a sign-in safe is PKCE and the loopback
// redirect (127.0.0.1, any port). The Picker's browser API key is public too,
// when restricted to the Google Picker API and to this app's own origins. Even
// so, none of these is ever logged, or sent anywhere but Google.
//
// A client file in the data folder (google-client.json, or the
// client_secret_….json Google downloads) always takes over from this one.

import type { GoogleClient } from './connector';

export interface BuiltInGoogle {
  // The OAuth client of type "Desktop app": its "Client ID" ("<project number>-<random>.apps.googleusercontent.com").
  clientId: string;
  // That client's "Client secret".
  clientSecret: string;
  // An API key (Credentials → Create credentials → API key) restricted to the
  // "Google Picker API" and to the HTTP referrers http://127.0.0.1:*/* and
  // http://localhost:*/*. The Picker is how people choose which Docs Tricot can use.
  pickerApiKey: string;
}

// What a value that hasn't been filled in starts with.
const PLACEHOLDER = 'FILL_IN';
export const CLIENT_ID_SHAPE = /^[\w.-]+\.apps\.googleusercontent\.com$/;
const filled = (value: string) => value !== '' && !value.startsWith(PLACEHOLDER);

export const BUILT_IN_GOOGLE: BuiltInGoogle = {
  clientId: `${PLACEHOLDER}.apps.googleusercontent.com`,
  clientSecret: PLACEHOLDER,
  pickerApiKey: PLACEHOLDER,
};

// The built-in client, once it is filled in: otherwise undefined, as if there
// were none. The secret and the key only count when they are really there.
export function builtInGoogleClient(values: BuiltInGoogle = BUILT_IN_GOOGLE): GoogleClient | undefined {
  const clientId = values.clientId.trim();
  const clientSecret = values.clientSecret.trim();
  const apiKey = values.pickerApiKey.trim();
  if (!filled(clientId) || !CLIENT_ID_SHAPE.test(clientId) || !filled(clientSecret)) return undefined;
  return { source: 'built-in', clientId, clientSecret, ...(filled(apiKey) ? { pickerApiKey: apiKey } : {}) };
}
