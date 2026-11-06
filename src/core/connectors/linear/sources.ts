// The Linear links Tricot recognises: an issue, linear.app/<workspace>/issue/ENG-123,
// from the address alone (the server never fetches pages, #27). Any other Linear
// page keeps the plain Linear icon its site has (web/canvas/sources/sites.tsx).

import type { LinkSourceKind } from '../../sources/types';
import { issueIdentifier } from './issue';

// Room for the card's row under its title: status, assignee and priority.
const CARD = { w: 400, h: 100 };

export const linearSources: LinkSourceKind = {
  id: 'linear',
  hosts: ['linear.app'],
  read(_url, parts) {
    const identifier = issueIdentifier(parts);
    if (!identifier) return null;
    return { kind: 'Linear', what: 'issue', ref: identifier, name: identifier, site: 'Linear', mark: 'linear', fileId: identifier, card: CARD };
  },
};
