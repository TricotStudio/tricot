// Code blocks: a source file, or part of one, with line numbers and the lines
// that matter highlighted. It is named by its path. People add code by
// pasting it (Add → Code) or dropping text files; they comment on its lines,
// and open it full screen to pair with an agent on them (codeView.tsx).

import { codeBlockSize } from '../../../../core/blocks/code/code';
import type { Block } from '../../../../core/types';
import { useCanvas } from '../../context';
import type { AddContext, FormProps, Point, ToolsProps, WebBlockKind } from '../kind';
import { AddCodeForm, CodeBody, CodeDropOverlay, CodeHead, isImageFile, readCodeFile, useCodeDrop, type NewCode } from './code';
import { CodeView } from './codeView';

type CodeBlock = Extract<Block, { type: 'code' }>;

// Code pasted in Add → Code, or text files dropped: a code block each, named
// after the file. A dropped one hangs from where it landed: its name there.
function addCode(code: NewCode, context: AddContext, at?: Point) {
  const size = codeBlockSize(code);
  return context.add(code, { at: at && { x: at.x + size.w / 2 - 60, y: at.y + size.h / 2 - 18 }, size });
}

async function addCodeFiles(files: File[], context: AddContext, at?: Point) {
  for (const [i, file] of files.entries()) {
    try {
      const text = await readCodeFile(file);
      await addCode({ type: 'code', path: file.name, text }, context, at && { x: at.x + i * 40, y: at.y + i * 40 });
    } catch (e) {
      context.report(e);
    }
  }
}

function AddCode({ toggle, context, close }: FormProps) {
  return (
    <AddCodeForm
      toggle={toggle}
      onAdd={(code) => {
        close();
        void addCode(code, context);
      }}
      onCancel={close}
    />
  );
}

function useDrop(enabled: boolean) {
  const { drop, onDragEnter, onDragLeave, clear } = useCodeDrop(enabled);
  return { onDragEnter, onDragLeave, clear, overlay: drop && <CodeDropOverlay drop={drop} /> };
}

// Open: its full view, to read it all or pair with an agent on its lines.
function CodeTools({ block, viewing }: ToolsProps<CodeBlock>) {
  const canvas = useCanvas();
  return (
    <button onClick={() => canvas.openOverlay(block.id, { version: viewing ?? undefined })} title="Open it full screen, to read it all or pair with an agent on its lines (Enter)">
      Open
    </button>
  );
}

export const code: WebBlockKind<CodeBlock> = {
  type: 'code',
  copyText: (block) => block.text,
  Body: ({ block, placed }) => <CodeBody block={block} placed={placed} />,
  Title: ({ block, placed, frozen }) => <CodeHead block={block} placed={placed} frozen={frozen} />, // named by its path
  ownPins: true, // its line comments and chips are in the body
  Tools: CodeTools,
  overlay: { Component: CodeView, refocus: true }, // its full view, in the pairing shell
  activate: (block, canvas) => canvas.openOverlay(block.id),
  menu: { label: 'Code', Form: AddCode, toggles: true },
  // Images dropped on a canvas are image blocks, as ever; other files, code blocks.
  files: { accepts: (file) => !isImageFile(file.type), add: addCodeFiles, useDrop },
};
