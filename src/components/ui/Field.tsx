import type { ComponentProps, ReactNode } from 'react';

type FieldProps = Omit<ComponentProps<'label'>, 'children'> & {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
};

function joinClassNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function Field({ label, hint, className, children, ...props }: FieldProps) {
  return (
    <label className={joinClassNames('field', className)} {...props}>
      <span>{label}</span>
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}
