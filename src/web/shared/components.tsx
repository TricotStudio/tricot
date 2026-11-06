import { useCallback, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Actor, Status } from '../../core/types';
import { useDismiss } from './hooks';

export const STATUS_META: Record<Status, { label: string; hint: string }> = {
  open: { label: 'Open', hint: 'Waiting on you' },
  exploring: { label: 'Exploring', hint: 'Agents gathering evidence' },
  provisional: { label: 'Provisional', hint: 'Agents proceed; easy to change' },
  decided: { label: 'Decided', hint: 'Binding' },
  deferred: { label: 'Deferred', hint: 'Not now' },
  retired: { label: 'Retired', hint: 'No longer relevant' },
};

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// When something was last seen: timeAgo, but "yesterday" for a day ago.
export function seenAgo(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3_600_000;
  return hours >= 24 && hours < 48 ? 'yesterday' : timeAgo(iso);
}

// One stroke family for every icon in the UI: 16px grid, 1.5 stroke, round joins.
const ICONS = {
  'arrow-right': <path d="M3 8h10M9 4l4 4-4 4" />,
  'arrow-left': <path d="M13 8H3M7 4 3 8l4 4" />,
  'arrow-up': <path d="M8 13V3M4 7l4-4 4 4" />,
  'arrow-up-left': <path d="M11.5 11.5 4.5 4.5M4.5 10V4.5H10" />,
  'chevron-down': <path d="m4.5 6.25 3.5 3.5 3.5-3.5" />,
  external: <path d="M7 4.5H4.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V9M9.5 3.5h3v3M12.5 3.5l-5 5" />,
  plus: <path d="M8 3v10M3 8h10" />,
  x: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  edit: <path d="M3 13l.6-2.7 7-7a1.45 1.45 0 0 1 2.1 2.1l-7 7ZM9.4 4.6l2 2" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  sync: <path d="M2.75 7.25A5.3 5.3 0 0 1 12.4 5M12.75 2.25V5H10M13.25 8.75A5.3 5.3 0 0 1 3.6 11M3.25 13.75V11H6" />,
  bell: <path d="M4 11.5h8l-1-1.5V7a3 3 0 0 0-6 0v3l-1 1.5ZM6.8 13.5a1.3 1.3 0 0 0 2.4 0" />,
  search: <path d="M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM10.25 10.25 13.5 13.5" />,
  canvas: <path d="M3.75 2.75h8.5a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-8.5a1 1 0 0 1 1-1ZM5.5 5.5h2.25v2.25H5.5ZM8.5 9h2v1.5h-2Z" />,
  comment: <path d="M3 4.25c0-.7.55-1.25 1.25-1.25h7.5c.7 0 1.25.55 1.25 1.25v5.5c0 .7-.55 1.25-1.25 1.25H7.5L4.75 13.25V11h-.5C3.55 11 3 10.45 3 9.75Z" />,
  more: <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2.2" />,
  details: <path d="M3 4.5h10M3 8h10M3 11.5h6" />,
  archive: <path d="M2.5 3.5h11v3h-11ZM3.5 6.5v6h9v-6M6.5 9h3" />,
  link: (
    <path d="M6.7 9.3a2.9 2.9 0 0 0 4.1 0l2.2-2.2a2.9 2.9 0 0 0-4.1-4.1l-.9.9M9.3 6.7a2.9 2.9 0 0 0-4.1 0L3 8.9A2.9 2.9 0 0 0 7.1 13l.9-.9" />
  ),
  partly: (
    <>
      <circle cx="8" cy="8" r="5" />
      <path d="M8 3a5 5 0 0 1 0 10Z" fill="currentColor" stroke="none" />
    </>
  ),
  star: (
    <path
      d="m8 2 1.8 3.7 4 .6-2.9 2.8.7 4L8 11.2 4.4 13.1l.7-4-2.9-2.8 4-.6Z"
      fill="currentColor"
      strokeWidth="1"
    />
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.06 1.06M11.54 11.54l1.06 1.06M3.4 12.6l1.06-1.06M11.54 4.46l1.06-1.06" />
    </>
  ),
  moon: <path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1Z" />,
  // The plug, its cord a thread with a loop in it: connecting an agent. The
  // break is where the thread passes under itself.
  'knitted-plug': (
    <path d="M6.25 1.5v2.25M9.75 1.5v2.25M4.75 3.75h6.5v1.5a3.25 3.25 0 0 1-6.5 0ZM8 8.5v1.75c0 3.35 3.4 3.75 3.6 1.35.09-.9-.39-1.44-1.09-1.57M6.16 12.85c-1.05.84-2.36 1.43-3.91 1.4" />
  ),
  // A spool of thread, for the board's threads.
  thread: (
    <path d="M4.5 1.75h7a1 1 0 0 1 0 2h-7a1 1 0 0 1 0-2ZM4.5 12.25h7a1 1 0 0 1 0 2h-7a1 1 0 0 1 0-2ZM5.25 3.75v8.5M10.75 3.75v8.5M5.25 6.25l5.5-1.25M5.25 8.75l5.5-1.25M5.25 11.25l5.5-1.25M10.75 8.5c.9 0 1.2.8 2 .8.55 0 .9-.35 1.1-.7" />
  ),
  // A smiley with a small plus, for adding a reaction to a comment.
  react: (
    <>
      <path d="M10.9 5.6A5 5 0 1 0 12 9" />
      <path d="M5 10.6a2.6 2.6 0 0 0 4 0" />
      <path d="M5.3 7.6h.01M8.7 7.6h.01" strokeWidth="2" />
      <path d="M13 1.75v3.5M11.25 3.5h3.5" />
    </>
  ),
  // A globe, for a website on the canvas.
  globe: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c1.55 1.5 2.35 3.35 2.35 5.5S9.55 12 8 13.5C6.45 12 5.65 10.15 5.65 8S6.45 4 8 2.5Z" />
    </>
  ),
  // A screen and a phone, for the width a website is shown at.
  desktop: <path d="M2.75 3h10.5a.75.75 0 0 1 .75.75v6.5a.75.75 0 0 1-.75.75H2.75a.75.75 0 0 1-.75-.75v-6.5A.75.75 0 0 1 2.75 3ZM5.75 13.5h4.5M8 11v2.5" />,
  phone: <path d="M5.25 1.75h5.5a1 1 0 0 1 1 1v10.5a1 1 0 0 1-1 1h-5.5a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1ZM7.25 12h1.5" />,
  // Two bars, for an agent paused until you give it your OK.
  pause: <path d="M6 4v8M10 4v8" />,
  // A bin, for deleting a thread.
  trash: <path d="M3 4.5h10M6.25 4.5V3.25h3.5V4.5M4.5 4.5l.55 8.1a1 1 0 0 0 1 .9h3.9a1 1 0 0 0 1-.9l.55-8.1M6.75 7v4M9.25 7v4" />,
  // Pieces of a canvas in their full view: code, a note, a diagram, an image.
  code: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" />,
  note: <path d="M4 2.5h5.25L12 5.25v8.25H4ZM9 2.75V5.5h2.75M6 8.5h4M6 11h2.5" />,
  diagram: (
    <>
      <rect x="2" y="2.5" width="5" height="4" rx="1" />
      <rect x="9" y="9.5" width="5" height="4" rx="1" />
      <path d="M4.5 6.5v3.5a1.5 1.5 0 0 0 1.5 1.5h3" />
    </>
  ),
  image: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <circle cx="5.75" cy="6.5" r="1.1" />
      <path d="m2.5 12 3.5-3.5 2.5 2.5 2-2 3 3" />
    </>
  ),
  // …and a table, a chart, a 3D scene.
  table: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6h12M2 9.75h12M6.5 6v7.5" />
    </>
  ),
  chart: <path d="M2.5 13.5h11M4.5 13.5V9M8 13.5V4.5M11.5 13.5V7" />,
  scene: <path d="M8 1.75 13.5 4.75v6.5L8 14.25 2.5 11.25v-6.5ZM2.5 4.75 8 7.75l5.5-3M8 7.75v6.5" />,
} satisfies Record<string, ReactNode>;

export function Icon({ name, className }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

function hue(name: string): number {
  let h = 0;
  for (const char of name) h = (h * 31 + char.charCodeAt(0)) % 360;
  return h;
}

// Humans get a tinted circle, agents a neutral square; both show an initial.
export function ActorBadge({ actor, showName = true, title }: { actor: Actor; showName?: boolean; title?: string }) {
  const style = actor.kind === 'human' ? ({ '--hue': hue(actor.name) } as CSSProperties) : undefined;
  return (
    <span className={`actor actor-${actor.kind}`} title={title ?? `${actor.name} (${actor.kind})`}>
      <span className="actor-mark" style={style} aria-hidden>
        {actor.name.charAt(0).toUpperCase()}
      </span>
      {showName && <span className="actor-name">{actor.name}</span>}
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  return <span className={`status status-${status}`}>{STATUS_META[status].label}</span>;
}

// The board's one Markdown engine (markdown.tsx), from here as it always was.
export { InlineMd, Md } from './markdown';

// A command or a config entry, with Copy: the Connect panel's, and Home's first run's (firstRun.tsx).
export function CopyLine({ text, block }: { text: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; the text stays selectable.
    }
  };
  return (
    <div className={block ? 'copyline is-block' : 'copyline'}>
      <code>{text}</code>
      <button className="btn btn-quiet btn-small" onClick={copy}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

// A <details> popover: its <summary>, then a .popover-body. A browser leaves
// one open until its summary is clicked again; this one also closes on a
// click outside it or on Escape, as the other panels do (useDismiss).
export function Popover({ className, children }: { className?: string; children: ReactNode }) {
  const root = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    const details = root.current;
    if (!details) return;
    details.open = false;
    if (details.contains(document.activeElement)) details.querySelector('summary')?.focus();
  }, []);
  useDismiss(open, close, root);
  return (
    <details ref={root} className={className ? `popover ${className}` : 'popover'} onToggle={(e) => setOpen(e.currentTarget.open)}>
      {children}
    </details>
  );
}

// The board mark: a lattice of two threads each way, woven over and under
// where they cross and turned onto the diagonal, with a small square (a
// diamond, once turned) at its heart. One colour, the text colour, in both
// themes. Drawn on a 16px grid, like the favicon in index.html.
export function BoardMark({ size }: { size: number }) {
  return (
    <svg className="board-mark" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <g transform="rotate(45 8 8)">
        <path
          d="M1.5 5H9.25M12.75 5H14.5M1.5 11H3.25M6.75 11H14.5M5 1.5V3.25M5 6.75V14.5M11 1.5V9.25M11 12.75V14.5"
          fill="none"
          stroke="var(--text)"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <rect x="6.75" y="6.75" width="2.5" height="2.5" rx="0.5" fill="var(--text)" />
      </g>
    </svg>
  );
}

// The mark, then the name in Cal Sans (bundled in fonts/).
export function Wordmark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-lockup${small ? ' brand-lockup-small' : ''}`}>
      <BoardMark size={small ? 22 : 30} />
      <span className="brand-text">
        <span className="wordmark">Tricot</span>
      </span>
    </span>
  );
}
