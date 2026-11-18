import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceExample } from '../../src/model/v1/device-example';
import { exampleProject } from '../../src/model/v1/example';
import { topologyExample } from '../../src/model/v1/topology-example';
import type { Project } from '../../src/model/v1/types';
import { createProjectStore } from '../../src/state/v1/project-store';
import { editModule, editModuleWiring, moveTopologyNode, planPortDeletion } from '../../src/state/v1/topology-edits';

test('shared MZM output deletion previews direct and scoped Link references and undoes as one edit', () => {
  const withConnection = editModule(topologyExample, 'tx', module => ({
    ...module,
    instances: [...module.instances, { id: 'monitor', name: 'Monitor', definitionId: 'pd' }],
    connections: [...(module.connections ?? []), {
      id: 'monitor', from: { instanceId: 'mzm', portId: 'OUT' }, to: { instanceId: 'monitor', portId: 'IN' },
    }],
  }));
  const project: Project = {
    ...withConnection,
    namedLinks: [...withConnection.namedLinks!, {
      id: 'monitor', name: 'Monitor link', channelId: 'DWDM_CH28', from: { instancePath: ['TX_B', 'mzm'], portId: 'OUT' },
      via: [{ scopePath: ['TX_A'], connectionId: 'monitor' }, { scopePath: [], bundleId: 'mpo-12', coreId: 'wdm' }],
    }],
  };
  const store = createProjectStore(project);
  const before = store.getSnapshot();
  const plan = planPortDeletion(before.project, 'mzm', 'OUT')!;
  assert.equal(store.getSnapshot(), before);
  assert.deepEqual(plan.impacts[0].paths, [['TX_A', 'mzm'], ['TX_B', 'mzm']]);
  for (const kind of ['器件传输', '连接', '端口映射', '链路端点', '链路必经边', '标定绑定']) {
    assert.ok(plan.impacts.some(impact => impact.kind === kind), kind);
  }
  assert.deepEqual(plan.impacts.find(impact => impact.kind === '连接')?.paths, [['TX_A'], ['TX_B']]);
  assert.equal(store.commit(() => plan.project).ok, true);
  const after = store.getSnapshot().project;
  assert.deepEqual(after.moduleDefinitions.find(module => module.id === 'tx')?.portMappings, []);
  assert.ok(after.moduleDefinitions.find(module => module.id === 'tx')?.ports.some(port => port.id === 'OPT_OUT'));
  assert.equal(after.namedLinks?.find(link => link.id === 'full')?.conversionBindings?.length, 0);
  assert.deepEqual(after.namedLinks?.find(link => link.id === 'monitor'), {
    id: 'monitor', name: 'Monitor link', from: undefined, to: undefined, channelId: 'DWDM_CH28',
    via: [{ scopePath: [], bundleId: 'mpo-12', coreId: 'wdm' }], conversionBindings: undefined,
  });
  store.undo();
  assert.equal(store.getSnapshot().project, before.project);
  assert.equal(store.getSnapshot().canUndo, false);
});

test('removing an EO supply or a switch port clears dependent routes, including supply-only invalidation', () => {
  const store = createProjectStore(topologyExample);
  const eo = planPortDeletion(store.getSnapshot().project, 'mzm', 'SUPPLY')!;
  assert.ok(eo.impacts.some(impact => impact.kind === '标定绑定'));
  assert.equal(eo.impacts.some(impact => impact.kind === '端口映射'), false);
  assert.equal(store.commit(() => eo.project).ok, true);
  assert.deepEqual(store.getSnapshot().project.componentDefinitions.find(item => item.id === 'mzm')?.transfers, []);
  assert.deepEqual(store.getSnapshot().project.namedLinks?.find(link => link.id === 'full')?.conversionBindings, []);

  const switches = createProjectStore(deviceExample);
  const plan = planPortDeletion(switches.getSnapshot().project, 'switch', 'OUT_A')!;
  assert.deepEqual(plan.impacts.find(impact => impact.kind === '开关路由')?.paths, [['swA'], ['swB']]);
  assert.equal(switches.commit(() => plan.project).ok, true);
  const states = switches.getSnapshot().project.componentDefinitions.find(item => item.id === 'switch')?.switchStates;
  assert.deepEqual(states?.map(state => [state.id, state.routes.length]), [['a', 0], ['b', 1]]);
});

test('a half-open fibre retains its core reference until the core itself is deleted', () => {
  const store = createProjectStore(topologyExample);
  const plan = planPortDeletion(store.getSnapshot().project, 'tx', 'OPT_OUT')!;
  assert.equal(store.commit(() => plan.project).ok, true);
  const project = store.getSnapshot().project;
  const wdm = project.moduleDefinitions[0].cableBundles?.[0].cores[0];
  assert.deepEqual(wdm, { id: 'wdm', a: { pin: 1 }, b: { pin: 12, endpoint: { instanceId: 'RX_A', portId: 'OPT_IN' } } });
  const full = project.namedLinks?.find(link => link.id === 'full');
  assert.deepEqual(full?.via?.at(-1), { scopePath: [], bundleId: 'mpo-12', coreId: 'wdm' });
  assert.equal(store.commit(draft => editModuleWiring(draft, 'system', module => ({
    ...module, cableBundles: module.cableBundles?.map(bundle => ({ ...bundle, cores: bundle.cores.filter(core => core.id !== 'wdm') })),
  }))).ok, true);
  assert.deepEqual(store.getSnapshot().project.namedLinks?.find(link => link.id === 'full')?.via,
    [{ scopePath: ['TX_A'], connectionId: 'rf-feed' }]);
});

test('a committed logical move leaves topology relationships and physical layout intact', () => {
  const store = createProjectStore(exampleProject);
  assert.equal(store.commit(draft => moveTopologyNode(draft, ['TX_A'], { x: 120, y: 240 })).ok, true);
  const after = store.getSnapshot().project;
  assert.deepEqual(after.moduleDefinitions, exampleProject.moduleDefinitions);
  assert.deepEqual(after.layout?.physical, exampleProject.layout.physical);
  assert.deepEqual(after.layout?.topology?.find(item => item.instancePath[0] === 'TX_A'), { instancePath: ['TX_A'], x: 120, y: 240 });
  store.undo();
  assert.deepEqual(store.getSnapshot().project, exampleProject);
});
