import type { ExperimentComparison, VariantStats } from '../../shared/api';
import { formatPValue, formatRate } from './format';

export function byVariant(variants: VariantStats[]): VariantStats[] {
  return [...variants].sort((a, b) => a.variant.localeCompare(b.variant));
}

export function describeExperiment(experiment: ExperimentComparison): string {
  const variants = byVariant(experiment.variants);
  if (variants.length < 2) return 'Only one variant has sessions in this view, so there is nothing to compare yet.';
  if (variants.length > 2) return 'The significance test covers exactly two variants.';
  const [baseline, challenger] = variants;
  const diff = experiment.absoluteDiff;
  if (diff === null) return 'Both variants need started sessions before they can be compared.';

  const points = Math.abs(diff * 100).toFixed(1);
  const rates = `(${formatRate(baseline.startedToCta)} vs ${formatRate(challenger.startedToCta)} started → CTA)`;
  if (Number(points) === 0) return `${baseline.variant} and ${challenger.variant} convert equally so far ${rates}.`;

  const direction = diff > 0 ? 'better' : 'worse';
  const claim = `${challenger.variant} converts ${points} pp ${direction} than ${baseline.variant} ${rates}`;
  if (experiment.significant === null) return `${claim}; there is not enough data for a significance test yet.`;
  if (experiment.significant) return `${claim}, and the difference is significant at 95% (p ${pText(experiment.pValue)}).`;
  return `${claim}, but the difference is not significant yet (p ${pText(experiment.pValue)}).`;
}

function pText(pValue: number | null): string {
  const text = formatPValue(pValue);
  return text.startsWith('<') ? text : `= ${text}`;
}
