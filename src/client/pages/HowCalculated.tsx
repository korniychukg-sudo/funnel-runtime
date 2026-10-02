const RULES = [
  {
    title: 'Sessions, not events',
    text: 'Every number is a count of unique sessions. Started is the number of sessions created in the filtered view; the server writes their session_started event itself.',
  },
  {
    title: 'Filters',
    text: 'Campaign is the first-touch utm_campaign stored on the session, version is the version the session is pinned to, run id tags traffic from one generator run.',
  },
  {
    title: 'Reaching a step',
    text: 'A session reached a step if it viewed, answered, completed or left it with Back. A step without a condition also counts as reached when the session reached any later step, so a lost event cannot open a hole. Conditional steps count only when they were actually seen, because analytics does not store raw answers.',
  },
  {
    title: 'Conversion and drop-off',
    text: 'Conversion to next is the share of sessions that got further than the step. Drop-off is the share whose furthest step is this one. On the result row, conversion is the CTA click-through rate.',
  },
  {
    title: 'Result and CTA',
    text: 'Reached result means result_viewed, cta_clicked or recommendation_expanded. Result rate = reached result ÷ started, CTA CTR = clicked CTA ÷ reached result, Started → CTA = clicked CTA ÷ started.',
  },
  {
    title: 'A/B comparison',
    text: 'The primary metric is Started → CTA per variant inside one version. Difference is B − A in percentage points, lift is the difference divided by A, the p-value comes from a pooled two-proportion z-test and p < 0.05 counts as significant. Sessions with a forced ?variant= are QA traffic and are excluded unless the checkbox is on.',
  },
  {
    title: 'Versions and result mix',
    text: 'Versions have different steps, so they are compared on the step-agnostic rates only. The result mix counts each session once, with the latest result it was shown.',
  },
  {
    title: 'Duplicates, repeats and order',
    text: 'A re-sent event_id is stored once. Repeated views, Back clicks and late or shuffled events do not change any set of sessions, so they only show up in Views and Data quality. A rate is shown as — when its denominator is zero.',
  },
];

export function HowCalculated() {
  return (
    <details className="card panel how-calculated">
      <summary>How these numbers are calculated</summary>
      <dl>
        {RULES.map((rule) => (
          <div key={rule.title}>
            <dt>{rule.title}</dt>
            <dd>{rule.text}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
