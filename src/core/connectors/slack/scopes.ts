// What Tricot asks Slack for, one line each. These are Slack's "user scopes":
// they act as the person who signs in, and a desktop sign-in may not ask for
// bot scopes at all. Four is all it takes to read the threads people link and
// to post a decision the person chooses to share.

export const CHANNELS_HISTORY = 'channels:history';
export const GROUPS_HISTORY = 'groups:history';
export const USERS_READ = 'users:read';
export const CHAT_WRITE = 'chat:write';

export const SLACK_SCOPES = [CHANNELS_HISTORY, GROUPS_HISTORY, USERS_READ, CHAT_WRITE];
