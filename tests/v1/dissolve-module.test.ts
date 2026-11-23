import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import type { Project } from '../../src/model/v1/types';
import { planDissolveModule } from '../../src/state/v1/dissolve-module';
import { groupModule } from '../../src/state/v1/group-module';
import { createProjectStore } from '../../src/state/v1/project-store';
import { editModule } from '../../src/state/v1/topology-edits';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const read = () => parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const round = (project: Project) => parseProjectJson(serializeProjectJson(project));
const part = (project: Project, id: string) => project.moduleDefinitions.find(item => item.id === id);
const setup = () => {
  const project = read();
  return { ...project, namedLinks: project.namedLinks?.map(link => link.id === 'full' ? {
    ...link, trial: { frequencyGHz: 1, inputPowerDbm: -20, opticalSources: [
      { endpoint: { instancePath: ['TX_A', 'laser'], portId: 'OUT' }, channelId: 'DWDM_CH28' as const, powerDbm: 0 },
    ] },
  } : link) };
};
const full = (project: Project) => project.namedLinks!.find(link => link.id === 'full')!;

test('dissolving a shared slot lifts its children, preserves the original budget and leaves another use of the definition alone', () => {
  const base = setup();
  const grouped = groupModule(base, [['TX_A', 'laser'], ['TX_A', 'mzm']], '发射模块', 'group', 'group-def');
  const updated = editModule(grouped, 'system', root => ({
    ...root, instances: [...root.instances, { id: 'independent-usage', name: '另用', definitionId: 'group-def' }],
  }));
  const fixture: Project = { ...updated, instanceSettings: [...(updated.instanceSettings ?? []),
    { instancePath: ['TX_B', 'group', 'mzm'], name: 'B 机箱调制器' }] };
  const store = createProjectStore(fixture);
  const before = store.getSnapshot();
  const plan = planDissolveModule(before.project, ['TX_A', 'group']);
  assert.ok(plan.ok, !plan.ok ? plan.message : undefined);
  assert.deepEqual(plan.affected, [['TX_A', 'group'], ['TX_B', 'group']]);
  assert.equal(plan.insideWires, 1);
  assert.ok(plan.outsideWires > 0);
  assert.equal(store.getSnapshot(), before);
  assert.deepEqual(store.commit(() => plan.project), { ok: true });
  const after = round(store.getSnapshot().project);
  assert.ok(!part(after, 'tx')?.instances.some(item => item.id === 'group'));
  assert.deepEqual(part(after, 'group-def'), part(before.project, 'group-def'));
  assert.deepEqual(full(after), full(base));
  assert.equal(store.resolveInstance(['TX_B', 'mzm'])?.instance?.name, 'B 机箱调制器');
  assert.deepEqual(after.layout?.physical, base.layout?.physical);
  assert.deepEqual(store.resolveInstance(['TX_A', 'mzm'])?.parameters.get('insertionLoss')?.value, { kind: 'fixed', value: 3 });
  assert.deepEqual(createLinkBudget(after).calculateNamedLink(full(after), full(after).trial!).powerDbm,
    createLinkBudget(base).calculateNamedLink(full(base), full(base).trial!).powerDbm);
  store.undo();
  assert.equal(store.getSnapshot().project, before.project);
  assert.equal(store.getSnapshot().canUndo, false);
  store.redo();
  assert.deepEqual(round(store.getSnapshot().project), after);
});

test('lifting nested enclosures retains descendants, whole internal fibre bundles and required references', () => {
  const base = setup();
  const grouped = groupModule(base, [['TX_A'], ['RX_A']], '组', 'group', 'group-def');
  const fixture = { ...grouped, layout: { ...grouped.layout, topologyFrames: [
    { modulePath: ['group'], x: 0, y: 0, width: 800, height: 600 },
    { modulePath: ['group', 'TX_A'], x: -30, y: -40, width: 640, height: 420 },
  ] } };
  const plan = planDissolveModule(fixture, ['group']);
  assert.ok(plan.ok, !plan.ok ? plan.message : undefined);
  const restored = round(plan.project);
  assert.deepEqual(plan.children, [['TX_A'], ['RX_A']]);
  assert.equal(part(restored, 'group-def'), undefined);
  assert.deepEqual(part(restored, 'system')?.cableBundles, part(base, 'system')?.cableBundles);
  assert.deepEqual(full(restored), full(base));
  assert.deepEqual(restored.layout?.physical, base.layout?.physical);
  assert.deepEqual(restored.layout?.topologyFrames, [{ ...fixture.layout.topologyFrames[1], modulePath: ['TX_A'] }]);
  assert.ok(part(restored, 'tx')?.instances.some(item => item.id === 'mzm'));
});

test('empty modules dissolve and unconvertible aliases, physical containers and local collisions reject atomically', () => {
  const base = read();
  const withEmpty = editModule(base, 'system', root => ({
    ...root, instances: [...root.instances, { id: 'empty', name: '空模块', definitionId: 'empty' }],
  }));
  const empty: Project = { ...withEmpty, moduleDefinitions: [...withEmpty.moduleDefinitions,
    { kind: 'module', id: 'empty', name: '空模块', ports: [], instances: [] }] };
  const successful = planDissolveModule(empty, ['empty']);
  assert.ok(successful.ok);
  assert.deepEqual(successful.children, []);
  assert.equal(part(round(successful.project), 'empty'), undefined);
  const grouped = groupModule(base, [['TX_A', 'laser'], ['TX_A', 'mzm']], '组', 'group', 'group-def');
  const missing = editModule(grouped, 'group-def', item => ({
    ...item, portMappings: item.portMappings?.filter(mapping => mapping.portId !== 'RF_IN'),
  }));
  const collision = editModule(grouped, 'tx', item => ({
    ...item, instances: [...item.instances, { id: 'laser', name: '另一激光器', definitionId: 'demo-laser' }],
  }));
  const localParameter = editModule(grouped, 'tx', item => ({
    ...item, parameterMappings: item.parameterMappings?.filter(mapping => mapping.target.instanceId !== 'group'),
  }));
  for (const [project, path, reason] of [
    [base, ['TX_A'], /物理机箱/], [missing, ['TX_A', 'group'], /RF_IN.*没有内部映射/],
    [localParameter, ['TX_A', 'group'], /模块参数.*本层来源/],
    [collision, ['TX_A', 'group'], /实例引用冲突.*激光器/], [base, [], /根模块不能解散/],
  ] as const) {
    const store = createProjectStore(project);
    const before = store.getSnapshot();
    const preview = planDissolveModule(before.project, path);
    assert.ok(!preview.ok);
    assert.match(preview.message, reason);
    assert.equal(store.getSnapshot(), before);
    assert.equal(before.canUndo, false);
  }
});
