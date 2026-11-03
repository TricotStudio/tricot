import { useEffect, useRef, useState } from 'react';
import type { Embed } from '../../../../core/sources';
import { Icon } from '../../../components';

// Embeds that refuse to show (Google signed out, third-party cookies blocked)
// can't be read from outside the frame, so the view says how to get there
// under the frame, and after a while without loading says why plainly.
const LOAD_TIMEOUT = 12_000;

export function LinkFrame(props: { embed: Embed; url: string; site: string; title: string }) {
  const { embed, url, site, title } = props;
  const [state, setState] = useState<'loading' | 'loaded' | 'slow'>('loading');
  const [attempt, setAttempt] = useState(0);
  const stage = useRef<HTMLDivElement>(null);

  // The frame loads lazily, so the wait starts once it is on screen.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    setState('loading');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || timer) return;
      timer = setTimeout(() => setState((now) => (now === 'loading' ? 'slow' : now)), LOAD_TIMEOUT);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [embed.url, attempt]);

  const openThere = (
    <a className="btn btn-small" href={url} target="_blank" rel="noreferrer">
      Open in {site}
      <Icon name="external" />
    </a>
  );
  return (
    <div className="link-frame nodrag nowheel">
      <div className={`link-frame-stage is-${state}`} ref={stage}>
        {state === 'loading' && <span className="link-frame-wait">Loading from {site}…</span>}
        <iframe
          key={attempt}
          src={embed.url}
          title={title}
          sandbox={embed.sandbox}
          allow={embed.allow}
          allowFullScreen={embed.allow?.includes('fullscreen')}
          referrerPolicy={embed.referrer}
          loading="lazy"
          onLoad={() => setState('loaded')}
        />
        {state === 'slow' && (
          <div className="link-frame-note" role="status">
            <div className="link-frame-banner">
              <p>{embed.blocked}</p>
              <div className="row">
                {openThere}
                <button className="btn btn-small btn-quiet" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <p className="link-frame-help">
        Doesn't load?{' '}
        <a href={url} target="_blank" rel="noreferrer">
          Open in {site}
        </a>
      </p>
    </div>
  );
}
