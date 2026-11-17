import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  as: 'h1' | 'p';
  className?: string;
  value: string;
  placeholder?: string;
  label: string;
  required?: boolean;
  maxLength?: number;
  hint?: ReactNode;
  onSave: (value: string) => Promise<unknown>;
  onDone: (refocus: boolean) => void;
}

// A heading's text as the page shows it: what was just saved, until its
// live data catches up.
export function useSavedText(value: string): [string, (saved: string) => void] {
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => setSaved(null), [value]);
  return [saved ?? value, setSaved];
}

// The name or goal as a field in the text's exact place, focused with its
// text selected. Enter saves, Escape cancels, and clicking away saves. A
// failed save keeps the draft open with the reason.
export function HeadingInput({ as: Tag, className, value, placeholder, label, required, maxLength, hint, onSave, onDone }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);
  const refocus = useRef(false);
  // Select after the initial focus as well, so opening the editor selects
  // the current text.
  useLayoutEffect(() => field.current?.select(), []);

  const save = async (input: HTMLInputElement) => {
    const next = input.value.trim();
    if (cancelled.current || next === value || (required && !next)) return onDone(refocus.current);
    setBusy(true);
    try {
      await onSave(next);
      onDone(refocus.current);
    } catch (e) {
      setError((e as Error).message);
      refocus.current = false;
      input.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Tag className={className}>
        <input
          ref={field}
          autoFocus
          className="inline-input"
          defaultValue={value}
          placeholder={placeholder}
          aria-label={label}
          aria-invalid={Boolean(error)}
          maxLength={maxLength}
          readOnly={busy}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => !busy && void save(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              refocus.current = true;
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') {
              cancelled.current = true;
              refocus.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      </Tag>
      {error ? (
        <p className="heading-note error" role="alert">
          {error}
        </p>
      ) : (
        hint && <p className="heading-note">{hint}</p>
      )}
    </>
  );
}
