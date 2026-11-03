// Google as a connector (core half, browser-safe): who it is, what its
// sign-in asks for in plain words, the links it recognises, and where a pin on
// a doc's paragraph is. What only the server needs of it is in server.ts,
// which the web build leaves out (see vite.config.ts). Signing in, reading
// and editing Docs, its routes and tools are in server/connectors/google/.

import type { ConnectorKind } from '../connector';
import { placeDocPin } from './place';
import { DOCS_SCOPE, DRIVE_FILE, DRIVE_METADATA, USERINFO_EMAIL } from './scopes';
import { server } from './server';
import { googleSources } from './sources';

export const google: ConnectorKind = {
  id: 'google',
  name: 'Google',
  // Google answers "email" with its long form, so both are here.
  scopes: {
    openid: { label: 'Know which Google account you signed in with', agent: 'account' },
    email: { label: 'See your email address', agent: 'email address' },
    [USERINFO_EMAIL]: { label: 'See your email address', agent: 'email address' },
    [DRIVE_FILE]: {
      label: 'See and edit the Google Docs you choose, and only those',
      agent: 'Google Docs people choose',
    },
    // What earlier sign-ins were given.
    [DRIVE_METADATA]: {
      label: 'See the names of your Drive files and when they were last edited',
      agent: 'Drive file names and dates',
    },
    [DOCS_SCOPE]: { label: 'See and edit your Google Docs', agent: 'Google Docs, read and write' },
  },
  identity: { scopes: ['openid', 'email', USERINFO_EMAIL], email: ['email', USERINFO_EMAIL] },
  sources: [googleSources],
  pins: {
    kind: 'doc',
    place: placeDocPin,
    anchor: server.pins?.anchor,
    where: server.pins?.where,
    label: server.pins?.label,
    missing: server.pins?.missing,
    seen: server.pins?.seen,
    ask: server.pins?.ask,
  },
  agent: server.agent,
  link: server.link,
  store: server.store,
};
