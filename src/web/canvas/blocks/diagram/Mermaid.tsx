import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTheme, type ThemeBase } from '../../../themes';
import { mermaidConfig } from './mermaidConfig';

type MermaidApi = typeof import('mermaid').default;

// Mermaid is large, so it loads on first use. Renders are queued because
// concurrent mermaid.render calls interfere with each other, and so that a
// theme switch between renders can't apply mid-render.
let loading: Promise<MermaidApi> | null = null;
let initializedFor: ThemeBase | null = null;
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function loadMermaid(): Promise<MermaidApi> {
  loading ??= import('mermaid').then(({ default: mermaid }) => mermaid);
  return loading;
}

function render(source: string, theme: ThemeBase): Promise<string> {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    if (initializedFor !== theme) {
      // Diagrams use the UI's own typeface rather than Mermaid's default.
      const fontFamily = getComputedStyle(document.documentElement).getPropertyValue('--font').trim();
      mermaid.initialize(mermaidConfig(theme, fontFamily));
      initializedFor = theme;
    }
    await mermaid.parse(source);
    const { svg } = await mermaid.render(`mermaid-${++counter}`, source);
    return svg;
  });
  queue = job.catch(() => {});
  return job;
}

// `onRender` is given the drawn <svg> each time it is drawn anew (null while
// there is none), e.g. to mark parts of it.
export function Mermaid({ source, onRender }: { source: string; onRender?: (svg: SVGSVGElement | null) => void }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const theme = useTheme().base; // Mermaid's themes know light and dark only
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    onRender?.(svg && !error ? (root.current?.querySelector('svg') ?? null) : null);
  }, [svg, error, onRender]);

  useEffect(() => {
    let cancelled = false;
    render(source, theme).then(
      (result) => {
        if (cancelled) return;
        setSvg(result);
        setError(undefined);
      },
      (e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        setError(message.split('\n').slice(0, 4).join('\n'));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source, theme]);

  if (error) return <pre className="mermaid-error">{error}</pre>;
  if (!svg) return <p className="placeholder">Rendering diagram…</p>;
  // Mermaid sanitizes its output in strict mode, and labels as mermaidConfig says.
  return <div ref={root} className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
