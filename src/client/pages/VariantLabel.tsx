import type { ReactNode } from 'react';

export function VariantLabel({ variant, children }: { variant: string; children?: ReactNode }) {
  return (
    <span className="variant-label">
      <span className="variant-dot" data-variant={variant} aria-hidden="true" />
      {children ?? variant}
    </span>
  );
}
