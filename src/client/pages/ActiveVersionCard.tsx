import type { Activation, AdminOverview } from '../../shared/api';
import { formatCount, formatDateTime } from './format';
import { VariantLabel } from './VariantLabel';

type Props = {
  overview: AdminOverview;
  busy: boolean;
  onRollback: (target: number) => void;
};

function latestActivation(activations: Activation[]): Activation | undefined {
  return activations.reduce<Activation | undefined>((latest, entry) => (!latest || entry.id > latest.id ? entry : latest), undefined);
}

export function ActiveVersionCard({ overview, busy, onRollback }: Props) {
  const active = overview.versions.find((version) => version.version === overview.activeVersion);
  const since = latestActivation(overview.activations);
  const target = overview.rollbackTarget;

  return (
    <section className="card panel active-card" aria-labelledby="active-version-title">
      <p className="eyebrow" id="active-version-title">
        Active version
      </p>
      {active ? (
        <>
          <div className="active-heading">
            <span className="active-version">v{active.version}</span>
            <div>
              <strong>{active.title}</strong>
              <span className="cell-sub mono">{active.funnelId}</span>
            </div>
          </div>
          <dl className="facts">
            <div>
              <dt>Experiment</dt>
              <dd className="mono">{active.experimentId}</dd>
            </div>
            <div>
              <dt>Variants</dt>
              <dd className="chip-row">
                {active.variants.map((variant) => (
                  <span key={variant} className="variant-chip">
                    <VariantLabel variant={variant} />
                  </span>
                ))}
              </dd>
            </div>
            <div>
              <dt>Active since</dt>
              <dd>
                {formatDateTime(since?.at)}
                {since && <span className="muted"> · {since.action}</span>}
              </dd>
            </div>
            <div>
              <dt>Traffic</dt>
              <dd>
                {formatCount(active.sessions)} sessions · {formatCount(active.events)} events
              </dd>
            </div>
          </dl>
          {active.releaseNote && <p className="release-note">{active.releaseNote}</p>}
        </>
      ) : (
        <p className="muted">No version is active yet. Publish a draft to start serving sessions.</p>
      )}
      <div className="card-actions">
        <button type="button" className="btn btn-danger btn-small" disabled={target === null || busy} onClick={() => target !== null && onRollback(target)}>
          {target === null ? 'Roll back' : `Roll back to v${target}`}
        </button>
        <p className="muted hint">
          {target === null
            ? 'There is no earlier version in the activation history.'
            : 'Changes which version new sessions get. Running sessions keep their pinned version.'}
        </p>
      </div>
    </section>
  );
}
