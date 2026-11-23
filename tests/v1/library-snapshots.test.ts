import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { builtInDefinitions } from '../../src/library/v1/built-in';
import { addTemplateInstance, previewTemplateUpdate } from '../../src/library/v1/project-snapshots';
import type { Project } from '../../src/model/v1/types';
import { createProjectStore } from '../../src/state/v1/project-store';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const [gain, , stage] = builtInDefinitions;
const empty: Project = {
  id: 'test', name: 'Test', rootModuleDefinitionId: 'system', componentDefinitions: [],
  moduleDefinitions: [{ id: 'system', name: 'System', kind: 'module', ports: [], instances: [] }],
};

test('template dependencies become self-contained snapshots and adding a reused ID keeps the existing definition', () => {
  const installed = addTemplateInstance(empty, builtInDefinitions, stage.id, 'system', 'stage', 'Stage');
  assert.deepEqual(installed.changes.added.map(item => item.id), [stage.id, gain.id]);
  const restored = parseProjectJson(serializeProjectJson(installed.project));
  assert.deepEqual(resolveHierarchy(restored).resolveInstance(['stage', 'amplifier'])?.parameters.get('gain')?.value,
    { kind: 'fixed', value: 6 });
  const local: Project = { ...restored,
    componentDefinitions: restored.componentDefinitions.map(item => ({ ...item, name: 'Local definition' })) };
  const another = addTemplateInstance(local, builtInDefinitions, gain.id, 'system', 'another', 'Another');
  assert.equal(another.changes.added.length, 0);
  assert.equal(another.changes.reused[0].name, 'Local definition');
  assert.equal(another.project.componentDefinitions[0].name, 'Local definition');
  assert.equal(another.project.moduleDefinitions[0].instances.at(-1)?.definitionId, gain.id);
});

test('explicit compatible update preserves scoped wiring and retained instance configuration in one undo', () => {
  const inserted = addTemplateInstance(empty, builtInDefinitions, stage.id, 'system', 'stage', 'Stage');
  const project: Project = {
    ...inserted.project,
    moduleDefinitions: inserted.project.moduleDefinitions.map(module => module.id === 'system' ? {
      ...module,
      instances: [...module.instances, { id: 'monitor', name: 'Monitor', definitionId: gain.id }],
      connections: [{ id: 'monitor-feed', from: { instanceId: 'stage', portId: 'RF_OUT' }, to: { instanceId: 'monitor', portId: 'RF_IN' } }],
    } : {
      ...module,
      instances: module.instances.map(instance => ({ ...instance, name: 'Retained name',
        parameterOverrides: { gain: { kind: 'fixed', value: 0 } } })),
    }),
    namedLinks: [{ id: 'monitor', name: 'Monitor', from: { instancePath: ['stage'], portId: 'RF_OUT' },
      to: { instancePath: ['monitor'], portId: 'RF_IN' }, via: [{ scopePath: [], connectionId: 'monitor-feed' }] }],
  };
  const store = createProjectStore(project);
  const before = store.getSnapshot();
  const updatedLibrary = [{ ...gain, name: 'New library dependency' }, { ...stage, name: 'New module revision' }];
  const preview = previewTemplateUpdate(before.project, updatedLibrary, stage.id);
  assert.equal(preview.ok, true);
  assert.equal(store.getSnapshot(), before);
  assert.equal(store.commit(() => preview.project).ok, true);
  const after = store.getSnapshot().project;
  assert.equal(after.moduleDefinitions.find(item => item.id === stage.id)?.name, 'New module revision');
  assert.deepEqual(after.moduleDefinitions[0], before.project.moduleDefinitions[0]);
  assert.deepEqual(after.namedLinks, before.project.namedLinks);
  assert.equal(after.componentDefinitions[0].name, gain.name);
  assert.deepEqual(store.resolveInstance(['stage', 'amplifier'])?.instance?.parameterOverrides?.gain, { kind: 'fixed', value: 0 });
  assert.equal(store.resolveInstance(['stage', 'amplifier'])?.instance?.name, 'Retained name');
  store.undo();
  assert.equal(store.getSnapshot().project, before.project);
  assert.equal(store.getSnapshot().canUndo, false);
});

test('compatible replacement exposes valid local wiring, open mappings, and parameter changes before commit', () => {
  const installed = addTemplateInstance(empty, builtInDefinitions, stage.id, 'system', 'stage', 'Stage');
  const localConnection = { id: 'local-feed',
    from: { instanceId: 'amplifier', portId: 'RF_OUT' }, to: { instanceId: 'amplifier', portId: 'RF_IN' } };
  const defaultValue = { kind: 'fixed', value: 0 } as const;
  const project: Project = {
    ...installed.project,
    moduleDefinitions: installed.project.moduleDefinitions.map(module => module.id === stage.id ? {
      ...module, connections: [localConnection], portMappings: [], parameterMappings: [],
      parameters: [{ ...stage.parameters[0], defaultValue }],
      physicalEnclosure: { widthMm: 120, depthMm: 80, heightMm: 35 },
    } : module),
  };
  const store = createProjectStore(project);
  const before = store.getSnapshot();
  const preview = previewTemplateUpdate(before.project, builtInDefinitions, stage.id);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.definitionChanges.find(change => change.field === '连接'), {
    field: '连接', id: 'local-feed', before: localConnection, after: undefined,
  });
  assert.deepEqual(preview.definitionChanges.filter(change => change.field === '端口映射').map(change => change.after), stage.portMappings);
  assert.deepEqual(preview.definitionChanges.find(change => change.field === '参数映射')?.after, stage.parameterMappings[0]);
  assert.deepEqual(preview.definitionChanges.find(change => change.field === '参数定义')?.before, { ...stage.parameters[0], defaultValue });
  assert.deepEqual(preview.definitionChanges.find(change => change.field === '物理包络')?.before,
    { widthMm: 120, depthMm: 80, heightMm: 35 });
  assert.equal(store.getSnapshot(), before);
  assert.equal(store.commit(() => preview.project).ok, true);
  const unchanged = previewTemplateUpdate(store.getSnapshot().project, builtInDefinitions, stage.id);
  assert.equal(unchanged.ok, true);
  assert.deepEqual(unchanged.definitionChanges, []);
  store.undo();
  assert.equal(store.getSnapshot().project, before.project);
});

test('type collisions and updates that remove referenced ports are diagnosed without modifying the project', () => {
  const conflicting: Project = { ...empty, moduleDefinitions: [...empty.moduleDefinitions, {
    kind: 'module', id: gain.id, name: 'Existing module', instances: [], ports: [],
  }] };
  assert.throws(() => addTemplateInstance(conflicting, builtInDefinitions, gain.id, 'system', 'new', 'New'), /定义 ID 冲突/);
  const installed = addTemplateInstance(empty, builtInDefinitions, gain.id, 'system', 'amp', 'Amp');
  const store = createProjectStore({
    ...installed.project,
    namedLinks: [{ id: 'used', name: 'Used', from: { instancePath: ['amp'], portId: 'RF_OUT' } }],
  });
  const before = store.getSnapshot();
  const incompatible = previewTemplateUpdate(before.project, [{ ...gain, ports: [], transfers: [] }], gain.id);
  assert.equal(incompatible.ok, false);
  assert.match(incompatible.message, /链路「Used」.*起点端点引用无效/);
  assert.ok(incompatible.removedPorts.includes('RF_OUT'));
  assert.equal(store.getSnapshot(), before);
});
