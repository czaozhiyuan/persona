import type { InputRating } from '../../../model/v1/device';
import { isPowerPort } from '../../../model/v1/types';
import type { PortDirection, PortType } from '../../../model/v1/types';
import { choice, numberField } from './value-fields';

export function ratingUnits(type: PortType, direction: PortDirection): readonly InputRating['unit'][] {
  if (direction !== 'in' || type === 'CONTROL') return [];
  return isPowerPort(type) ? ['V', 'A', 'W'] : ['dBm'];
}

export function readInputRating(data: FormData, units: readonly InputRating['unit'][]): InputRating | undefined {
  const unit = units.find(candidate => candidate === choice(data, 'ratingUnit'));
  if (unit === undefined) return;
  const min = numberField(data, 'minimum');
  const max = numberField(data, 'maximum');
  if (min !== undefined || max !== undefined) return { unit, min, max };
}

export function InputRatingField({ units, rating }: { units: readonly InputRating['unit'][]; rating?: InputRating }) {
  return <fieldset>
    <legend>输入额定范围（可选）</legend>
    <label>单位<select name="ratingUnit" defaultValue={rating && units.includes(rating.unit) ? rating.unit : units[0]}
      onChange={event => {
        if (event.currentTarget.value === rating?.unit) return;
        // Clear old bounds before the owning form reads values in the new unit.
        event.currentTarget.form?.querySelectorAll<HTMLInputElement>('input[name="minimum"], input[name="maximum"]')
          .forEach(input => { input.value = ''; });
      }}>
      {units.map(unit => <option key={unit}>{unit}</option>)}
    </select></label>
    <div className="v1-property-pair">
      <label>下限<input name="minimum" type="number" step="any" defaultValue={rating?.min} /></label>
      <label>上限<input name="maximum" type="number" step="any" defaultValue={rating?.max} /></label>
    </div>
  </fieldset>;
}
