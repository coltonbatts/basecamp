import type { ModelOption } from '../lib/types';
import { Field } from './ui/Field';

type ModelPickerProps = {
  models: ModelOption[];
  value: string;
  onChange: (nextModel: string) => void;
};

export function ModelPicker({ models, value, onChange }: ModelPickerProps) {
  return (
    <Field label="Model">
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
    </Field>
  );
}
