import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { wiringProblem } from '../../src/editors/topology/v1/wiring-validation';
import { blankEnclosureId, blankModuleId, builtInDefinitions } from '../../src/library/v1/built-in';
import { insertLibraryItem } from '../../src/library/v1/insert-library-item';
import type { ModuleDefinition, PortDefinition, Project } from '../../src/model/v1/types';
import { createProjectStore } from '../../src/state/v1/project-store';
import { removeTopologyInstance, removeWiring } from '../../src/state/v1/remove-topology-object';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const root: ModuleDefinition = { id: 'system', name: '系统', kind: 'module', ports: [], instances: [] };
const empty: Project = { id: 'empty', name: '空工程', rootModuleDefinitionId: root.id, componentDefinitions: [], moduleDefinitions: [root] };
const example = parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));

test('each built-in can be inserted from a blank project and blank containers receive independent definitions', () => {
  const template = (id: string, name: string) => ({ source: 'template' as const, id, name });
  const populated = builtInDefinitions.reduce((project, item, index) =>
    insertLibraryItem(project, template(item.id, item.name), root.id, [], 'item-' + index), empty);
  const first = insertLibraryItem(populated, template(blankModuleId, '发射'), root.id, [], 'tx', { x: 12, y: 34 });
  const second = insertLibraryItem(first, template(blankModuleId, '接收'), root.id, [], 'rx');
  const chassis = insertLibraryItem(second, template(blankEnclosureId, '机箱'), root.id, [], 'box');
  const restored = parseProjectJson(serializeProjectJson(chassis));
  assert.ok(restored.moduleDefinitions.some(item => item.id === 'tx' && item.name === '发射'));
  assert.ok(restored.moduleDefinitions.some(item => item.id === 'rx' && item.name === '接收'));
  assert.ok(restored.moduleDefinitions.find(item => item.id === 'box')?.physicalEnclosure);
  assert.deepEqual(restored.layout?.topology, [{ instancePath: ['tx'], x: 12, y: 34 }]);
  assert.ok(restored.componentDefinitions.find(item => item.id === 'library-rf-amplifier')
    ?.parameters?.every(parameter => parameter.defaultValue === undefined));
});

test('wiring diagnostics distinguish directions, signal categories and duplicate connections', () => {
  const port = (id: string, type: PortDefinition['type'], direction: PortDefinition['direction']) =>
    ({ port: { id, type, direction }, direction, endpoint: { instanceId: id, portId: id } });
  const laser = port('laser', 'OPTICAL', 'out');
  const input = port('input', 'OPTICAL', 'in');
  const rf = port('rf', 'RF', 'in');
  assert.match(wiringProblem(root, laser, rf) ?? '', /光信号不能连接射频/);
  assert.match(wiringProblem(root, input, rf) ?? '', /两个端口都是输入/);
  assert.equal(wiringProblem(root, input, laser), undefined);
  assert.match(wiringProblem({ ...root, connections: [{ id: 'c', from: laser.endpoint, to: input.endpoint }] }, laser, input) ?? '', /已连接/);
});

test('deleting a connection or a shared child removes dependent references in one undoable edit', () => {
  const store = createProjectStore(example);
  const before = store.getSnapshot().project;
  assert.equal(store.commit(draft => removeWiring(draft, root.id, { kind: 'connection', id: 'spare' })).ok, true);
  assert.ok(!store.getSnapshot().project.moduleDefinitions.find(item => item.id === root.id)?.connections?.some(item => item.id === 'spare'));
  store.undo();
  assert.equal(store.getSnapshot().project, before);

  assert.equal(store.commit(draft => removeTopologyInstance(draft, 'tx', 'mzm')).ok, true);
  const restored = parseProjectJson(serializeProjectJson(store.getSnapshot().project));
  assert.ok(!restored.moduleDefinitions.find(item => item.id === 'tx')?.instances.some(item => item.id === 'mzm'));
  assert.ok(!restored.layout?.physical?.some(item => ['TX_A', 'TX_B'].includes(item.instancePath[0]) && item.instancePath[1] === 'mzm'));
  assert.ok(!restored.namedLinks?.some(link => link.conversionBindings?.some(binding => binding.eo.instancePath[1] === 'mzm')));
  store.undo();
  assert.equal(store.getSnapshot().project, before);
  store.redo();
  assert.deepEqual(parseProjectJson(serializeProjectJson(store.getSnapshot().project)), restored);
});
