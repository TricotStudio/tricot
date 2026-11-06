// What the canvas takes in from outside: files, links and text dropped on it,
// and a screenshot, a web address or text pasted on the page. Each kind of
// block says what it makes of them (`files` and `clips` in blocks/kind.ts);
// this decides when they are the canvas's to take at all.
//
// A drop or paste into a field stays the field's, a drag that started on the
// canvas (words moved inside a note) makes no block, and a read-only canvas
// takes nothing in. Files are the canvas's wherever they land, as ever.

import { Fragment, useEffect, useRef, type DragEvent, type ReactNode, type RefObject } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import type { AddContext, DropHooks } from './blocks/kind';
import { menuKinds, webKinds } from './blocks/registry';
import { clipKind, clipOf, dragsLinks, dragsText, dragTypes, typing } from './clip';

interface Intake {
  wrapper: RefObject<HTMLElement | null>;
  flow: Pick<ReactFlowInstance, 'screenToFlowPosition'>;
  context: AddContext;
  readOnly: boolean;
  clips: boolean; // links and text may be taken too: not while a block's full view covers the canvas
  openForm(type: string, initial: string): void; // Add's form for a kind, filled in
}

// Whether a drag began on the canvas, from its start to its end. A browser
// doesn't say, and says nothing of one whose source went before it ended, so
// the next press clears it.
function useDragFromCanvas(wrapper: RefObject<HTMLElement | null>) {
  const began = useRef(false);
  useEffect(() => {
    const start = (event: Event) => void (began.current = Boolean(wrapper.current?.contains(event.target as Node)));
    const end = () => void (began.current = false);
    const later = () => void setTimeout(end); // after the drop has been handled
    window.addEventListener('dragstart', start, true);
    window.addEventListener('dragend', end, true);
    window.addEventListener('drop', later, true);
    window.addEventListener('pointerdown', end, true);
    return () => {
      window.removeEventListener('dragstart', start, true);
      window.removeEventListener('dragend', end, true);
      window.removeEventListener('drop', later, true);
      window.removeEventListener('pointerdown', end, true);
    };
  }, [wrapper]);
  return began;
}

export function useIntake({ wrapper, flow, context, readOnly, clips, openForm }: Intake) {
  const fromCanvas = useDragFromCanvas(wrapper);
  const drops: DropHooks[] = webKinds().flatMap((kind) => [
    ...(kind.files?.useDrop ? [kind.files.useDrop(!readOnly)] : []),
    ...(kind.clips?.useDrop ? [kind.clips.useDrop(!readOnly && clips)] : []),
  ]);

  // A screenshot pasted anywhere on the page, a web address (it opens Add →
  // Link with it filled in), or other text, which is a note.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (readOnly || typing(event.target)) return;
      const data = event.clipboardData;
      const files = [...(data?.files ?? [])];
      const pasted = webKinds().find((kind) => kind.files?.paste && files.some(kind.files.accepts));
      if (pasted) {
        event.preventDefault();
        void pasted.files!.add(files.filter(pasted.files!.accepts), context);
        return;
      }
      const text = data?.getData('text/plain').trim() ?? '';
      for (const kind of menuKinds()) {
        const initial = kind.menu && 'Form' in kind.menu ? kind.menu.paste?.(text) : null;
        if (!initial) continue;
        event.preventDefault();
        openForm(kind.type, initial);
        return;
      }
      // A file copied in the Finder comes with its name as text: not a note.
      if (!data || !clips || files.length) return;
      const clip = clipOf(data);
      const kind = clipKind(webKinds(), clip);
      if (!kind) return;
      event.preventDefault();
      void kind.clips!.add(clip, context);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  const takesClips = (event: DragEvent) => !readOnly && clips && !fromCanvas.current && !typing(event.target);
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (readOnly || fromCanvas.current) return;
      const types = dragTypes(event);
      if (types.includes('Files') || (takesClips(event) && (dragsLinks(types) || dragsText(types)))) event.preventDefault();
    },
    onDragEnter: (event: DragEvent) => {
      if (!fromCanvas.current) drops.forEach((drop) => drop.onDragEnter(event));
    },
    onDragLeave: (event: DragEvent) => drops.forEach((drop) => drop.onDragLeave(event)),
    onDrop: (event: DragEvent) => {
      for (const drop of drops) drop.clear();
      if (readOnly || fromCanvas.current) return;
      const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const files = [...event.dataTransfer.files];
      if (files.length) {
        event.preventDefault();
        for (const kind of webKinds()) {
          const mine = kind.files ? files.filter(kind.files.accepts) : [];
          if (kind.files && mine.length) void kind.files.add(mine, context, at);
        }
        return;
      }
      if (!takesClips(event)) return;
      const clip = clipOf(event.dataTransfer);
      const kind = clipKind(webKinds(), clip);
      if (!kind) return;
      event.preventDefault();
      void kind.clips!.add(clip, context, at);
    },
  };
  const overlays: ReactNode = drops.map((drop, i) => <Fragment key={i}>{drop.overlay}</Fragment>);
  return { dropProps, overlays };
}
