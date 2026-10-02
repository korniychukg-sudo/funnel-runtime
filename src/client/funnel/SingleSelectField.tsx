import type { InteractiveStep } from '../../shared/config';
import type { FieldProps } from './QuestionStep';

type SingleSelectFieldProps = FieldProps & {
  step: Extract<InteractiveStep, { type: 'single-select' }>;
  value: string;
  onChange: (value: string) => void;
};

export function SingleSelectField({ step, value, onChange, labelledBy, describedBy, invalid }: SingleSelectFieldProps) {
  return (
    <div
      className="options"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
    >
      {step.input.options.map((option) => {
        const checked = value === option.value;
        return (
          <label key={option.value} className={checked ? 'option is-selected' : 'option'}>
            <input
              type="radio"
              name={step.input.name}
              value={option.value}
              checked={checked}
              onChange={() => onChange(option.value)}
            />
            <span className="option-mark" aria-hidden="true" />
            <span className="option-label">{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}
