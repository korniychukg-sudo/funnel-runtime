import type { VersionStats } from '../../shared/api';
import { formatCount, formatRate } from './format';

export function VersionsComparison({ versions }: { versions: VersionStats[] }) {
  const rows = [...versions].sort((a, b) => b.version - a.version);

  return (
    <section className="card panel" aria-labelledby="versions-comparison-title">
      <div className="panel-head">
        <div>
          <h2 id="versions-comparison-title">Versions</h2>
          <p>All variants together. Step lists differ between versions, so versions are compared on step-agnostic rates.</p>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Experiment</th>
              <th scope="col" className="num">
                Started
              </th>
              <th scope="col" className="num">
                Result rate
              </th>
              <th scope="col" className="num">
                CTA CTR
              </th>
              <th scope="col" className="num">
                Started → CTA
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.version}>
                <th scope="row">v{row.version}</th>
                <td className="mono">{row.experimentId}</td>
                <td className="num">{formatCount(row.started)}</td>
                <td className="num">{formatRate(row.resultRate)}</td>
                <td className="num">{formatRate(row.ctr)}</td>
                <td className="num">{formatRate(row.startedToCta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
