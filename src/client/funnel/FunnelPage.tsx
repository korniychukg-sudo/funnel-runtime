import { useEffect } from 'react';
import './funnel.css';
import { StartError, StepSkeleton } from './FunnelPlaceholders';
import { SessionChip } from './SessionChip';
import { StepView } from './StepView';
import { useFunnelSession } from './useFunnelSession';

export default function FunnelPage() {
  const session = useFunnelSession();
  const { view } = session;
  const title = view?.state.funnel.title;

  useEffect(() => {
    if (title) document.title = title;
  }, [title]);

  return (
    <div className="funnel-shell">
      <header className="funnel-topbar">{title}</header>
      <main className="funnel-main">
        {session.notice && (
          <p className="funnel-notice" role="status">
            {session.notice}
          </p>
        )}
        {view && <StepView session={session} view={view} />}
        {!view && session.startFailed && <StartError onRetry={session.retryStart} />}
        {!view && !session.startFailed && <StepSkeleton />}
      </main>
      {view && <SessionChip session={view.state.session} />}
    </div>
  );
}
