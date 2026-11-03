// Tricot Studio's GitHub App, as shipped. A GitHub App's client ID is public
// and device flow needs no client secret or private key, so there is nothing
// secret here. The app asks for read-only access to Contents, Pull requests,
// Issues, Checks and Commit statuses, user tokens that don't expire, and has
// no webhooks.

// "Client ID" on the app's settings page.
export const GITHUB_CLIENT_ID = 'Iv23liQurRHDXSmvZAzP';

// The app's public link is github.com/apps/<slug>. Someone running Tricot with
// an app of their own sets both values; while the slug isn't a real one
// (the placeholder), Tricot can't link straight to the app's install page and
// offers GitHub's general installations page instead.
export const GITHUB_APP_SLUG = 'tricot-by-tricot-studio';

export const GITHUB_ENDPOINTS = { web: 'https://github.com', api: 'https://api.github.com' };
export type GithubEndpoints = typeof GITHUB_ENDPOINTS;

export const MANAGE_INSTALLATIONS_URL = 'https://github.com/settings/installations';

const SLUG_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/; // the placeholder FILL_IN has an underscore

// Where a person installs the app on their repos, or undefined while the slug is a placeholder.
export function installUrl(slug: string): string | undefined {
  return SLUG_SHAPE.test(slug) ? `https://github.com/apps/${slug}/installations/new` : undefined;
}
