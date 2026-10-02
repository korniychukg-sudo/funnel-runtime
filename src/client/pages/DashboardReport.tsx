import type { AnalyticsResponse } from '../../shared/api';
import { DataQualityPanel } from './DataQualityPanel';
import { ExperimentCard } from './ExperimentCard';
import { FunnelTable } from './FunnelTable';
import { HowCalculated } from './HowCalculated';
import { KpiTiles } from './KpiTiles';
import { ResultMix } from './ResultMix';
import { VersionsComparison } from './VersionsComparison';

type Props = {
  data: AnalyticsResponse;
  onResetFilters: () => void;
};

export function DashboardReport({ data, onResetFilters }: Props) {
  if (data.available.versions.length === 0) {
    return (
      <div className="card panel empty-state">
        <h2>No data yet</h2>
        <p>
          Run <code>npm run generate</code> to create synthetic traffic, or open the funnel and click through it.
        </p>
      </div>
    );
  }

  if (data.totals.started === 0) {
    return (
      <div className="card panel empty-state">
        <h2>No sessions match these filters</h2>
        <p>Try another campaign, version or run id.</p>
        <button type="button" className="btn btn-secondary btn-small" onClick={onResetFilters}>
          Reset filters
        </button>
      </div>
    );
  }

  const experiments = [...data.experiments].sort((a, b) => b.version - a.version);
  const funnels = [...data.funnels].sort((a, b) => b.version - a.version || a.variant.localeCompare(b.variant));

  return (
    <>
      <KpiTiles totals={data.totals} />

      <section aria-labelledby="experiments-title">
        <h2 id="experiments-title" className="section-title">
          A/B experiments
        </h2>
        {experiments.length === 0 ? (
          <p className="muted">No experiment traffic in this view.</p>
        ) : (
          <div className="experiment-grid">
            {experiments.map((experiment) => (
              <ExperimentCard
                key={experiment.version}
                experiment={experiment}
                includeOverrides={data.filters.includeOverrides}
              />
            ))}
          </div>
        )}
      </section>

      <VersionsComparison versions={data.versions} />

      <section aria-labelledby="funnels-title">
        <h2 id="funnels-title" className="section-title">
          Funnel by version and variant
        </h2>
        {funnels.map((funnel) => (
          <FunnelTable key={`${funnel.version}:${funnel.variant}`} funnel={funnel} />
        ))}
      </section>

      <div className="report-columns">
        <ResultMix rows={data.resultMix} />
        <DataQualityPanel quality={data.dataQuality} />
      </div>

      <HowCalculated />
    </>
  );
}
