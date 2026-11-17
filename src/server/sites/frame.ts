// Tricot's frame script: what the site server puts first in each page of a
// website it serves (inject.ts), to run inside the frame the board shows it
// in. It does nothing until Tricot's page asks: only messages from its parent
// window, at Tricot's own origin, are taken (acceptsMessage). Asked, it
//   - in edit mode, outlines the element under the pointer, and a click picks
//     it (a heading, a paragraph, a link…) instead of following it, and
//     describes it to the page: a selector, its tag, its text, and on a page
//     from a folder, the file and line it starts on;
//   - finds the elements pinned on the page again (findElement) and says
//     where they are as the page scrolls, and which it couldn't find;
//   - says when the site's files change, so the page reloads it.
// In browse mode it only says which page is shown, and opens links to other
// sites in a tab of their own.
//
// The script is these functions as written (Function.toString), so each
// reads only its arguments, the browser's globals and the functions before
// it, and is written in JavaScript a browser runs as it is.

import type { PinnedElement } from '../../core/blocks/site/messages';

// What finding an element needs of a page: a stand-in in the tests.
interface Findable {
  tagName: string;
  textContent: string | null;
  innerText?: string;
  getAttribute(name: string): string | null;
}
interface Searchable {
  querySelector(selector: string): Findable | null;
  getElementsByTagName(tag: string): ArrayLike<Findable>;
}

// An element's text as it reads, on one line: a picture's alt text, a field's placeholder.
export function shownText(el: Findable): string {
  const tag = el.tagName.toLowerCase();
  const own = tag === 'img' || tag === 'area' ? el.getAttribute('alt') : tag === 'input' || tag === 'textarea' ? el.getAttribute('placeholder') || el.getAttribute('aria-label') : null;
  const text = own ?? (typeof el.innerText === 'string' ? el.innerText : el.textContent) ?? '';
  return String(text).replace(/\s+/g, ' ').trim();
}

// Whether an element reads as the text a pin kept (which is clipped, with … at its end).
export function readsAs(el: Findable, kept: string): boolean {
  const want = kept.replace(/\s+/g, ' ').trim();
  const text = shownText(el);
  if (!want) return false;
  if (want.endsWith('…')) return text.startsWith(want.slice(0, -1));
  return text === want;
}

// A pinned element on the page now: the one its selector finds, if it is
// still that kind of element and still reads as it did; else one of its kind
// that reads as it did (it moved); else, the selector's, changed in place;
// else none (the pin is lost).
export function findElement(doc: Searchable, pinned: Pick<PinnedElement, 'selector' | 'tag' | 'text'>): Findable | null {
  let bySelector: Findable | null = null;
  try {
    bySelector = doc.querySelector(pinned.selector);
  } catch {
    bySelector = null;
  }
  if (bySelector && bySelector.tagName.toLowerCase() !== pinned.tag) bySelector = null;
  if (bySelector && (!pinned.text || readsAs(bySelector, pinned.text))) return bySelector;
  if (pinned.text) {
    const all = doc.getElementsByTagName(pinned.tag);
    for (let i = 0; i < all.length; i++) if (readsAs(all[i], pinned.text)) return all[i];
  }
  return bySelector;
}

// Whether the frame takes a message: from its parent window, at one of Tricot's origins, and Tricot's.
export function acceptsMessage(event: { source: unknown; origin: string; data: unknown }, parentWindow: unknown, origins: readonly string[]): boolean {
  const data = event.data as { tricot?: unknown } | null;
  return event.source === parentWindow && origins.includes(event.origin) && Boolean(data) && typeof data === 'object' && data!.tricot === 'site';
}

// A selector that finds the element: its id when the page has one such (and
// it is a plain one: letters, digits, _ and -, starting with a letter), or a
// short path to it from the nearest ancestor that has one, or from body. It
// is all core/blocks/site/site.ts isSelector takes.
function selectorFor(el: Element): string {
  const parts: string[] = [];
  for (let node: Element | null = el; node && node !== document.documentElement; node = node.parentElement) {
    if (node.id && /^[A-Za-z][\w-]{0,99}$/.test(node.id) && document.querySelectorAll(`#${node.id}`).length === 1) {
      parts.unshift(`#${node.id}`);
      return parts.join(' > ');
    }
    if (node === document.body) {
      parts.unshift('body');
      return parts.join(' > ');
    }
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    const kin = parent ? Array.from(parent.children).filter((c) => c.tagName === node!.tagName) : [node];
    parts.unshift(kin.length > 1 ? `${tag}:nth-of-type(${kin.indexOf(node) + 1})` : tag);
  }
  return parts.join(' > ');
}

// The element a click means: the nearest one a person would name (a heading,
// not the span in it; a link; a picture, not a path in it), or the one clicked.
function pickable(target: Element | null): Element | null {
  const named = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'a', 'button', 'img', 'picture', 'video', 'li', 'blockquote', 'figcaption', 'label', 'input', 'textarea', 'select', 'td', 'th', 'pre', 'dt', 'dd', 'summary', 'figure'];
  if (!target || target === document.body || target === document.documentElement) return null;
  const svg = target.closest('svg');
  if (svg) return svg.closest('a, button') ?? svg;
  for (let node: Element | null = target; node && node !== document.body; node = node.parentElement) {
    if (named.includes(node.tagName.toLowerCase())) return node;
  }
  return target;
}

// The script's own part, run once in the frame.
function tricotFrame(config: { origins: string[] }): void {
  if (window.parent === window) return; // opened in a tab of its own: nothing to do
  const origins = config.origins;
  const script = document.currentScript as HTMLScriptElement | null;
  const file = script?.dataset.tricotFile || '';
  const page = () => location.pathname + location.search; // the site is at its origin's root

  // Told to Tricot's page at its own origin: the one the browser says framed
  // this page, if it is Tricot's, or each of Tricot's (all but one are dropped).
  const framedBy = location.ancestorOrigins?.[0];
  const to = framedBy && origins.includes(framedBy) ? [framedBy] : origins;
  const send = (message: Record<string, unknown>) => {
    for (const origin of to) window.parent.postMessage({ ...message, tricot: 'site' }, origin);
  };
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };

  let editing = false;
  let changes: EventSource | null = null;
  let pinned: PinnedElement[] = [];
  let found = new Map<string, Element>();
  let chosen: Element | null = null;
  let hovered: Element | null = null;

  // Outlines, drawn over the page: the element under the pointer, and the one being asked about.
  const outline = (color: string, fill: string, dashed: boolean) => {
    const box = document.createElement('div');
    box.setAttribute('data-tricot', '');
    box.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;display:none;box-sizing:border-box;border-radius:3px;border:2px ${dashed ? 'dashed' : 'solid'} ${color};background:${fill};transition:all .08s ease-out`;
    document.documentElement.appendChild(box);
    return box;
  };
  let hoverBox: HTMLDivElement | null = null;
  let chosenBox: HTMLDivElement | null = null;
  const place = (box: HTMLDivElement | null, el: Element | null) => {
    if (!box) return;
    if (!el || !el.isConnected) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
  };

  let queued = false;
  const report = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      place(hoverBox, editing ? hovered : null);
      place(chosenBox, chosen);
      if (!pinned.length && !chosen) return;
      const pins: Record<string, unknown> = {};
      for (const p of pinned) {
        const el = found.get(p.id);
        pins[p.id] = el && el.isConnected ? rectOf(el) : null;
      }
      send({ type: 'rects', pins, chosen: chosen && chosen.isConnected ? rectOf(chosen) : null, scrollY: Math.round(window.scrollY) });
    });
  };

  const findAll = () => {
    found = new Map();
    for (const p of pinned) {
      const el = findElement(document as unknown as Searchable, p) as Element | null;
      if (el) found.set(p.id, el);
    }
    send({ type: 'found', page: page(), found: pinned.filter((p) => found.has(p.id)).map((p) => p.id), lost: pinned.filter((p) => !found.has(p.id)).map((p) => p.id) });
    report();
  };
  // A page that draws itself after it loads: what it draws may be what was pinned.
  let refind: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver((records) => {
    if (!pinned.length || records.every((r) => (r.target as Element).hasAttribute?.('data-tricot'))) return;
    clearTimeout(refind);
    refind = setTimeout(findAll, 400);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  const describe = (el: Element) => {
    const at = el.closest(`[data-tricot-line]`);
    const line = Number(at?.getAttribute('data-tricot-line'));
    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: shownText(el as unknown as Findable).slice(0, 400),
      ...(file ? { file } : {}),
      ...(file && line > 0 ? { line } : {}),
      rect: rectOf(el),
    };
  };

  const ours = (target: EventTarget | null) => target instanceof Element && target.hasAttribute('data-tricot');
  document.addEventListener(
    'mouseover',
    (e) => {
      if (!editing || ours(e.target)) return;
      hovered = pickable(e.target as Element);
      report();
    },
    true,
  );
  document.addEventListener(
    'mouseleave',
    () => {
      hovered = null;
      report();
    },
    true,
  );
  // In edit mode a click picks; nothing on the page follows it.
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'pointerup', 'dblclick', 'auxclick', 'submit']) {
    document.addEventListener(
      type,
      (e) => {
        if (!editing) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
  }
  document.addEventListener(
    'click',
    (e) => {
      if (editing) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const el = pickable(e.target as Element);
        if (!el) return;
        chosen = el;
        send({ type: 'select', element: describe(el) });
        report();
        return;
      }
      // Browsing: a link to another site opens in a tab of its own, as the frame can't show it.
      const link = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!link || e.defaultPrevented) return;
      let to: URL;
      try {
        to = new URL(link.href, location.href);
      } catch {
        return;
      }
      if ((to.protocol === 'http:' || to.protocol === 'https:') && to.origin !== location.origin) {
        e.preventDefault();
        window.open(to.href, '_blank', 'noopener');
      }
    },
    true,
  );
  window.addEventListener('scroll', report, { capture: true, passive: true });
  window.addEventListener('resize', report);

  window.addEventListener('message', (e) => {
    if (!acceptsMessage(e, window.parent, origins)) return;
    const m = e.data as { type: string; edit?: boolean; pins?: PinnedElement[]; selector?: string | null; y?: number; id?: string };
    if (m.type === 'mode') {
      editing = Boolean(m.edit);
      hoverBox ??= outline('rgba(31,35,40,.75)', 'rgba(31,35,40,.04)', true);
      chosenBox ??= outline('#d97706', 'rgba(217,119,6,.12)', false);
      document.documentElement.style.cursor = editing ? 'crosshair' : '';
      if (!editing) hovered = null;
      report();
    } else if (m.type === 'pins' && Array.isArray(m.pins)) {
      pinned = m.pins.slice(0, 500);
      findAll();
    } else if (m.type === 'choose') {
      chosen = null;
      if (m.selector) {
        try {
          chosen = document.querySelector(m.selector);
        } catch {
          chosen = null;
        }
      }
      chosenBox ??= outline('#d97706', 'rgba(217,119,6,.12)', false);
      report();
    } else if (m.type === 'scrollTo' && typeof m.y === 'number') {
      window.scrollTo(0, m.y);
      report();
    } else if (m.type === 'reveal' && m.id) {
      found.get(m.id)?.scrollIntoView({ block: 'center' });
      report();
    } else if (m.type === 'watch' && !changes) {
      // One stream a page: asked again, it is already listening.
      changes = new EventSource('/__tricot/changes');
      changes.addEventListener('change', () => send({ type: 'changed', scrollY: Math.round(window.scrollY) }));
    }
  });

  // Which page is shown: once it is read, once it has loaded (its title may
  // come late), and as a single-page app moves.
  let said = '';
  const ready = () => {
    const now = `${page()}\n${document.title}`;
    if (now === said) return;
    said = now;
    send({ type: 'ready', page: page(), title: document.title, scrollY: Math.round(window.scrollY) });
  };
  for (const name of ['pushState', 'replaceState'] as const) {
    const was = history[name];
    history[name] = function (this: History, ...args: Parameters<History['pushState']>) {
      const result = was.apply(this, args);
      setTimeout(ready, 0);
      return result;
    };
  }
  window.addEventListener('popstate', () => setTimeout(ready, 0));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
  window.addEventListener('load', ready);
}

// The script, as served, for a Tricot whose page is at these origins.
export function frameScript(origins: readonly string[]): string {
  const parts = [shownText, readsAs, findElement, acceptsMessage, selectorFor, pickable].map((fn) => fn.toString());
  // A build that keeps function names wraps them in __name(), which this script has no need of.
  return `(function () {\nvar __name = function (fn) { return fn; };\n${parts.join('\n')}\n(${tricotFrame.toString()})(${JSON.stringify({ origins })});\n})();\n`;
}
