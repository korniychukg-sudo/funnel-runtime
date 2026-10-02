import type { ResultMixRow } from '../../shared/api';
import { formatCount, formatRate, share } from './format';
import { VariantLabel } from './VariantLabel';

function groupKey(row: ResultMixRow): string {
  return `${row.version}:${row.variant}`;
}

export function ResultMix({ rows }: { rows: ResultMixRow[] }) {
  const groupTotals = new Map<string, number>();
  for (const row of rows) groupTotals.set(groupKey(row), (groupTotals.get(groupKey(row)) ?? 0) + row.sessions);
  const sorted = [...rows].sort(
    (a, b) => b.version - a.version || a.variant.localeCompare(b.variant) || b.sessions - a.sessions,
  );

  return (
    <section className="card panel" aria-labelledby="result-mix-title">
      <div className="panel-head">
        <div>
          <h2 id="result-mix-title">Result mix</h2>
          <p>Each session counts once, with the latest result it was shown.</p>
        </div>
      </div>
      {sorted.length === 0 ? (
        <p className="muted">No results shown yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Variant</th>
                <th scope="col">Result</th>
                <th scope="col" className="num">
                  Sessions
                </th>
                <th scope="col" className="num">
                  Share
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={`${groupKey(row)}:${row.resultId}`}>
                  <td>v{row.version}</td>
                  <td>
                    <VariantLabel variant={row.variant} />
                  </td>
                  <td className="mono">{row.resultId}</td>
                  <td className="num">{formatCount(row.sessions)}</td>
                  <td className="num">{formatRate(share(row.sessions, groupTotals.get(groupKey(row)) ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
