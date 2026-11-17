import { VIDEO } from './frame';
import type { LinkSourceKind } from './types';

// "90", "1m30s" or "1h2m3s", as YouTube's t= takes them.
function seconds(value: string | null): number {
  const match = value ? /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value) : null;
  if (!match) return 0;
  const [, h = '0', m = '0', s = '0'] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// youtube.com/watch?v=<id>, /shorts/<id>, /live/<id>, /embed/<id> and youtu.be/<id>,
// keeping a start time. Shorts are upright, so they open upright.
export const youtube: LinkSourceKind = {
  id: 'youtube',
  hosts: ['youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'youtu.be'],
  embeds: 'YouTube',
  read(url, parts) {
    const short = parts[0] === 'shorts';
    const id =
      url.hostname.replace(/^www\./, '') === 'youtu.be'
        ? parts[0]
        : parts[0] === 'watch'
          ? url.searchParams.get('v')
          : ['shorts', 'live', 'embed'].includes(parts[0] ?? '')
            ? parts[1]
            : undefined;
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    const start = seconds(url.searchParams.get('t') ?? url.searchParams.get('start'));
    return {
      kind: 'YouTube',
      name: 'YouTube video',
      site: 'YouTube',
      mark: 'youtube',
      embed: {
        url: `https://www.youtube-nocookie.com/embed/${id}${start ? `?start=${start}` : ''}`,
        sandbox: VIDEO,
        allow: 'fullscreen; picture-in-picture; encrypted-media',
        // YouTube's player refuses to start without knowing which site embeds it.
        referrer: 'strict-origin',
        size: short ? { w: 380, h: 700 } : { w: 560, h: 400 },
        blocked: "YouTube won't play this inside the board in this browser. Open it on YouTube.",
      },
    };
  },
};
