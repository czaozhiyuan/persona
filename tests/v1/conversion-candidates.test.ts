import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentDefinition, PortDefinition } from '../../src/model/v1/types';
import { conversionCandidates } from '../../src/workbench/v1/properties/add-conversion';

const port = (id: string, type: PortDefinition['type'], direction: PortDefinition['direction']): PortDefinition =>
  ({ id, type, direction });
const definition: ComponentDefinition = { kind: 'component', id: 'custom', name: 'Custom', ports: [
  port('a', 'RF', 'in'), port('b', 'OPTICAL', 'in'), port('c', 'RF', 'in'), port('supply', 'DC_POWER', 'in'),
  port('d', 'OPTICAL', 'out'), port('e', 'OPTICAL', 'out'), port('f', 'RF', 'out'), port('flag', 'CONTROL', 'out'),
] };
const pairs = (device: ComponentDefinition) => conversionCandidates(device)
  .map(({ input, outputs }) => [input.id, outputs.map(output => output.id)]);

test('offers only unused cross-domain pairs in definition order', () => {
  assert.deepEqual(pairs({ ...definition, transfers: [
    { kind: 'dml', fromPortId: 'a', toPortId: 'd' }, { kind: 'eo', fromPortId: 'c', toPortId: 'e' },
  ] }), [['a', ['e']], ['b', ['f', 'flag']], ['c', ['d']]]);
});

test('omits exhausted inputs and components without a suitable output', () => {
  const ports = [port('i', 'OPTICAL', 'in'), port('o', 'RF', 'out')];
  assert.deepEqual(pairs({ ...definition, ports, transfers: [{ kind: 'oe', fromPortId: 'i', toPortId: 'o' }] }), []);
  assert.deepEqual(pairs({ ...definition, ports: [ports[0], { ...ports[1], direction: 'in' }] }), []);
  assert.deepEqual(pairs({ ...definition, ports: [ports[0], { ...ports[1], type: 'OPTICAL' }] }), []);
});
