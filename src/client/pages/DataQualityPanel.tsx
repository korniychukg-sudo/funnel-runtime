import type { DataQuality } from '../../shared/api';
import { formatCount, plural } from './format';

export function DataQualityPanel({ quality }: { quality: DataQuality }) {
  const items = [
    { label: 'Events stored', value: quality.eventsStored, note: 'Events of the sessions in this view.' },
    { label: 'Duplicates dropped', value: quality.duplicatesDropped, note: 'Re-sent event_ids ignored on ingest, all traffic.' },
    { label: 'Rejected events', value: quality.rejectedEvents, note: 'Invalid or not allowed items, all traffic.' },
    { label: 'Repeated step views', value: quality.repeatedStepViews, note: 'Extra step_viewed from Back and refresh.' },
    { label: 'Back clicks', value: quality.backClicks, note: 'back_clicked events in this view.' },
    {
      label: 'Out-of-order events',
      value: quality.outOfOrderEvents,
      note: `Arrived after a later event, in ${plural(quality.sessionsWithOutOfOrderEvents, 'session')}.`,
    },
  ];

  return (
    <section className="card panel" aria-labelledby="data-quality-title">
      <div className="panel-head">
        <div>
          <h2 id="data-quality-title">Data quality</h2>
          <p>None of these change the session counts above: every metric is a set of unique sessions.</p>
        </div>
      </div>
      <dl className="quality-grid">
        {items.map((item) => (
          <div key={item.label} className="quality-item">
            <dt>{item.label}</dt>
            <dd>
              <strong>{formatCount(item.value)}</strong>
              <span className="cell-sub">{item.note}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
