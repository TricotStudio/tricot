// Editing a piece by hand in its full view (piece.tsx), as the canvas lets
// people edit it: Edit in the bar, or a double-click while reading, opens the
// kind's editor in place of the piece. Pair stays for pointing at parts.
//
// A kind edits in one of two ways:
// - text: its words or source in a field (a note's Markdown, a diagram's or a
//   scene's source, an image's caption), with what it will look like beside
//   them. It saves when the person goes back to Read or Pair, presses Esc or
//   closes the view, as one new revision by them. If someone (an agent, most
//   often) changes the piece meanwhile, what they typed isn't saved over it
//   unasked: a band says so, and they keep theirs or take the new one.
// - live: the canvas's own controls (a table's or a chart's cells), each
//   change saved at once, as on the canvas.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Block } from '../../../core/types';
import { api, type BlockPatch, type RequestError } from '../../shared/api';
import { useCanvas } from '../context';

interface EditBase {
  hint: string; // what Edit does, on the button: "Edit the note's Markdown"
  doubleClick?: false; // a double-click on the piece does something else (zooms an image)
}

export interface TextEdit<B extends Block> extends EditBase {
  label: string; // the field's name: "Markdown"
  of(block: B): string; // the text edited
  patch(text: string): BlockPatch; // the change it makes
  check?(text: string): string | null; // why the text can't be saved, if it can't
  code?: true; // source: monospaced, no spell check
  single?: true; // one line (a caption): Enter saves it
  placeholder?: string;
  preview?(text: string, block: B): ReactNode; // beside the field, as typed
}

export interface LiveEdit<B extends Block> extends EditBase {
  live(props: { block: B; save(patch: BlockPatch): void }): ReactNode;
}

export type PieceEdit<B extends Block> = TextEdit<B> | LiveEdit<B>;

const isText = <B extends Block>(edit: PieceEdit<B>): edit is TextEdit<B> => 'of' in edit;

export interface HandEdit<B extends Block> {
  on: boolean;
  live: boolean; // its editor saves each change at once
  text: string;
  saving: boolean;
  error: string | null;
  theirs: string | null; // who changed the piece since the editing began, if anyone did
  start(): void;
  stop(): Promise<boolean>; // saves, and says whether the editor closed
  discard(): void;
  keepMine(): void; // save over their change
  takeTheirs(): void; // start again from the piece as it is now
  setText(text: string): void;
  editor: ReactNode;
}

// `block` is the piece as the board has it now; `it` names it ("the note").
export function useHandEdit<B extends Block>(block: B, name: string, edit: PieceEdit<B> | undefined, enabled: boolean): HandEdit<B> {
  const canvas = useCanvas();
  // The piece as the editing began (or as the person chose to save over), and what they typed.
  const [editing, setEditing] = useState<{ base: B; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = editing && edit && isText(edit) ? edit : null;

  const start = useCallback(() => {
    if (!edit || !enabled) return;
    setError(null);
    setEditing((was) => was ?? { base: block, text: isText(edit) ? edit.of(block) : '' });
  }, [edit, enabled, block]);

  const discard = useCallback(() => {
    setEditing(null);
    setError(null);
  }, []);

  // A press on Read, Pair, Close or Esc while saving waits for it.
  const pending = useRef<Promise<boolean> | null>(null);
  const stop = useCallback(async (): Promise<boolean> => {
    if (pending.current) return pending.current;
    if (!editing || !edit) return true;
    if (!isText(edit)) {
      setEditing(null);
      return true;
    }
    const { base, text: typed } = editing;
    if (typed === edit.of(base)) {
      setEditing(null); // nothing typed: nothing to save, whatever changed meanwhile
      setError(null);
      return true;
    }
    const refused = edit.check?.(typed);
    if (refused) {
      setError(refused);
      return false;
    }
    if (block.rev !== base.rev) return false; // the band asks first
    const save = (async () => {
      setSaving(true);
      try {
        await api.updateBlock(block.id, name, { ...edit.patch(typed), rev: base.rev });
        setEditing(null);
        setError(null);
        return true;
      } catch (e) {
        // Refused as changed meanwhile: the change arrives, and the band asks.
        if ((e as RequestError).status !== 409) setError((e as Error).message);
        return false;
      } finally {
        setSaving(false);
        pending.current = null;
      }
    })();
    pending.current = save;
    return save;
  }, [editing, edit, block, name]);

  // Leaving the view, or an earlier version shown, ends it unsaved: closing saves first (piece.tsx).
  useEffect(() => {
    if (!enabled) setEditing(null);
  }, [enabled]);

  const theirs = text && editing && block.rev !== editing.base.rev ? block.updatedBy.name : null;
  const keepMine = useCallback(() => setEditing((was) => was && { ...was, base: block }), [block]);
  const takeTheirs = useCallback(() => {
    if (edit && isText(edit)) setEditing({ base: block, text: edit.of(block) });
    setError(null);
  }, [edit, block]);
  const setText = useCallback((value: string) => {
    setEditing((was) => was && { ...was, text: value });
    setError(null);
  }, []);

  let editor: ReactNode = null;
  if (editing && edit) {
    editor = isText(edit) ? (
      <TextEditor edit={edit} block={block} text={editing.text} onText={setText} onEnter={() => void stop()} />
    ) : (
      edit.live({ block, save: (patch) => canvas.updateBlock(block, patch) })
    );
  }

  return {
    on: Boolean(editing),
    live: Boolean(editing && edit && !isText(edit)),
    text: editing?.text ?? '',
    saving,
    error,
    theirs,
    start,
    stop,
    discard,
    keepMine,
    takeTheirs,
    setText,
    editor,
  };
}

const PREVIEW_MS = 250; // the preview follows the typing after this pause

// The text in a field on the sheet, what it will look like beside it.
function TextEditor<B extends Block>({ edit, block, text, onText, onEnter }: { edit: TextEdit<B>; block: B; text: string; onText(text: string): void; onEnter(): void }) {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const timer = setTimeout(() => setShown(text), PREVIEW_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const field = edit.single ? (
    <input
      autoFocus
      className="piece-edit-input"
      value={text}
      placeholder={edit.placeholder}
      aria-label={edit.label}
      onChange={(e) => onText(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && onEnter()}
    />
  ) : (
    <textarea
      autoFocus
      className={`piece-edit-text${edit.code ? ' is-code' : ''}`}
      value={text}
      placeholder={edit.placeholder}
      spellCheck={!edit.code}
      aria-label={edit.label}
      onChange={(e) => onText(e.target.value)}
    />
  );
  return (
    <div className={`piece-edit${edit.preview ? ' has-preview' : ''}${edit.single ? ' is-single' : ''}`}>
      <div className="piece-edit-field">
        <span className="piece-edit-label">{edit.label}</span>
        {field}
      </div>
      {edit.preview && (
        <div className="piece-edit-preview" aria-label="Preview">
          <span className="piece-edit-label">Preview</span>
          <div className="piece-edit-shown">{edit.preview(shown, block)}</div>
        </div>
      )}
    </div>
  );
}
