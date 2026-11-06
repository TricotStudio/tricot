import { useCallback, useState, type FormEvent } from 'react';
import { Wordmark } from '../shared/components';

const NAME_KEY = 'tricot:name';

export function useName(): [string, (name: string) => void] {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const update = useCallback((next: string) => {
    setName(next);
    try {
      if (next) localStorage.setItem(NAME_KEY, next);
      else localStorage.removeItem(NAME_KEY);
    } catch {
      // Storage unavailable: the name lasts for this tab only.
    }
  }, []);
  return [name, update];
}

// What the page asks first, on a browser that hasn't said who it is.
export function NameGate({ onSubmit }: { onSubmit: (name: string) => void }) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onSubmit(value.trim());
  };
  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <Wordmark />
        <h1>What should agents call you?</h1>
        <p className="muted">Your name is attached to every decision you make, so everyone can see who decided what.</p>
        <input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="Your name" maxLength={60} />
        <button className="btn btn-primary" disabled={!value.trim()}>
          Continue
        </button>
      </form>
    </div>
  );
}
