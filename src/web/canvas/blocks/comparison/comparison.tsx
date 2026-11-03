import type { Decision } from '../../../../core/types';

// Lines options up side by side on the metrics agents reported for them.
// Later findings for the same option override earlier values. Needs at least
// two options with metrics to be worth showing.
export function comparisonData(decision: Decision) {
  const metricsByOption = new Map<string, Record<string, string | number>>();
  for (const finding of decision.findings) {
    if (finding.optionId && finding.metrics) {
      metricsByOption.set(finding.optionId, { ...metricsByOption.get(finding.optionId), ...finding.metrics });
    }
  }
  const options = decision.options.filter((o) => metricsByOption.has(o.id));
  if (options.length < 2) return null;
  const keys = [...new Set(options.flatMap((o) => Object.keys(metricsByOption.get(o.id)!)))];
  return { options, keys, metricsByOption };
}

export function Comparison({ decision, bare = false }: { decision: Decision; bare?: boolean }) {
  const data = comparisonData(decision);
  if (!data) return null;
  const { options, keys, metricsByOption } = data;

  const table = (
      <div className="table-wrap">
        <table className="compare">
          <thead>
            <tr>
              <th />
              {options.map((o) => (
                <th key={o.id} className={decision.resolution?.optionId === o.id ? 'is-chosen' : o.outdated ? 'is-outdated' : ''}>
                  <span className="option-letter">{o.id}</span> {o.label}
                  {o.outdated && <span className="tag tag-outdated">outdated</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key}>
                <th scope="row">{key}</th>
                {options.map((o) => (
                  <td key={o.id} className={decision.resolution?.optionId === o.id ? 'is-chosen' : o.outdated ? 'is-outdated' : ''}>
                    {metricsByOption.get(o.id)![key] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
  );
  if (bare) return table;
  return (
    <section className="section">
      <h3>Comparison</h3>
      {table}
    </section>
  );
}
