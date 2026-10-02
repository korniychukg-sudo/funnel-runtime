import type { ExperimentComparison } from '../../shared/api';
import { byVariant, describeExperiment } from './experimentSummary';
import { formatCount, formatLift, formatPoints, formatPValue, formatRate, plural } from './format';
import { RateBar } from './RateBar';
import { VariantLabel } from './VariantLabel';

function SignificanceBadge({ significant }: { significant: boolean | null }) {
  if (significant === null) return <span className="badge">not enough data</span>;
  if (significant) return <span className="badge badge-success">significant at 95%</span>;
  return <span className="badge badge-warning">not significant</span>;
}

function overrideNote(experiment: ExperimentComparison, includeOverrides: boolean): string {
  if (includeOverrides) return 'Forced-variant (override) sessions are included in this comparison.';
  if (experiment.excludedOverrideSessions === 0) return 'No forced-variant (override) sessions had to be excluded.';
  const excluded = plural(experiment.excludedOverrideSessions, 'forced-variant session');
  return `${excluded} excluded as QA traffic. Tick the override checkbox above to include them.`;
}

type Props = { experiment: ExperimentComparison; includeOverrides: boolean };

export function ExperimentCard({ experiment, includeOverrides }: Props) {
  const variants = byVariant(experiment.variants);
  const diffLabel = variants.length === 2 ? `${variants[1].variant} − ${variants[0].variant}` : 'Difference';

  return (
    <article className="card panel">
      <div className="panel-head">
        <div>
          <h3>v{experiment.version} · A/B on started → CTA</h3>
          <span className="cell-sub mono">{experiment.experimentId}</span>
        </div>
        <SignificanceBadge significant={experiment.significant} />
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Variant</th>
              <th scope="col" className="bar-col">
                Started → CTA
              </th>
              <th scope="col" className="num">
                Started
              </th>
              <th scope="col" className="num">
                Result rate
              </th>
              <th scope="col" className="num">
                CTA CTR
              </th>
            </tr>
          </thead>
          <tbody>
            {variants.map((row) => (
              <tr key={row.variant}>
                <th scope="row">
                  <VariantLabel variant={row.variant} />
                </th>
                <td className="bar-col">
                  <RateBar rate={row.startedToCta} variant={row.variant} />
                </td>
                <td className="num">{formatCount(row.started)}</td>
                <td className="num">{formatRate(row.resultRate)}</td>
                <td className="num">{formatRate(row.ctr)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="stat-row">
        <div>
          <dt>{diffLabel}</dt>
          <dd>{formatPoints(experiment.absoluteDiff)}</dd>
        </div>
        <div>
          <dt>Relative lift</dt>
          <dd>{formatLift(experiment.relativeLift)}</dd>
        </div>
        <div>
          <dt>p-value</dt>
          <dd>{formatPValue(experiment.pValue)}</dd>
        </div>
      </dl>

      <p className="interpretation">{describeExperiment(experiment)}</p>
      <p className="muted hint">{overrideNote(experiment, includeOverrides)}</p>
    </article>
  );
}
