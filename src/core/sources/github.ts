import type { LinkSourceKind } from './types';

// GitHub's own pages, which sit where an owner would.
const GITHUB_PAGES = new Set([
  'about', 'apps', 'codespaces', 'collections', 'customer-stories', 'enterprise', 'explore', 'features', 'issues',
  'login', 'marketplace', 'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'search', 'settings',
  'sponsors', 'topics', 'trending',
]);

// github.com/<owner>/<repo>/pull/<n>, /issues/<n>, or the repository itself.
// GitHub's pages refuse to be framed, so these open in a new tab only.
export const github: LinkSourceKind = {
  id: 'github',
  hosts: ['github.com'],
  read(_url, parts) {
    const [owner = '', name = '', section, number] = parts;
    const repo = name.replace(/\.git$/, '');
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner) || GITHUB_PAGES.has(owner.toLowerCase())) return null;
    if (!/^[\w.-]+$/.test(repo) || repo === '.' || repo === '..') return null;
    const full = `${owner}/${repo}`;
    const numbered = number !== undefined && /^\d+$/.test(number);
    if (numbered && (section === 'pull' || section === 'issues')) {
      const ref = `${full} #${number}`;
      const pull = section === 'pull';
      const mark = pull ? 'github-pull' : 'github-issue';
      return { kind: 'GitHub', what: pull ? 'pull request' : 'issue', ref, name: ref, site: 'GitHub', mark };
    }
    const what = section ? undefined : 'repository';
    return { kind: 'GitHub', what, ref: full, name: full, site: 'GitHub', mark: 'github-repo' };
  },
};
