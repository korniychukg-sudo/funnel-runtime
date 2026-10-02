import type { SessionInfo } from '../../shared/api';

export function SessionChip({ session }: { session: SessionInfo }) {
  const assignment = session.assignmentSource === 'override' ? 'variant forced by URL' : 'variant assigned by hash';
  return (
    <footer className="funnel-footer">
      <span className="session-chip" title={`Session ${session.id}, ${assignment}`}>
        v{session.version} · variant {session.variant} · session {session.id.slice(0, 8)}
      </span>
    </footer>
  );
}
