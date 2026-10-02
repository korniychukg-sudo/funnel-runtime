import { useId } from 'react';
import type { InteractiveStep } from '../../shared/config';
import type { FieldProps } from './QuestionStep';

type NumberFieldProps = FieldProps & {
  step: Extract<InteractiveStep, { type: 'number' }>;
  value: string;
  onChange: (value: string) => void;
};

export function NumberField({ step, value, onChange, labelledBy, describedBy, invalid }: NumberFieldProps) {
  const unitId = useId();
  const { name, min, max, unit, step: increment } = step.input;
  const wholeNumbers = increment === undefined || Number.isInteger(increment);
  return (
    <div className={invalid ? 'number-field is-invalid' : 'number-field'}>
      <input
        type="text"
        name={name}
        inputMode={wholeNumbers ? 'numeric' : 'decimal'}
        autoComplete="off"
        value={value}
        placeholder={min !== undefined && max !== undefined ? `${min}–${max}` : undefined}
        onChange={(event) => onChange(event.target.value)}
        aria-labelledby={unit ? `${labelledBy} ${unitId}` : labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      />
      {unit && (
        <span id={unitId} className="number-unit">
          {unit}
        </span>
      )}
    </div>
  );
}
