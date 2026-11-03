// One Markdown engine for all text on the board, so it reads the same wherever
// it is. Notes, comments, thread messages, a decision's context and a task's
// detail are GitHub-style Markdown: tables, task lists, strikethrough and
// autolinks. A task list's boxes are read-only, except in a note people can
// edit, where ticking one rewrites its line (`onTick`). A table cell or a
// picture's caption is a line of inline Markdown: bold, italics, links, code
// and strikethrough, but no headings, lists or other blocks. Everywhere, raw HTML
// shows as the text it is (react-markdown's way: it is never rendered), links
// open in a new tab, a picture from outside Tricot shows as a link to it (so
// reading a note fetches nothing from another site), and on a board the cards
// a text names (#12, T5) link to them.

import { createContext, useContext, type ComponentProps, type MouseEvent } from 'react';
import Markdown, { type Components, type ExtraProps, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Element, Root } from 'hast';
import { readRef, rehypeRefs } from '../core/refs';
import { RefChip, useRefs } from './refs';

type Plugins = NonNullable<Options['rehypePlugins']>;

// The block constructs a line of inline Markdown goes without: what would
// start a heading, a list, a quote, a table, a code block, a rule or a
// footnote there reads as the text it is ("1. Call Stripe" stays as written).
const BLOCK_CONSTRUCTS = [
  'blockQuote',
  'codeFenced',
  'codeIndented',
  'definition',
  'gfmFootnoteDefinition',
  'headingAtx',
  'htmlFlow',
  'list',
  'setextUnderline',
  'table',
  'thematicBreak',
];

// A remark plugin that turns those off, the way remark-gfm turns its own on.
function remarkInline(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  (data.micromarkExtensions ??= []).push({ disable: { null: BLOCK_CONSTRUCTS } });
}

const FULL: Options['remarkPlugins'] = [remarkGfm];
const INLINE: Options['remarkPlugins'] = [remarkGfm, remarkInline];

// A picture reads as a link to it, by its alt text: in a line of inline
// Markdown always, so it never outgrows the line, and elsewhere unless it is
// one of Tricot's own (`shows`), since showing a picture from another site
// tells that site who is reading the board, and when. A picture that is
// already a link (a badge) reads as that link's words.
function rehypePictureLinks(options: { shows?: (src: string) => boolean } = {}) {
  const walk = (parent: Root | Element, inLink: boolean) => {
    parent.children.forEach((child, i) => {
      if (child.type !== 'element') return;
      if (child.tagName !== 'img') return walk(child, inLink || child.tagName === 'a');
      const src = String(child.properties.src ?? '');
      if (options.shows?.(src)) return;
      const words = { type: 'text' as const, value: String(child.properties.alt ?? '') || src };
      parent.children[i] = inLink ? words : { type: 'element', tagName: 'a', properties: { href: src }, children: [words] };
    });
  };
  return (tree: Root) => walk(tree, false);
}

// Tricot's own pictures: one uploaded to this board's server, or one written
// into the text itself. Neither asks another site for anything.
const isOwnPicture = (src: string) => src.startsWith('/api/assets/') || /^data:/i.test(src);

// Where the pointer last went down on a link: a drag from there selects words
// (to pin them) rather than dragging the link away, and doesn't open it.
let pressedAt = { x: 0, y: 0 };
const press = (e: MouseEvent) => (pressedAt = { x: e.clientX, y: e.clientY });
const dragged = (e: MouseEvent) => e.detail > 0 && Math.abs(e.clientX - pressedAt.x) + Math.abs(e.clientY - pressedAt.y) > 4;

// A footnote's link goes to its note in the same text. The board's address
// is its own, so it scrolls there rather than changing it.
function scrollToNote(e: MouseEvent<HTMLAnchorElement>, id: string) {
  e.preventDefault();
  if (dragged(e)) return;
  e.currentTarget.closest('.md')?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'nearest' });
}

function Link({ node: _node, ...props }: ComponentProps<'a'> & ExtraProps) {
  const ref = readRef((props as Record<string, unknown>)['data-ref']);
  if (ref) return <RefChip {...ref}>{props.children}</RefChip>;
  const href = props.href ?? '';
  if (href.startsWith('#')) return <a {...props} draggable={false} onMouseDown={press} onClick={(e) => scrollToNote(e, href.slice(1))} />;
  return <a {...props} draggable={false} target="_blank" rel="noreferrer" onMouseDown={press} onClick={(e) => dragged(e) && e.preventDefault()} />;
}

const INLINE_COMPONENTS: Components = { p: ({ children }) => <>{children}</> };

// A task list's boxes: each says the line of the text its item starts on (as
// data-task-line), which is the line a tick rewrites, and a ticked item is
// marked done. The line is the parser's own, so a box in a code block, or
// "[ ]" that isn't a box, is never counted as one.
function rehypeTaskLines() {
  const walk = (parent: Root | Element) => {
    for (const child of parent.children) {
      if (child.type !== 'element') continue;
      const classes = child.properties.className;
      if (child.tagName === 'li' && Array.isArray(classes) && classes.includes('task-list-item') && child.position) {
        // Its box opens the item, or the item's first paragraph.
        const first = child.children.find((c) => c.type === 'element');
        const box = first?.tagName === 'input' ? first : first?.tagName === 'p' ? first.children.find((c) => c.type === 'element' && c.tagName === 'input') : undefined;
        if (box?.type === 'element') {
          box.properties.dataTaskLine = child.position.start.line;
          if (box.properties.checked) child.properties.className = [...classes, 'is-done'];
        }
      }
      walk(child);
    }
  };
  return (tree: Root) => walk(tree);
}

// Ticking a box: the line its item starts on, and whether it is now done.
type Tick = (line: number, done: boolean) => void;
const TickContext = createContext<Tick | undefined>(undefined);

// A task list's box: one people tick when the text takes ticks, read-only otherwise.
function TaskBox({ node: _node, ...props }: ComponentProps<'input'> & ExtraProps) {
  const tick = useContext(TickContext);
  const line = Number((props as Record<string, unknown>)['data-task-line']);
  if (!tick || props.type !== 'checkbox' || !line) return <input {...props} />;
  const done = Boolean(props.checked);
  return (
    <input
      type="checkbox"
      className="task-box nodrag"
      checked={done}
      onChange={(e) => tick(line, e.currentTarget.checked)}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  );
}

export type MdProps = { children: string; inline?: boolean; onTick?: Tick } & Pick<Options, 'rehypePlugins' | 'components'>;

// Markdown as the board renders it. `inline` is a line of inline Markdown, in
// a span. `rehypePlugins` and `components` let a caller mark up the rendered
// text, e.g. the canvas drawing pins on a note; they run after the cards a
// text names are linked. `onTick` makes a task list's boxes tickable.
export function Md({ children, inline = false, onTick, rehypePlugins, components }: MdProps) {
  const refs = useRefs();
  const plugins: Plugins = inline ? [rehypePictureLinks] : [rehypeTaskLines, [rehypePictureLinks, { shows: isOwnPicture }]];
  if (refs) plugins.push([rehypeRefs, { known: refs.known }]);
  const markdown = (
    <Markdown
      remarkPlugins={inline ? INLINE : FULL}
      rehypePlugins={[...plugins, ...(rehypePlugins ?? [])]}
      components={{ a: Link, ...(inline ? INLINE_COMPONENTS : { input: TaskBox }), ...components }}
    >
      {children}
    </Markdown>
  );
  if (inline) return <span className="md-inline">{markdown}</span>;
  return (
    <div className="md">
      <TickContext.Provider value={onTick}>{markdown}</TickContext.Provider>
    </div>
  );
}

// A table cell or a caption: one line of inline Markdown.
export function InlineMd(props: Omit<MdProps, 'inline'>) {
  return <Md {...props} inline />;
}
