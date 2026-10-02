import type { Activation, ActivationAction } from '../../shared/api';
import { EMPTY, formatDateTime } from './format';

const ACTION_BADGE: Record<ActivationAction, string> = {
  seed: 'badge',
  publish: 'badge badge-success',
  activate: 'badge badge-accent',
  rollback: 'badge badge-warning',
};

export function ActivationLog({ activations }: { activations: Activation[] }) {
  const rows = [...activations].sort((a, b) => b.id - a.id);

  return (
    <section className="card panel" aria-labelledby="activation-log-title">
      <div className="panel-head">
        <div>
          <h2 id="activation-log-title">Activation log</h2>
          <p>Append-only history, newest first. Version is the one that became active; from version is the one it replaced.</p>
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No activations yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Action</th>
                <th scope="col" className="num">
                  Version
                </th>
                <th scope="col" className="num">
                  From version
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <tr key={entry.id}>
                  <td className="nowrap">{formatDateTime(entry.at)}</td>
                  <td>
                    <span className={ACTION_BADGE[entry.action]}>{entry.action}</span>
                  </td>
                  <td className="num">v{entry.version}</td>
                  <td className="num">{entry.fromVersion === null ? EMPTY : `v${entry.fromVersion}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
