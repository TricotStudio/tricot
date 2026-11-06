// What a Slack address points to: a message in a channel, which may be one in
// a thread (?thread_ts=). Slack's own "Copy link" makes
// https://<workspace>.slack.com/archives/<channel>/p<seconds><microseconds>.
// Browser-safe.

export interface SlackTarget {
  channel: string; // C… (a channel), G… (a private channel) or D… (a direct message)
  ts: string; // the linked message: "1699999999.123456"
  threadTs?: string; // the thread's first message, when the link is to a reply
}

export const SLACK_HOSTS = ['*.slack.com'] as const;

const CHANNEL = /^[CGD][A-Z0-9]{7,14}$/;
const TS = /^\d{10}\.\d{6}$/;
const PERMALINK_TS = /^p(\d{10})(\d{6})$/;
const WORKSPACE = /^[a-z0-9][a-z0-9.-]*$/;
// Slack's own sites on slack.com, which are not a team's workspace.
const NOT_A_WORKSPACE = new Set(['app', 'api', 'files', 'hooks', 'status', 'join', 'edgeapi', 'slackb', 'www']);

// The parts of an /archives/<channel>[/p<ts>] address on a workspace's own host.
function archive(address: string): { url: URL; channel: string; message?: string; more: boolean } | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.replace(/\.$/, '');
  if (!host.endsWith('.slack.com')) return null;
  const workspace = host.slice(0, -'.slack.com'.length);
  if (!WORKSPACE.test(workspace) || NOT_A_WORKSPACE.has(workspace)) return null;
  const [section, channel, message, ...rest] = url.pathname.split('/').filter(Boolean);
  if (section !== 'archives' || !channel || !CHANNEL.test(channel)) return null;
  return { url, channel, message, more: rest.length > 0 };
}

export function slackTarget(address: string): SlackTarget | null {
  const found = archive(address);
  const stamp = PERMALINK_TS.exec(found?.message ?? '');
  if (!found || found.more || !stamp) return null;
  const ts = `${stamp[1]}.${stamp[2]}`;
  const thread = found.url.searchParams.get('thread_ts');
  const threadTs = thread && TS.test(thread) && thread !== ts ? thread : undefined;
  return { channel: found.channel, ts, ...(threadTs ? { threadTs } : {}) };
}

// The thread a link is about, as the server's routes name it: <channel>/<ts of its first message>.
export const threadKey = (target: SlackTarget): string => `${target.channel}/${target.threadTs ?? target.ts}`;

export function parseThreadKey(key: string): { channel: string; ts: string } | null {
  const [channel, ts, ...more] = key.split('/');
  return more.length === 0 && channel && CHANNEL.test(channel) && ts && TS.test(ts) ? { channel, ts } : null;
}

// What a person gives to say which channel to share to: the channel's id, or
// a Slack link to the channel or to a message in it.
export function channelFrom(text: string): string | null {
  const value = text.trim();
  if (CHANNEL.test(value)) return value;
  return archive(value)?.channel ?? null;
}
