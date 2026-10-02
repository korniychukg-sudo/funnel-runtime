import { useEffect, useRef, useState, type Ref } from 'react';
import type { SessionState } from '../../shared/api';
import { InfoStep } from './InfoStep';
import { ProgressHeader } from './ProgressHeader';
import { questionProgress, type DraftAnswer } from './progress';
import { QuestionStep } from './QuestionStep';
import { ResultStep } from './ResultStep';
import type { FunnelSession, FunnelView } from './useFunnelSession';

type StepBodyProps = {
  session: FunnelSession;
  state: SessionState;
  headingRef: Ref<HTMLHeadingElement>;
  onDraftChange: (draft: DraftAnswer) => void;
};

function StepBody({ session, state, headingRef, onDraftChange }: StepBodyProps) {
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
          sessionId={state.session.id}
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
          onDraftChange={onDraftChange}
        />
      );
  }
}

export function StepView({ session, view }: { session: FunnelSession; view: FunnelView }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState<{ seq: number; value: DraftAnswer } | null>(null);

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
        progress={questionProgress(view.state, draft?.seq === view.seq ? draft.value : undefined)}
        onBack={session.goBack}
      />
      <div key={view.seq} className="step-enter">
        <StepBody
          session={session}
          state={view.state}
          headingRef={headingRef}
          onDraftChange={(value) => setDraft({ seq: view.seq, value })}
        />
      </div>
    </article>
  );
}
