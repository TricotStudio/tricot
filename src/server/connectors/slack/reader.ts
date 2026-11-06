// Reading a Slack thread as the signed-in person: the card on a link (its
// first message, who wrote it, how many replies: one cheap call, kept for a
// minute so a board of cards stays within Slack's rate limits) and the whole
// thread for an agent. Names come from users.info, kept for an hour, and are
// only ever asked for the people in the thread. Never posts anything.

import type { SlackThreadCard } from '../../../core/connectors/slack/thread';
import { ConnectorError } from '../oauth';
import { SLACK_CODES, type SlackConnector } from './connector';
import { slackRefusal } from './errors';

interface RawMessage {
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { name?: string };
  text?: string;
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
}

export interface ThreadMessage {
  author: string;
  text: string;
  at: string; // ISO
}

export interface ThreadDetail {
  card: SlackThreadCard;
  messages: ThreadMessage[]; // the first message, then its replies
  more: boolean; // there are replies past these
}

const CARD_TTL = 60_000;
const MISS_TTL = 15_000; // a thread Slack wouldn't show
const NAME_TTL = 60 * 60_000;
const MAX_CACHED = 300;
const PAGE = 100;
const MAX_PAGES = 2;
const MAX_NAMES = 30;
// Errors worth remembering for a few seconds: asking again won't change them.
const STEADY = new Set<string>([SLACK_CODES.notFound, SLACK_CODES.missingScope]);

const dateOf = (ts: string | undefined): string => new Date(Number((ts ?? '0').split('.')[0]) * 1000).toISOString();

// Slack's own markup, as words: <@U1> and <#C1|general> as @name and #general, <url|label> as "label (url)", &amp; as &.
export function plainText(text: string, names: ReadonlyMap<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `@${names.get(id) ?? label ?? id}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<#([CG][A-Z0-9]+)>/g, '#$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]*)>/g, '$1')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<!date\^[^|>]*\|([^>]*)>/g, '$1')
    .replace(/<([a-z][a-z0-9+.-]*:[^|>\s]+)\|([^>]*)>/gi, (_, url: string, label: string) => (label && label !== url ? `${label} (${url})` : url))
    .replace(/<([a-z][a-z0-9+.-]*:[^|>\s]+)>/gi, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const mentionsIn = (text: string | undefined): string[] => [...(text ?? '').matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]);

export class SlackReader {
  private readonly cards = new Map<string, { at: number; card?: SlackThreadCard; error?: ConnectorError }>();
  private readonly lookups = new Map<string, Promise<SlackThreadCard>>();
  private readonly names = new Map<string, { at: number; name: string }>();

  constructor(private readonly slack: SlackConnector) {}

  // What was read for one sign-in isn't for the next (or for none).
  forget(): void {
    this.cards.clear();
    this.names.clear();
  }

  // A thread's card. One look-up per thread at a time, and a minute's rest between.
  async card(channel: string, ts: string, fresh = false): Promise<SlackThreadCard> {
    const key = `${channel}/${ts}`;
    const known = this.cards.get(key);
    if (!fresh && known && this.slack.now() - known.at < (known.error ? MISS_TTL : CARD_TTL)) {
      if (known.error) throw known.error;
      return known.card!;
    }
    const running = this.lookups.get(key);
    if (running) return running;
    const lookup = this.firstMessage(channel, ts)
      .then((card) => {
        this.remember(key, { at: this.slack.now(), card });
        return card;
      })
      .catch((error: unknown) => {
        if (error instanceof ConnectorError && error.code && STEADY.has(error.code)) this.remember(key, { at: this.slack.now(), error });
        throw error;
      })
      .finally(() => this.lookups.delete(key));
    this.lookups.set(key, lookup);
    return lookup;
  }

  private remember(key: string, entry: { at: number; card?: SlackThreadCard; error?: ConnectorError }): void {
    if (this.cards.size >= MAX_CACHED) this.cards.delete(this.cards.keys().next().value!);
    this.cards.set(key, entry);
  }

  private async firstMessage(channel: string, ts: string): Promise<SlackThreadCard> {
    const reply = await this.slack.call('conversations.replies', { channel, ts, limit: '1' });
    if (!reply.ok) throw slackRefusal(reply.error ?? 'unknown', 'read');
    const [root] = (reply.messages as RawMessage[] | undefined) ?? [];
    if (!root) throw slackRefusal('message_not_found', 'read');
    const names = await this.namesFor([root]);
    return this.cardOf(channel, root, names);
  }

  // The whole thread, for an agent: its first message and up to two hundred messages in all.
  async detail(channel: string, ts: string): Promise<ThreadDetail> {
    const raw: RawMessage[] = [];
    let cursor: string | undefined;
    let more = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply = await this.slack.call('conversations.replies', { channel, ts, limit: String(PAGE), ...(cursor ? { cursor } : {}) });
      if (!reply.ok) throw slackRefusal(reply.error ?? 'unknown', 'read');
      raw.push(...(((reply.messages as RawMessage[] | undefined) ?? []).filter((m) => m && typeof m === 'object')));
      const next = (reply.response_metadata as { next_cursor?: string } | undefined)?.next_cursor;
      if (!next) break;
      cursor = next;
      if (page === MAX_PAGES - 1) more = true;
    }
    if (raw.length === 0) throw slackRefusal('message_not_found', 'read');
    const names = await this.namesFor(raw);
    return {
      card: this.cardOf(channel, raw[0], names),
      messages: raw.map((m) => ({ author: this.authorOf(m, names), text: plainText(m.text ?? '', names), at: dateOf(m.ts) })),
      more,
    };
  }

  private cardOf(channel: string, root: RawMessage, names: ReadonlyMap<string, string>): SlackThreadCard {
    return {
      channel,
      ts: root.ts ?? '',
      author: this.authorOf(root, names),
      text: plainText(root.text ?? '', names),
      replies: typeof root.reply_count === 'number' ? root.reply_count : 0,
      postedAt: dateOf(root.ts),
      ...(root.latest_reply ? { latestReplyAt: dateOf(root.latest_reply) } : {}),
    };
  }

  private authorOf(message: RawMessage, names: ReadonlyMap<string, string>): string {
    if (message.user) return names.get(message.user) ?? message.user;
    return message.username ?? message.bot_profile?.name ?? 'An app';
  }

  // The names of the people who wrote the messages and are mentioned in them.
  private async namesFor(messages: RawMessage[]): Promise<Map<string, string>> {
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.user) ids.add(m.user);
      for (const id of mentionsIn(m.text)) ids.add(id);
    }
    const found = await Promise.all([...ids].slice(0, MAX_NAMES).map(async (id) => [id, await this.userName(id)] as const));
    return new Map(found);
  }

  // A person's name as Slack has it; their id when Slack won't say (no users:read, a deleted account).
  private async userName(id: string): Promise<string> {
    const known = this.names.get(id);
    if (known && this.slack.now() - known.at < NAME_TTL) return known.name;
    let name = id;
    try {
      const reply = await this.slack.call('users.info', { user: id });
      const user = reply.ok ? (reply.user as { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } | undefined) : undefined;
      name = user?.profile?.display_name || user?.real_name || user?.profile?.real_name || user?.name || id;
    } catch (error) {
      if (error instanceof ConnectorError && (error.code === SLACK_CODES.needsSignIn || error.code === SLACK_CODES.notConnected)) throw error;
    }
    if (this.names.size >= MAX_CACHED) this.names.delete(this.names.keys().next().value!);
    this.names.set(id, { at: this.slack.now(), name });
    return name;
  }
}
