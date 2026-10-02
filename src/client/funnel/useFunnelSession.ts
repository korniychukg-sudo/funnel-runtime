import { useEffect, useRef, useState } from 'react';
import type { CreateSessionRequest, IncomingEvent, SessionState } from '../../shared/api';
import type { AnswerValue } from '../../shared/conditions';
import { nextStepId, prevStepId, resultStepId } from '../../shared/engine';
import {
  createSession,
  errorMessage,
  fetchSession,
  isConflict,
  isSessionGone,
  navigateTo,
  requestResult,
  submitAnswer,
} from '../api';
import * as events from '../events';
import { browserStorage, sharedOutbox, type KeyValueStorage } from '../outbox';

const SESSION_KEY = 'funnel.sessionId';
const EXPANDED_KEY_PREFIX = 'funnel.expanded.';
const HISTORY_MARKER = 'funnelStep';
const EXPIRED_NOTICE = 'Your previous session has expired, so we started a new one.';
const CONFLICT_NOTICE = 'That step is no longer available, so we reloaded your progress.';

export type FunnelView = { state: SessionState; seq: number };

function sessionRequestFromUrl(): CreateSessionRequest {
  const storage = browserStorage();
  const url = new URL(window.location.href);
  if (url.searchParams.get('reset') === '1') {
    const previous = storage.getItem(SESSION_KEY);
    if (previous) storage.removeItem(expandedKey(previous));
    storage.removeItem(SESSION_KEY);
    url.searchParams.delete('reset');
    window.history.replaceState(window.history.state, '', url);
  }
  const param = (name: string) => url.searchParams.get(name) || null;
  return {
    sessionId: storage.getItem(SESSION_KEY),
    variant: param('variant'),
    utm: { source: param('utm_source'), medium: param('utm_medium'), campaign: param('utm_campaign') },
  };
}

export function expandedKey(sessionId: string): string {
  return `${EXPANDED_KEY_PREFIX}${sessionId}`;
}

export function readExpandedResult(sessionId: string, storage: KeyValueStorage = browserStorage()): string | null {
  try {
    return storage.getItem(expandedKey(sessionId));
  } catch {
    return null;
  }
}

export function saveExpandedResult(
  sessionId: string,
  resultId: string,
  storage: KeyValueStorage = browserStorage(),
): void {
  try {
    storage.setItem(expandedKey(sessionId), resultId);
  } catch (error) {
    console.warn('The opened action list could not be remembered.', error);
  }
}

export function isReplacedSession(request: CreateSessionRequest, state: SessionState): boolean {
  return (
    Boolean(request.sessionId) &&
    state.session.id !== request.sessionId &&
    !state.resumed &&
    state.session.assignmentSource !== 'override'
  );
}

export function startOverHref(): string {
  const params = new URLSearchParams(window.location.search);
  params.set('reset', '1');
  return `${window.location.pathname}?${params}`;
}

function isAtResult(state: SessionState): boolean {
  return state.currentStepId === resultStepId(state.funnel);
}

function isHistoryMarker(historyState: unknown): boolean {
  return typeof historyState === 'object' && historyState !== null && HISTORY_MARKER in historyState;
}

function hasPreviousStep(view: FunnelView | null): boolean {
  return view !== null && prevStepId(view.state.funnel, view.state.answers, view.state.currentStepId) !== null;
}

function emit(event: IncomingEvent | null): void {
  if (event) sharedOutbox().enqueue(event);
}

export function useFunnelSession() {
  const [view, setView] = useState<FunnelView | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failedResultSeq, setFailedResultSeq] = useState<number | null>(null);
  const viewRef = useRef<FunnelView | null>(null);
  const sessionRequest = useRef<CreateSessionRequest | null>(null);
  const busyRef = useRef(false);
  const pendingBack = useRef(false);
  const started = useRef(false);
  const viewedSeq = useRef(0);
  const resultRequestedSeq = useRef(0);
  const resultViewedSeq = useRef(0);

  const canGoBack = hasPreviousStep(view);

  function show(state: SessionState) {
    const current = viewRef.current;
    const sameStep =
      current !== null &&
      current.state.session.id === state.session.id &&
      current.state.currentStepId === state.currentStepId;
    const next = { state, seq: sameStep ? current.seq : (current?.seq ?? 0) + 1 };
    viewRef.current = next;
    setView(next);
    browserStorage().setItem(SESSION_KEY, state.session.id);
  }

  async function start() {
    setStartFailed(false);
    try {
      const request = (sessionRequest.current ??= sessionRequestFromUrl());
      const state = await createSession(request);
      show(state);
      if (isReplacedSession(request, state)) setNotice(EXPIRED_NOTICE);
    } catch {
      setStartFailed(true);
    }
  }

  async function recover(error: unknown, sessionId: string) {
    try {
      if (isSessionGone(error)) {
        show(await createSession({ ...sessionRequest.current, sessionId: null }));
        setNotice(EXPIRED_NOTICE);
      } else if (isConflict(error)) {
        show(await fetchSession(sessionId));
        setNotice(CONFLICT_NOTICE);
      } else {
        setStepError(errorMessage(error));
      }
    } catch (recoveryError) {
      setStepError(errorMessage(recoveryError));
    }
  }

  async function run(task: (state: SessionState) => Promise<void>) {
    const current = viewRef.current;
    if (!current || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setStepError(null);
    setNotice(null);
    try {
      await task(current.state);
    } catch (error) {
      await recover(error, current.state.session.id);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    if (pendingBack.current) {
      pendingBack.current = false;
      if (hasPreviousStep(viewRef.current)) goBack();
    }
  }

  function submit(value: AnswerValue | null) {
    void run(async (state) => {
      const stepId = state.currentStepId;
      const next = await submitAnswer(state.session.id, { stepId, value });
      emit(events.answerSubmitted(next, stepId));
      emit(events.stepCompleted(next, stepId, next.currentStepId));
      show(next);
    });
  }

  function advance() {
    void run(async (state) => {
      const target = nextStepId(state.funnel, state.answers, state.currentStepId);
      if (target) show(await navigateTo(state.session.id, { stepId: target }));
    });
  }

  function goBack() {
    void run(async (state) => {
      const target = prevStepId(state.funnel, state.answers, state.currentStepId);
      if (!target) return;
      const next = await navigateTo(state.session.id, { stepId: target });
      emit(events.backClicked(next, state.currentStepId, target));
      show(next);
    });
  }

  async function loadResult(target: FunnelView) {
    setFailedResultSeq(null);
    try {
      const next = await requestResult(target.state.session.id);
      if (viewRef.current?.seq === target.seq) show(next);
    } catch (error) {
      if (viewRef.current?.seq !== target.seq) return;
      if (isSessionGone(error)) await recover(error, target.state.session.id);
      else setFailedResultSeq(target.seq);
    }
  }

  function retryResult() {
    if (viewRef.current) void loadResult(viewRef.current);
  }

  function clickCta(expanding: boolean) {
    const state = viewRef.current?.state;
    if (!state?.result) return;
    emit(events.ctaClicked(state, state.result));
    if (expanding) emit(events.recommendationExpanded(state, state.result));
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void start();
  }, []);

  useEffect(() => {
    if (!view || viewedSeq.current === view.seq) return;
    viewedSeq.current = view.seq;
    emit(events.stepViewed(view.state, view.state.currentStepId));
  }, [view]);

  useEffect(() => {
    if (!view || !isAtResult(view.state) || view.state.result) return;
    if (resultRequestedSeq.current === view.seq) return;
    resultRequestedSeq.current = view.seq;
    void loadResult(view);
  }, [view]);

  useEffect(() => {
    const result = view?.state.result;
    if (!view || !result || !isAtResult(view.state) || resultViewedSeq.current === view.seq) return;
    resultViewedSeq.current = view.seq;
    emit(events.resultViewed(view.state, result));
  }, [view]);

  useEffect(() => {
    if (canGoBack && !busy && !isHistoryMarker(window.history.state)) {
      window.history.pushState({ [HISTORY_MARKER]: true }, '');
    }
  }, [canGoBack, busy]);

  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      if (isHistoryMarker(event.state) || !canGoBack) return;
      if (busyRef.current) pendingBack.current = true;
      else goBack();
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  });

  return {
    view,
    startFailed,
    busy,
    stepError,
    notice,
    canGoBack,
    resultFailed: view !== null && failedResultSeq === view.seq,
    retryStart: () => void start(),
    submit,
    advance,
    goBack,
    retryResult,
    clickCta,
    clearStepError: () => setStepError(null),
  };
}

export type FunnelSession = ReturnType<typeof useFunnelSession>;
