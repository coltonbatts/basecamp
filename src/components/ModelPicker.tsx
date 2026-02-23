import type { ModelOption } from '../lib/types';

type ModelPickerProps = {
  models: ModelOption[];
  value: string;
  onChange: (nextModel: string) => void;
};

export function ModelPicker({ models, value, onChange }: ModelPickerProps) {
  return (
    <label className="field">
      <span>Model</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
    </label>
  );
}
