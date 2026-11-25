import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { calculateDcBudget } from '../../src/engine/v1/dc-budget';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { factory, factoryLibrary, parseLibrary } from '../../src/library/v1/user-library';
import type { ComponentDefinition, PortDefinition, Project } from '../../src/model/v1/types';
import { createProjectStore } from '../../src/state/v1/project-store';
import { planPortDeletion } from '../../src/state/v1/topology-edits';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { createServer } from 'vite';

const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const rails = [5, 12, 24];
const output = (v: number): PortDefinition => ({ id: 'rail' + v, type: 'DC_POWER', direction: 'out', outputVoltageV: fixed(v) });
const source: ComponentDefinition = { kind: 'component', id: 's', name: 'Source', dcSupply: true, ports: [
  { ...output(5), supplyCapacity: { unit: 'W', value: fixed(4) } },
  { ...output(12), supplyCapacity: { unit: 'A', value: fixed(0.5) } }, output(24),
] };
const devices: ComponentDefinition[] = [source, ...rails.map((v, i): ComponentDefinition => ({
  kind: 'component', id: 'load' + v, name: 'Load ' + v, ports: [{ id: 'in', type: 'DC_POWER', direction: 'in', inputRating: { unit: 'V', min: v - 1, max: v + 1 } }],
  dcLoad: { portId: 'in', powerW: fixed([1, 8, 3][i]) },
}))];
const project: Project = { id: 'rails', name: 'Rails', rootModuleDefinitionId: 'root', componentDefinitions: devices, moduleDefinitions: [
  { kind: 'module', id: 'root', name: 'Root', ports: [], instances: devices.map(d => ({ id: d.id, definitionId: d.id, name: d.name })),
    connections: rails.map(v => ({ id: 'feed' + v, from: { instanceId: source.id, portId: 'rail' + v }, to: { instanceId: 'load' + v, portId: 'in' } })) },
] };

test('independent rails keep load, rated capacity, margin and voltage checks local to their stable port IDs', () => {
  const store = createProjectStore(parseProjectJson(serializeProjectJson(project)));
  const result = () => calculateDcBudget(store.getSnapshot().project);
  const before = result();
  const metric = (m: { availability: string; value?: number }) => m.availability === 'available' ? m.value : undefined;
  assert.deepEqual(before.supplies.map(s => [s.endpoint.portId, metric(s.voltageV), metric(s.demandW), metric(s.capacityW), metric(s.marginW)]),
    [['rail5', 5, 1, 4, 3], ['rail12', 12, 8, 6, -2], ['rail24', 24, 3, undefined, undefined]]);
  for (const v of [15, 5, undefined]) {
    assert.ok(store.commit(p => ({ ...p, componentDefinitions: p.componentDefinitions.map(d => d.id === source.id ? { ...d,
      ports: d.ports.map(port => port.id === 'rail12' ? { ...port, outputVoltageV: v === undefined ? undefined : fixed(v) } : port) } : d) })).ok);
    const next = result();
    assert.deepEqual(next.supplies[0], before.supplies[0]);
    assert.deepEqual(next.supplies[2], before.supplies[2]);
    assert.equal(metric(next.supplies[1].capacityW), v === undefined ? undefined : v * 0.5);
    assert.deepEqual(next.ports.filter(p => p.rating).map(p => p.rating!.status), ['within_range', v === undefined ? 'unknown' : v === 5 ? 'below_min' : 'above_max', 'within_range']);
  }
  const old = store.getSnapshot().project;
  const remove = planPortDeletion(old, source.id, 'rail12')!;
  assert.ok(store.commit(() => remove.project).ok);
  assert.deepEqual(result().supplies.map(s => s.endpoint.portId), ['rail5', 'rail24']);
  assert.equal(store.getSnapshot().project.moduleDefinitions[0].connections?.length, 2);
  store.undo();
  assert.deepEqual(store.getSnapshot().project, old);
  assert.deepEqual(parseLibrary(JSON.stringify({ ...factoryLibrary(), custom: [source] })).custom, [source]);
});

test('port editor uses direct values on supply outputs and clears capacity on retyping', async t => {
  const vite = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  t.after(() => vite.close());
  const { PortFields, readPort } = await vite.ssrLoadModule('/src/workbench/v1/properties/device-fields.tsx') as typeof import('../../src/workbench/v1/properties/device-fields');
  const definition = { ...source, parameters: [{ id: 'otherV', kind: 'numeric' as const, name: 'Unrelated voltage', unit: 'V' as const,
    valueKind: 'fixed' as const, range: { min: 1 }, overridable: true }] };
  const occurrence = resolveHierarchy({ ...project, componentDefinitions: [definition, ...devices.slice(1)] }).resolveInstance(['s'])!;
  const render = (d: ComponentDefinition) => renderToStaticMarkup(createElement(PortFields, {
    port: d.ports[0], occurrence: { ...occurrence, definition: d }, save: () => true, remove: () => {},
  }));
  const html = render(definition);
  assert.match(html, /name="outputVoltageV"/);
  assert.match(html, /name="supplyCapacity"/);
  assert.doesNotMatch(html, /outputVoltageParameter|name="name"/);
  const other = { ...definition, dcSupply: false, ports: [output(5)] };
  assert.match(render(other), /name="outputVoltageParameter"/);
  assert.doesNotMatch(render(other), /name="supplyCapacity"/);
  const data = new FormData();
  for (const [key, value] of Object.entries({ type: 'AC_POWER', direction: 'out', outputVoltageV: '5', supplyUnit: 'W', supplyCapacity: '4' })) data.set(key, value);
  const changed = readPort(data, source.ports[0]);
  assert.equal(changed.outputVoltageV, undefined);
  assert.equal(changed.supplyCapacity, undefined);
  for (const id of ['library-dc-supply', 'library-dc-converter']) {
    const d = factory.get(id)!;
    assert.ok(!d.parameters?.some(p => p.id === 'voltage'));
    const power = d.ports.find(p => p.id === 'DC_OUT')!;
    assert.deepEqual(power.outputVoltageV, fixed(5));
    assert.deepEqual(power.supplyCapacity, id === 'library-dc-supply' ? { unit: 'W', value: fixed(60) } : undefined);
  }
});
