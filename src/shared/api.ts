import type { Answers } from './conditions';
import type { FunnelResult, StepType } from './config';
import type { ResolvedFunnel } from './engine';

export type Utm = { source: string | null; medium: string | null; campaign: string | null };

export type AssignmentSource = 'hash' | 'override';

export type SessionInfo = {
  id: string;
  funnelId: string;
  version: number;
  experimentId: string;
  variant: string;
  assignmentSource: AssignmentSource;
  utm: Utm;
  runId: string | null;
  createdAt: string;
  expiresAt: string;
};

export type SessionState = {
  session: SessionInfo;
  funnel: ResolvedFunnel;
  answers: Answers;
  currentStepId: string;
  resultId: string | null;
  result: FunnelResult | null;
  resumed: boolean;
};

export type CreateSessionRequest = {
  sessionId?: string | null;
  variant?: string | null;
  utm?: Partial<Utm>;
  runId?: string | null;
};

export type SubmitAnswerRequest = { stepId: string; value: unknown };

export type NavigateRequest = { stepId: string };

export type ApiError = { error: string; message: string; details?: unknown };

export const CORE_EVENTS = [
  'session_started',
  'step_viewed',
  'answer_submitted',
  'step_completed',
  'back_clicked',
  'result_viewed',
  'cta_clicked',
] as const;

export type IncomingEvent = {
  event_id: string;
  session_id: string;
  name: string;
  client_timestamp: string;
  step_id?: string | null;
  funnel_id?: string;
  funnel_version?: number;
  experiment_id?: string;
  variant?: string;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  properties?: Record<string, unknown>;
};

export type EventsRequest = { events: IncomingEvent[] };

export type EventItemStatus = 'accepted' | 'duplicate' | 'rejected';

export type EventItemResult = {
  index: number;
  event_id: string | null;
  status: EventItemStatus;
  reason?: string;
};

export type EventsResponse = {
  accepted: number;
  duplicates: number;
  rejected: number;
  results: EventItemResult[];
};

export const MAX_EVENTS_PER_BATCH = 500;

export type VersionStatus = 'draft' | 'published' | 'rolled_back';

export type VersionSummary = {
  version: number;
  funnelId: string;
  title: string;
  status: VersionStatus;
  isActive: boolean;
  releaseNote: string | null;
  experimentId: string;
  variants: string[];
  createdAt: string;
  publishedAt: string | null;
  sessions: number;
  events: number;
};

export type ActivationAction = 'seed' | 'publish' | 'activate' | 'rollback';

export type Activation = {
  id: number;
  version: number;
  action: ActivationAction;
  fromVersion: number | null;
  at: string;
};

export type AdminOverview = {
  activeVersion: number | null;
  rollbackTarget: number | null;
  versions: VersionSummary[];
  activations: Activation[];
  fixtures: string[];
  adminTokenRequired: boolean;
};

export type Rate = number | null;

export type AnalyticsQuery = {
  utmCampaign?: string;
  version?: number;
  runId?: string;
  includeOverrides?: boolean;
};

export type FunnelStepStats = {
  stepId: string;
  type: StepType;
  conditional: boolean;
  reached: number;
  progressed: number;
  dropped: number;
  conversion: Rate;
  dropOffRate: Rate;
  views: number;
};

export type KpiStats = {
  started: number;
  reachedResult: number;
  resultRate: Rate;
  ctaClicked: number;
  ctr: Rate;
  startedToCta: Rate;
};

export type VersionStats = KpiStats & { version: number; experimentId: string };

export type VariantStats = KpiStats & { version: number; experimentId: string; variant: string };

export type ExperimentComparison = {
  version: number;
  experimentId: string;
  metric: 'startedToCta';
  variants: VariantStats[];
  absoluteDiff: Rate;
  relativeLift: Rate;
  pValue: number | null;
  significant: boolean | null;
  excludedOverrideSessions: number;
};

export type FunnelBreakdown = {
  version: number;
  experimentId: string;
  variant: string;
  started: number;
  steps: FunnelStepStats[];
  reachedResult: number;
  ctaClicked: number;
};

export type ResultMixRow = { version: number; variant: string; resultId: string; sessions: number };

export type DataQuality = {
  eventsStored: number;
  duplicatesDropped: number;
  rejectedEvents: number;
  repeatedStepViews: number;
  backClicks: number;
  outOfOrderEvents: number;
  sessionsWithOutOfOrderEvents: number;
};

export type AnalyticsResponse = {
  generatedAt: string;
  filters: { utmCampaign: string | null; version: number | null; runId: string | null; includeOverrides: boolean };
  available: { campaigns: string[]; versions: number[] };
  totals: KpiStats;
  versions: VersionStats[];
  experiments: ExperimentComparison[];
  funnels: FunnelBreakdown[];
  resultMix: ResultMixRow[];
  dataQuality: DataQuality;
};
