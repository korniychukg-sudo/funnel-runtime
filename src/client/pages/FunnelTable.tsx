import type { FunnelBreakdown, FunnelStepStats } from '../../shared/api';
import { formatCount, formatRate, share } from './format';
import { RateBar } from './RateBar';
import { VariantLabel } from './VariantLabel';

function StepCell({ step }: { step: FunnelStepStats }) {
  if (step.type === 'result') {
    return (
      <>
        <strong>Result → CTA</strong>
        <span className="cell-sub mono">{step.stepId}</span>
      </>
    );
  }
  return (
    <>
      <span className="mono">{step.stepId}</span>
      {step.conditional && <span className="badge badge-warning step-badge">conditional</span>}
    </>
  );
}

function StepsTable({ funnel }: { funnel: FunnelBreakdown }) {
  return (
    <>
      <div className="table-scroll">
        <table className="data-table funnel-table">
          <thead>
            <tr>
              <th scope="col" className="num">
                #
              </th>
              <th scope="col">Step</th>
              <th scope="col">Type</th>
              <th scope="col" className="num">
                Reached
              </th>
              <th scope="col" className="bar-col">
                Of started
              </th>
              <th scope="col" className="num">
                Conversion to next
              </th>
              <th scope="col" className="num">
                Drop-off
              </th>
              <th scope="col" className="num">
                Views
              </th>
            </tr>
          </thead>
          <tbody>
            {funnel.steps.map((step, index) => (
              <tr key={step.stepId} className={step.type === 'result' ? 'result-row' : undefined}>
                <td className="num muted">{index + 1}</td>
                <td>
                  <StepCell step={step} />
                </td>
                <td className="muted nowrap">{step.type}</td>
                <td className="num">{formatCount(step.reached)}</td>
                <td className="bar-col">
                  <RateBar rate={share(step.reached, funnel.started)} variant={funnel.variant} />
                </td>
                <td className="num">{formatRate(step.conversion)}</td>
                <td className="num">
                  {formatCount(step.dropped)} <span className="muted">({formatRate(step.dropOffRate)})</span>
                </td>
                <td className="num">{formatCount(step.views)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted hint">
        On the result row, conversion is the CTA click-through rate and drop-off is sessions that saw a result without
        clicking. Views count every step_viewed event, so repeats from Back and refresh show up only there.
      </p>
    </>
  );
}

export function FunnelTable({ funnel }: { funnel: FunnelBreakdown }) {
  return (
    <article className="card panel">
      <div className="panel-head">
        <div>
          <h3>
            <VariantLabel variant={funnel.variant}>
              v{funnel.version} · variant {funnel.variant}
            </VariantLabel>
          </h3>
          <span className="cell-sub mono">{funnel.experimentId}</span>
        </div>
        <p className="funnel-summary">
          {formatCount(funnel.started)} started · {formatCount(funnel.reachedResult)} reached result ·{' '}
          {formatCount(funnel.ctaClicked)} clicked CTA
        </p>
      </div>
      {funnel.started === 0 ? (
        <p className="muted">No sessions on this version and variant in the current view.</p>
      ) : (
        <StepsTable funnel={funnel} />
      )}
    </article>
  );
}
