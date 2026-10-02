import { useCallback, useEffect, useState } from 'react';
import type { AdminOverview } from '../../shared/api';
import {
  activateVersion,
  asRequestError,
  fetchOverview,
  isUnauthorized,
  publishVersion,
  rollbackVersion,
  type RequestError,
} from '../adminApi';
import { ActivationLog } from './ActivationLog';
import { ActiveVersionCard } from './ActiveVersionCard';
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog';
import { ErrorNotice } from './ErrorNotice';
import { ImportPanel } from './ImportPanel';
import { InternalNav } from './InternalNav';
import { QuickLinks } from './QuickLinks';
import { TokenForm } from './TokenForm';
import { VersionsTable } from './VersionsTable';
import './internal.css';
import './admin.css';

type PendingAction = ConfirmRequest & {
  run: () => Promise<AdminOverview>;
  success: string;
};

const TOAST_MS = 6000;

function publishAction(version: number, active: number | null): PendingAction {
  const points = [`v${version} becomes the active version immediately: every new session starts on it.`];
  if (active !== null) {
    points.push(`Sessions already running on v${active} or older versions keep their pinned version.`);
    points.push(`If something looks wrong, roll back to v${active} from the active version card.`);
  }
  return {
    title: `Publish v${version}?`,
    points,
    confirmLabel: `Publish v${version}`,
    tone: 'primary',
    run: () => publishVersion(version),
    success: `v${version} is published and active. New sessions start on v${version}.`,
  };
}

function activateAction(version: number, active: number | null): PendingAction {
  const points = [
    `New sessions will start on v${version}.`,
    'Sessions already running keep the version they started on.',
  ];
  if (active !== null) points.push(`A rollback afterwards returns new sessions to v${active}.`);
  return {
    title: `Activate v${version}?`,
    points,
    confirmLabel: `Activate v${version}`,
    tone: 'primary',
    run: () => activateVersion(version),
    success: `v${version} is active. New sessions start on v${version}.`,
  };
}

function rollbackAction(active: number | null, target: number): PendingAction {
  const from = active === null ? 'the current version' : `v${active}`;
  return {
    title: `Roll back to v${target}?`,
    points: [
      `New sessions will start on v${target}.`,
      `Sessions already pinned to ${from} keep their version and can finish on it. Their events stay in analytics.`,
      `${from} is marked as rolled back. You can activate it again later.`,
    ],
    confirmLabel: `Roll back to v${target}`,
    tone: 'danger',
    run: rollbackVersion,
    success: `Rolled back to v${target}. Sessions pinned to ${from} continue on it.`,
  };
}

export default function AdminPage() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loadError, setLoadError] = useState<RequestError | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<RequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  const handleUnauthorized = useCallback(() => setNeedsToken(true), []);

  useEffect(() => {
    let ignore = false;
    fetchOverview().then(
      (data) => {
        if (ignore) return;
        setOverview(data);
        setLoadError(null);
      },
      (failure: unknown) => {
        if (ignore) return;
        const requestError = asRequestError(failure);
        if (isUnauthorized(requestError)) setNeedsToken(true);
        else setLoadError(requestError);
      },
    );
    return () => {
      ignore = true;
    };
  }, [reloadKey]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function ask(action: PendingAction) {
    setActionError(null);
    setPending(action);
  }

  async function confirmPending() {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    try {
      setOverview(await pending.run());
      setToast(pending.success);
      setPending(null);
    } catch (failure) {
      const requestError = asRequestError(failure);
      if (isUnauthorized(requestError)) {
        setPending(null);
        setNeedsToken(true);
      } else {
        setActionError(requestError);
        reload();
      }
    } finally {
      setBusy(false);
    }
  }

  function tokenSaved() {
    setNeedsToken(false);
    reload();
  }

  const activeVersion = overview?.activeVersion ?? null;

  return (
    <div className="internal-shell admin-page">
      <InternalNav active="/admin" />
      <header className="page-header">
        <h1>Funnel versions</h1>
        <p>
          New sessions always start on the active version. A session keeps the version and variant it started with,
          so publishing or rolling back never breaks people who are halfway through.
        </p>
      </header>

      {needsToken ? (
        <TokenForm onSaved={tokenSaved} />
      ) : (
        <>
          {loadError && <ErrorNotice error={loadError} onRetry={reload} />}
          {!overview && !loadError && <p className="muted">Loading versions…</p>}
          {overview && (
            <>
              <div className="admin-top">
                <ActiveVersionCard
                  overview={overview}
                  busy={busy}
                  onRollback={(target) => ask(rollbackAction(activeVersion, target))}
                />
                <QuickLinks />
              </div>
              <VersionsTable
                versions={overview.versions}
                busy={busy}
                onPublish={(version) => ask(publishAction(version.version, activeVersion))}
                onActivate={(version) => ask(activateAction(version.version, activeVersion))}
                onUnauthorized={handleUnauthorized}
              />
              <ImportPanel fixtures={overview.fixtures} onImported={reload} onUnauthorized={handleUnauthorized} />
              <ActivationLog activations={overview.activations} />
            </>
          )}
        </>
      )}

      <ConfirmDialog
        request={pending}
        busy={busy}
        error={actionError}
        onCancel={() => setPending(null)}
        onConfirm={confirmPending}
      />

      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div className="toast">
            <span>{toast}</span>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
