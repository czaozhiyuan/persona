import { Fragment, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export function AutosaveForm({ version, save, children }: {
  version: string; save: (data: FormData) => string | undefined; children: ReactNode;
}) {
  const [fields, setFields] = useState({ version, revision: 0 });
  const focusedValue = useRef<string>(undefined);
  const [invalid, setInvalid] = useState(false);
  // Reset inputs on external changes such as undo, but keep focus after this form saves.
  if (version !== fields.version) {
    setFields({ version, revision: fields.revision + 1 });
    setInvalid(false);
  }

  function apply(form: HTMLFormElement) {
    const valid = form.checkValidity();
    setInvalid(!valid);
    if (!valid) return;
    const savedVersion = save(new FormData(form));
    if (savedVersion !== undefined && savedVersion !== fields.version) {
      setFields({ ...fields, version: savedVersion });
    }
  }

  return <form noValidate onSubmit={event => {
    event.preventDefault();
    apply(event.currentTarget);
  }} onFocus={event => {
    const field = event.target;
    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) focusedValue.current = field.value;
  }} onBlur={event => {
    const field = event.target;
    if (event.relatedTarget instanceof HTMLElement && event.relatedTarget.hasAttribute('data-skip-autosave')) return;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.name
      && (field.value !== focusedValue.current || (field instanceof HTMLInputElement && field.validity.badInput))) {
      apply(event.currentTarget);
    }
  }} onKeyDown={event => {
    const field = event.target;
    if (event.key !== 'Enter' || !(field instanceof HTMLInputElement)) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (field.name) {
      apply(event.currentTarget);
      focusedValue.current = field.value;
    }
  }} onChange={event => {
    const field = event.target;
    if (field instanceof HTMLSelectElement && field.name) apply(event.currentTarget);
  }}>
    <Fragment key={fields.revision}>{children}</Fragment>
    {invalid && <p className="error" role="alert">请填写有效的字段值。</p>}
  </form>;
}
