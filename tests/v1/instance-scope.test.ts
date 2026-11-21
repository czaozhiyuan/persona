import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { buildSignalGraph } from '../../src/engine/v1/signal-graph';
import { editInstanceSettings } from '../../src/state/v1/instance-settings';
import { instantiateModule, pasteModule } from '../../src/state/v1/instantiate-module';
import { createProjectStore } from '../../src/state/v1/project-store';
import { removeTopologyInstance } from '../../src/state/v1/remove-topology-object';
import { editModule } from '../../src/state/v1/topology-edits';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const example = () => parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const roundTrip = (store: ReturnType<typeof createProjectStore>) =>
  createProjectStore(parseProjectJson(serializeProjectJson(store.getSnapshot().project)));
const switchA = ['TX_A', 'optical-switch'];
const switchB = ['TX_B', 'optical-switch'];

test('the TX_A switch changes only its own route and budget and survives undo and saving', () => {
  const store = createProjectStore(example());
  const link = store.getSnapshot().project.namedLinks!.find(item => item.id === 'full')!;
  const query = { frequencyGHz: 1, inputPowerDbm: -20, opticalSources: [
    { endpoint: { instancePath: ['TX_A', 'laser'], portId: 'OUT' }, channelId: 'DWDM_CH28' as const, powerDbm: 0 },
  ] };
  const budget = () => createLinkBudget(store.getSnapshot().project);
  assert.equal(budget().calculateNamedLink(link, query).kind, 'conversion');
  assert.equal(store.commit(project => editInstanceSettings(project, switchA, settings =>
    ({ ...settings, name: '光开关 A', switchStateId: 'block' }))).ok, true);
  const graph = buildSignalGraph(store.getSnapshot().project);
  const passes = (tx: string) => graph.edges.some(edge =>
    edge.source.kind === 'switchRoute' && edge.from.ref.instancePath.join('/') === tx + '/optical-switch');
  assert.equal(passes('TX_A'), false);
  assert.equal(passes('TX_B'), true);
  assert.equal(budget().resolveNamedLink(link, query).status, 'unreachable');
  const restored = roundTrip(store);
  assert.equal(restored.resolveInstance(switchA)?.instance?.switchStateId, 'block');
  assert.equal(restored.resolveInstance(switchA)?.instance?.name, '光开关 A');
  assert.equal(restored.resolveInstance(switchB)?.instance?.switchStateId, 'pass');
  assert.equal(restored.resolveInstance(switchB)?.instance?.name, '光开关');
  store.undo();
  assert.equal(store.resolveInstance(switchA)?.instance?.switchStateId, 'pass');
  assert.equal(budget().resolveNamedLink(link, query).status, 'resolved');
});

test('a mapped loss uses the controlling occurrence and undo restores the inherited value', () => {
  const store = createProjectStore(example());
  const value = { kind: 'fixed', value: 6 } as const;
  const txLoss = (tx: string) => store.resolveInstance([tx, 'mzm'])?.parameters.get('insertionLoss');
  assert.equal(store.commit(project => editInstanceSettings(project, ['TX_A'], settings =>
    ({ ...settings, parameterOverrides: { insertionLoss: value } }))).ok, true);
  assert.deepEqual(txLoss('TX_A'), { value, source: { kind: 'mapped', instancePath: ['TX_A'], parameterId: 'insertionLoss' } });
  assert.deepEqual(txLoss('TX_B')?.value, { kind: 'fixed', value: 3 });
  assert.deepEqual(roundTrip(store).resolveInstance(['TX_A', 'mzm'])?.parameters.get('insertionLoss'), txLoss('TX_A'));
  store.undo();
  assert.deepEqual(txLoss('TX_A')?.value, { kind: 'fixed', value: 3 });
});

test('reuse takes default settings and a copy owns editable nested definitions and saved settings', () => {
  const store = createProjectStore(example());
  let id = 0;
  const allocate = () => 'copy-def-' + ++id;
  assert.equal(store.commit(project => editInstanceSettings(project, switchA, settings =>
    ({ ...settings, switchStateId: 'block' }))).ok, true);
  assert.equal(store.commit(project => instantiateModule(project, ['TX_A'], 'reuse', 'reuse', allocate)).ok, true);
  assert.equal(store.commit(project => instantiateModule(project, ['TX_A'], 'copy', 'copy', allocate)).ok, true);
  const restored = roundTrip(store);
  const instance = (tx: string, child: string) => restored.resolveInstance([tx, child]);
  assert.equal(instance('reuse', 'optical-switch')?.instance?.switchStateId, 'pass');
  assert.equal(instance('copy', 'optical-switch')?.instance?.switchStateId, 'block');
  assert.equal(instance('reuse', 'mzm')?.definition.id, instance('TX_A', 'mzm')?.definition.id);
  assert.notEqual(instance('copy', 'mzm')?.definition.id, instance('TX_A', 'mzm')?.definition.id);
  assert.equal(instance('copy', 'mzm')?.parameters.get('insertionLoss')?.source.kind, 'mapped');
  assert.equal(restored.commit(project => editModule(project, 'tx', definition =>
    ({ ...definition, ports: [...definition.ports, { id: 'NEW_PORT', type: 'RF', direction: 'out' }] }))).ok, true);
  for (const id of ['TX_A', 'TX_B', 'reuse']) {
    assert.ok(restored.resolveInstance([id])?.definition.ports.some(port => port.id === 'NEW_PORT'));
  }
  assert.ok(!restored.resolveInstance(['copy'])?.definition.ports.some(port => port.id === 'NEW_PORT'));
  assert.equal(restored.commit(project => removeTopologyInstance(project, 'tx', 'optical-switch')).ok, true);
  assert.deepEqual(restored.getSnapshot().project.instanceSettings?.map(settings => settings.instancePath), [['copy', 'optical-switch']]);
  restored.undo();
  assert.equal(instance('TX_B', 'optical-switch')?.instance?.switchStateId, 'pass');

  const layout = restored.getSnapshot().project.layout!;
  assert.equal(restored.commit(project => instantiateModule(project, ['layoutDemo'], 'copy', 'layout-copy', allocate)).ok, true);
  const nested = roundTrip(restored);
  const copiedA = nested.resolveInstance(['layout-copy', 'TX_A'])?.definition.id;
  assert.ok(copiedA);
  assert.equal(nested.resolveInstance(['layout-copy', 'TX_B'])?.definition.id, copiedA);
  assert.notEqual(nested.resolveInstance(['layoutDemo', 'TX_A'])?.definition.id, copiedA);
  const copiedLayout = nested.getSnapshot().project.layout!;
  const original = layout.physical!.find(item => item.instancePath[0] === 'layoutDemo')!;
  assert.ok(copiedLayout.physical!.some(item => item.instancePath.join('/') === ['layout-copy', ...original.instancePath.slice(1)].join('/')
    && item.enclosurePath.join('/') === ['layout-copy', ...original.enclosurePath.slice(1)].join('/')));
});

test('clipboard copies the saved module snapshot into a different parent with one history entry', () => {
  const store = createProjectStore(example());
  const copied = store.getSnapshot().project;
  const parent = ['RX_A'];
  let id = 0;
  const allocate = () => 'pasted-def-' + ++id;

  assert.equal(store.commit(project => removeTopologyInstance(project, 'system', 'TX_A')).ok, true);
  const beforePaste = store.getSnapshot().project;
  const paste = (name: string) => store.commit(project => pasteModule(project, copied, ['TX_A'], parent, name, allocate));
  assert.deepEqual(paste('first'), { ok: true });
  assert.deepEqual(paste('second'), { ok: true });
  const restored = roundTrip(store);
  const first = restored.resolveInstance([...parent, 'first'])?.definition;
  const second = restored.resolveInstance([...parent, 'second'])?.definition;
  assert.ok(first?.kind === 'module' && second?.kind === 'module');
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.instances[0].definitionId, second.instances[0].definitionId);
  assert.deepEqual(first.connections, copied.moduleDefinitions.find(module => module.id === 'tx')?.connections);
  assert.deepEqual(store.getSnapshot().project.namedLinks, beforePaste.namedLinks);
  store.undo();
  assert.ok(store.resolveInstance([...parent, 'first']));
  assert.equal(store.resolveInstance([...parent, 'second']), undefined);
  store.undo();
  assert.equal(store.getSnapshot().project, beforePaste);
});
