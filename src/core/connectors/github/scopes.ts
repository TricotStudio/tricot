// What the GitHub App is allowed to read, one line each. A GitHub App has no
// OAuth scopes: these are its repository permissions, all read-only, named
// here so the Connectors page and agents can say them in plain words.

export const CONTENTS = 'github:contents';
export const PULL_REQUESTS = 'github:pull_requests';
export const ISSUES = 'github:issues';
export const CHECKS = 'github:checks';

export const GITHUB_PERMISSIONS = [CONTENTS, PULL_REQUESTS, ISSUES, CHECKS];
