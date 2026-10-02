import type { InteractiveStep } from '../../shared/config';
import type { FieldProps } from './QuestionStep';

type MultiSelectFieldProps = FieldProps & {
  step: Extract<InteractiveStep, { type: 'multi-select' }>;
  value: string[];
  onChange: (value: string[]) => void;
};

function optionClass(checked: boolean, disabled: boolean): string {
  if (checked) return 'option is-selected';
  return disabled ? 'option is-disabled' : 'option';
}

export function MultiSelectField({ step, value, onChange, labelledBy, describedBy, invalid }: MultiSelectFieldProps) {
  const max = step.validation.maxSelections;
  const atMax = max !== undefined && value.length >= max;

  function toggle(optionValue: string) {
    const selected = new Set(value);
    if (selected.has(optionValue)) selected.delete(optionValue);
    else selected.add(optionValue);
    onChange(step.input.options.map((option) => option.value).filter((item) => selected.has(item)));
  }

  return (
    <>
      <div
        className="options"
        role="group"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      >
        {step.input.options.map((option) => {
          const checked = value.includes(option.value);
          const disabled = atMax && !checked;
          return (
            <label key={option.value} className={optionClass(checked, disabled)}>
              <input
                type="checkbox"
                name={step.input.name}
                value={option.value}
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(option.value)}
              />
              <span className="option-mark is-checkbox" aria-hidden="true" />
              <span className="option-label">{option.label}</span>
            </label>
          );
        })}
      </div>
      <p className={atMax ? 'selection-count is-full' : 'selection-count'} aria-live="polite">
        {max === undefined ? `${value.length} selected` : `${value.length} of ${max} selected`}
      </p>
    </>
  );
}
