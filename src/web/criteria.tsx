import { useState, type FormEvent } from 'react';
import type { Decision, MarkValue } from '../core/types';
import { api } from './api';
import { Icon, timeAgo } from './components';
import { useReadOnly } from './hooks';

const NEXT: Record<MarkValue | 'none', MarkValue | null> = { none: 'yes', yes: 'partly', partly: 'no', no: null };
const LABEL: Record<MarkValue, string> = { yes: 'Yes', partly: 'Partly', no: 'No' };
const ICON = { yes: 'check', partly: 'partly', no: 'x' } as const;

// Options judged against criteria. Anyone can propose a criterion, but only
// people mark the cells: a mark is a judgement, and agents read it as one.
export function CriteriaMatrix({ decision, name }: { decision: Decision; name: string }) {
  const readOnly = useReadOnly();
  const [error, setError] = useState<string | null>(null);
  const fail = (e: Error) => setError(e.message);

  if (decision.criteria.length === 0) {
    if (readOnly) return null;
    return (
      <section className="section">
        <AddCriterion decisionId={decision.id} name={name} prompt="Judge the options against criteria" onError={fail} />
      </section>
    );
  }

  const markOf = (criterionId: string, optionId: string) =>
    decision.marks.find((m) => m.criterionId === criterionId && m.optionId === optionId);
  const cycle = (criterionId: string, optionId: string) => {
    const current = markOf(criterionId, optionId)?.value ?? 'none';
    api.mark(decision.id, name, criterionId, optionId, NEXT[current]).then(() => setError(null), fail);
  };

  return (
    <section className="section">
      <h3>Criteria</h3>
      {!readOnly && <p className="faint small">Click a cell to mark it yes, partly or no. Only people mark these.</p>}
      <div className="table-wrap">
        <table className="criteria">
          <thead>
            <tr>
              <th />
              {decision.options.map((option) => (
                <th
                  key={option.id}
                  scope="col"
                  className={option.outdated ? 'is-outdated' : undefined}
                  title={option.outdated ? `${option.label} (outdated: its marks are kept)` : option.label}
                >
                  <span className="option-letter" aria-label={`${option.id}) ${option.label}${option.outdated ? ', outdated' : ''}`}>
                    {option.id}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {decision.criteria.map((criterion) => (
              <tr key={criterion.id}>
                <th
                  scope="row"
                  title={[criterion.description, `Proposed by ${criterion.proposedBy.name}`].filter(Boolean).join('. ')}
                >
                  <span className="criterion-label">{criterion.label}</span>
                  {!readOnly && (
                    <button
                      className="cell-remove"
                      onClick={() => api.removeCriterion(decision.id, criterion.id, name).catch(fail)}
                      aria-label={`Remove criterion ${criterion.label}`}
                    >
                      <Icon name="x" />
                    </button>
                  )}
                </th>
                {decision.options.map((option) => {
                  const mark = markOf(criterion.id, option.id);
                  const marked = mark ? `${LABEL[mark.value]}, marked by ${mark.by.name} ${timeAgo(mark.at)}` : 'not marked';
                  // An outdated option keeps the marks people gave it, as a record, but takes no new ones.
                  const state = option.outdated ? `${marked}; the option is outdated` : marked;
                  const fixed = readOnly || Boolean(option.outdated);
                  return (
                    <td key={option.id} className={option.outdated ? 'is-outdated' : undefined}>
                      <button
                        className={`mark mark-${mark?.value ?? 'none'}`}
                        disabled={fixed}
                        onClick={() => cycle(criterion.id, option.id)}
                        title={fixed ? state : `${state}. Click to change.`}
                        aria-label={`${criterion.label}, option ${option.id}: ${state}`}
                      >
                        {mark ? <Icon name={ICON[mark.value]} /> : <span className="mark-empty" />}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && <AddCriterion decisionId={decision.id} name={name} prompt="Add a criterion" onError={fail} />}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function AddCriterion(props: { decisionId: string; name: string; prompt: string; onError: (e: Error) => void }) {
  const { decisionId, name, prompt, onError } = props;
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  if (!open) {
    return (
      <button className="link-button" onClick={() => setOpen(true)}>
        <Icon name="plus" /> {prompt}
      </button>
    );
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!label.trim()) return;
    try {
      await api.addCriterion(decisionId, name, label);
      setLabel('');
      setOpen(false);
    } catch (e) {
      onError(e as Error);
    }
  };
  return (
    <form className="inline-form" onSubmit={submit}>
      <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. No silent behaviour change" />
      <button className="btn btn-small" disabled={!label.trim()}>
        Add
      </button>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}
