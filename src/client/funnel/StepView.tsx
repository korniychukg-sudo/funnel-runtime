import { useEffect, useRef, type Ref } from 'react';
import type { SessionState } from '../../shared/api';
import { isInteractive } from '../../shared/steps';
import { progressFor } from '../../shared/engine';
import { InfoStep } from './InfoStep';
import { ProgressHeader, type QuestionProgress } from './ProgressHeader';
import { QuestionStep } from './QuestionStep';
import { ResultStep } from './ResultStep';
import type { FunnelSession, FunnelView } from './useFunnelSession';

function questionProgress(state: SessionState): QuestionProgress | null {
  if (!isInteractive(state.funnel.steps[state.currentStepId])) return null;
  const { index, count } = progressFor(state.funnel, state.answers, state.currentStepId);
  return index === null ? null : { index, count };
}

type StepBodyProps = { session: FunnelSession; state: SessionState; headingRef: Ref<HTMLHeadingElement> };

function StepBody({ session, state, headingRef }: StepBodyProps) {
  const step = state.funnel.steps[state.currentStepId];
  switch (step.type) {
    case 'info':
      return (
        <InfoStep
          step={step}
          headingRef={headingRef}
          busy={session.busy}
          error={session.stepError}
          onContinue={session.advance}
        />
      );
    case 'result':
      return (
        <ResultStep
          step={step}
          result={state.result}
          failed={session.resultFailed}
          error={session.stepError}
          headingRef={headingRef}
          onRetry={session.retryResult}
          onCta={session.clickCta}
        />
      );
    default:
      return (
        <QuestionStep
          step={step}
          stored={state.answers[step.input.name]}
          headingRef={headingRef}
          busy={session.busy}
          error={session.stepError}
          onSubmit={session.submit}
          onEdit={session.clearStepError}
        />
      );
  }
}

export function StepView({ session, view }: { session: FunnelSession; view: FunnelView }) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (view.seq === 1) return;
    headingRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [view.seq]);

  return (
    <article className="funnel-card">
      <ProgressHeader
        canGoBack={session.canGoBack}
        busy={session.busy}
        progress={questionProgress(view.state)}
        onBack={session.goBack}
      />
      <div key={view.seq} className="step-enter">
        <StepBody session={session} state={view.state} headingRef={headingRef} />
      </div>
    </article>
  );
}
