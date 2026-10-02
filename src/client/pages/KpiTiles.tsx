import type { KpiStats } from '../../shared/api';
import { formatCount, formatRate } from './format';

export function KpiTiles({ totals }: { totals: KpiStats }) {
  const tiles = [
    { label: 'Started', value: formatCount(totals.started), note: 'unique sessions' },
    {
      label: 'Reached result',
      value: formatCount(totals.reachedResult),
      note: `${formatRate(totals.resultRate)} of started`,
    },
    {
      label: 'CTA CTR',
      value: formatRate(totals.ctr),
      note: `${formatCount(totals.ctaClicked)} clicks of ${formatCount(totals.reachedResult)} results`,
    },
    {
      label: 'Started → CTA',
      value: formatRate(totals.startedToCta),
      note: `${formatCount(totals.ctaClicked)} of ${formatCount(totals.started)} · A/B metric`,
    },
  ];

  return (
    <section className="kpi-grid" aria-label="Key metrics">
      {tiles.map((tile) => (
        <div key={tile.label} className="card kpi-tile">
          <span className="kpi-label">{tile.label}</span>
          <strong className="kpi-value">{tile.value}</strong>
          <span className="kpi-note">{tile.note}</span>
        </div>
      ))}
    </section>
  );
}
