// Choosing Google Docs for Tricot with Google's Picker: from the Google panel
// on the Connectors page, when adding a link, and from a doc Tricot couldn't
// open. A doc someone chooses is one Tricot may then open and edit, and no other.

import { useState } from 'react';
import type { ConnectorStatus } from '../../../core/connectors';
import { DRIVE_FILE } from '../../../core/connectors/google/scopes';
import { forgetFiles } from '../live';
import { googleApi } from './api';
import { chooseDocs, type PickedDoc } from './picker';

// The Picker over the signed-in account's Docs; the server hears which were chosen.
export async function chooseGoogleDocs(options: { fileIds?: string[]; multiple?: boolean; title?: string } = {}): Promise<PickedDoc[]> {
  const config = await googleApi.pickerConfig();
  const docs = await chooseDocs(config, options);
  if (docs.length) {
    await googleApi.chosen(docs.map((d) => d.id));
    forgetFiles();
  }
  return docs;
}

// "Choose Google Docs": on the Connectors page, under what Tricot can use.
export function GooglePanel({ status }: { status: ConnectorStatus }) {
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<PickedDoc[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  if (status.state !== 'connected' || !status.access.some((a) => a.scope === DRIVE_FILE && a.granted)) return null;
  const choose = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const docs = await chooseGoogleDocs({ multiple: true });
      if (docs.length) setChosen(docs);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="connector-section">
      <h3>Google Docs Tricot may use</h3>
      <p className="muted small">
        Tricot sees only the Google Docs you choose, nothing else in your Drive. Choose them here, from Add → Link on a board, or when a doc's card asks.
      </p>
      <div className="row">
        <button className="btn btn-small" disabled={busy} onClick={() => void choose()}>
          {busy ? 'Choosing…' : 'Choose Google Docs'}
        </button>
      </div>
      {chosen.length > 0 && (
        <p className="muted small" role="status">
          Tricot may now use {chosen.map((d) => d.name).join(', ')}. Add a link to {chosen.length === 1 ? 'it' : 'them'} on a board to edit{' '}
          {chosen.length === 1 ? 'it' : 'them'} in Tricot.
        </p>
      )}
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
