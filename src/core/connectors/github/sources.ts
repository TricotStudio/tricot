// GitHub's links, as GitHub's own recogniser reads them (core/sources/github.ts),
// with a pull request's or issue's id on top, so a card can show it live once
// GitHub is connected.

import { github } from '../../sources/github';
import type { LinkSourceKind } from '../../sources/types';
import { cardKey, githubTarget } from './link';

// Room for the card's row under its title: state, author and checks, or a file's button.
const CARD = { w: 400, h: 100 };

export const githubSources: LinkSourceKind = {
  id: 'github',
  hosts: github.hosts,
  read(url, parts) {
    const found = github.read(url, parts);
    if (!found) return null;
    const target = githubTarget(url.href);
    if (!target) return found;
    // A file's card is named by its path.
    if (target.kind === 'file') return { ...found, name: target.refPath.slice(1).join('/') || found.name };
    return { ...found, fileId: cardKey(target), card: CARD };
  },
};
