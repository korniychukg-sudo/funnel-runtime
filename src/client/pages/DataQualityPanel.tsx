import type { DataQuality, EventCount } from '../../shared/api';
import { formatCount, plural } from './format';

function EventCounts({ rows }: { rows: EventCount[] }) {
  if (rows.length === 0) return <p className="muted hint">No events stored for this view.</p>;
  return (
    <div className="table-scroll event-counts">
      <table className="data-table">
        <caption>Events by name, in this view</caption>
        <thead>
          <tr>
            <th scope="col">Event</th>
            <th scope="col" className="num">
              Events
            </th>
            <th scope="col" className="num">
              Sessions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <th scope="row" className="mono">
                {row.name}
              </th>
              <td className="num">{formatCount(row.events)}</td>
              <td className="num">{formatCount(row.sessions)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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
      <EventCounts rows={quality.events} />
    </section>
  );
}
