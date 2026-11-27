import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitionIcon } from '../../src/editors/topology/v1/device-icon';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { builtInDefinitions } from '../../src/library/v1/built-in';
import { insertLibraryItem } from '../../src/library/v1/insert-library-item';
import { addTemplateInstance, previewTemplateUpdate } from '../../src/library/v1/project-snapshots';
import { captureInstance, factoryLibrary, libraryDefinitions, parseLibrary, saveDefinition } from '../../src/library/v1/user-library';
import type { ModuleDefinition, Project } from '../../src/model/v1/types';
import { instantiateModule } from '../../src/state/v1/instantiate-module';
import { createProjectStore } from '../../src/state/v1/project-store';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const [gain, , stage] = builtInDefinitions;
const empty: Project = {
  id: 'test', name: 'Test', rootModuleDefinitionId: 'system', componentDefinitions: [],
  moduleDefinitions: [{ id: 'system', name: 'System', kind: 'module', ports: [], instances: [] }],
};

test('factory templates use the confirmed component, module and enclosure symbols', () => {
  const icons = Object.fromEntries(builtInDefinitions.map(item => [item.id, definitionIcon(item)]));
  assert.deepEqual(icons, {
    'library-rf-gain': 'amplifier', 'library-rf-stage': 'module', 'library-optical-source': 'multiWavelengthSource',
    'library-empty-component': 'component', 'library-empty-module': 'module', 'library-empty-enclosure': 'enclosure',
    'library-laser': 'laser', 'library-dml': 'dml', 'library-mzm': 'mzm', 'library-pd': 'photodiode',
    'library-optical-switch': 'opticalSwitch', 'library-optical-attenuator': 'opticalAttenuator',
    'library-rf-amplifier': 'amplifier', 'library-rf-attenuator': 'rfAttenuator',
    'library-dc-supply': 'dcSupply', 'library-dc-converter': 'dcConverter', 'library-pcb': 'controlCircuit',
    'library-splitter': 'splitter', 'library-sfp': 'sfp', 'library-wdm': 'component',
    'library-optical-amplifier': 'opticalAmplifier', 'library-circulator': 'circulator', 'library-isolator': 'isolator',
  });
});

test('control routing survives template and project round trips, with independent copies and shared module instances', () => {
  const config = factoryLibrary();
  const capable = libraryDefinitions(config).filter(d => d.kind === 'component' && d.controlRouting);
  assert.deepEqual(capable.map(d => d.id), ['library-pcb']);
  const board = capable[0];
  assert.ok(board.kind === 'component');
  const oldOverride = { ...board, name: 'Renamed board', controlRouting: undefined };
  assert.equal(libraryDefinitions({ ...config, overrides: [oldOverride] }).some(d =>
    d.id === board.id && d.kind === 'component' && d.controlRouting), true);
  const routed = { ...board, ports: [...board.ports,
    { id: 'i', type: 'CONTROL', direction: 'in' }, { id: 'o', type: 'CONTROL', direction: 'out' }] as const,
    transfers: [{ kind: 'control', fromPortId: 'i', toPortId: 'o' }] as const };
  const rack = { ...empty.moduleDefinitions[0], id: 'rack', instances: [{ id: 'board', name: 'Board', definitionId: board.id }] };
  const project = addTemplateInstance(empty, [rack, routed], rack.id, 'system', 'rack', 'Rack');
  const shared = instantiateModule(project, ['rack'], 'reuse', 'shared', () => assert.fail());
  const [snapshot] = captureInstance(shared, ['rack', 'board'], false);
  const library = parseLibrary(JSON.stringify(saveDefinition(config, snapshot)));
  const copy = addTemplateInstance(shared, libraryDefinitions(library), snapshot.id, 'system', 'copy', 'Copy');
  const restored = parseProjectJson(serializeProjectJson(copy));
  const tree = resolveHierarchy(restored);
  const original = tree.resolveInstance(['rack', 'board'])!.definition;
  const independent = tree.resolveInstance(['copy'])!.definition;
  assert.equal(tree.resolveInstance(['shared', 'board'])!.definition, original);
  assert.notEqual(independent.id, original.id);
  for (const device of [original, independent]) {
    assert.ok(device.kind === 'component' && device.controlRouting);
    assert.deepEqual(device.transfers, routed.transfers);
  }
  const oldProject = { ...restored, componentDefinitions: restored.componentDefinitions.map(d => ({ ...d, controlRouting: undefined })) };
  assert.ok(parseProjectJson(serializeProjectJson(oldProject)).componentDefinitions.every(d => d.controlRouting === undefined));
});

test('copied and reused modules retain component icon choices through project JSON', () => {
  const template = { ...gain, name: 'Renamed template', iconKey: 'controlCircuit' } as const;
  const installed = addTemplateInstance(empty, [template, stage], stage.id, 'system', 'stage', 'Stage');
  const reused = instantiateModule(installed, ['stage'], 'reuse', 'shared', () => assert.fail());
  let sequence = 0;
  const copy = instantiateModule(reused, ['stage'], 'copy', 'independent', () => `copy-${++sequence}`);
  const json = serializeProjectJson(copy);
  const tree = resolveHierarchy(parseProjectJson(json));
  for (const id of ['stage', 'shared', 'independent']) {
    const child = tree.resolveInstance([id, 'amplifier'])?.definition;
    assert.equal(child?.kind === 'component' && child.iconKey, 'controlCircuit');
  }
  const invalid = JSON.parse(json);
  invalid.project.componentDefinitions[0].iconKey = 'https://example.invalid/icon.svg';
  assert.throws(() => parseProjectJson(JSON.stringify(invalid)), /componentDefinitions\[0\]\.iconKey/);
});

test('library and project additions copy every nested occurrence while reuse shares its definition', () => {
  const pair: ModuleDefinition = { ...stage, instances: [...stage.instances, { ...stage.instances[0], id: 'second' }],
    connections: [{ id: 'feed', from: { instanceId: 'amplifier', portId: 'RF_OUT' }, to: { instanceId: 'second', portId: 'RF_IN' } }],
    portMappings: stage.portMappings.map(m => m.portId === 'RF_OUT' ? { ...m, target: { ...m.target, instanceId: 'second' } } : m) };
  const rack: ModuleDefinition = { ...stage, id: 'rack-template', parameters: [{ ...stage.parameters[0], defaultValue: { kind: 'fixed', value: 8 } }],
    instances: ['one', 'two'].map(id => ({ id, name: id, definitionId: pair.id })),
    portMappings: stage.portMappings.map(m => ({ ...m, target: { ...m.target, instanceId: 'one' } })),
    parameterMappings: [{ parameterId: 'gain', target: { instanceId: 'one', parameterId: 'gain' } }] };
  const library = [rack, pair, gain];
  const store = createProjectStore(empty);
  for (const name of ['A', 'B']) assert.deepEqual(store.commit(p => addTemplateInstance(p, library, rack.id, 'system', name, name)), { ok: true });
  const sourceId = store.resolveInstance(['A'])!.definition.id;
  assert.deepEqual(store.commit(p => insertLibraryItem(p, { source: 'project', id: sourceId, name: 'C' }, 'system', [], 'C')), { ok: true });
  const restored = parseProjectJson(serializeProjectJson(store.getSnapshot().project));
  const tree = resolveHierarchy(restored);
  const occurrences = [...tree.walkInstances()].filter(o => o.instance);
  assert.equal(occurrences.length, 21);
  assert.equal(new Set(occurrences.map(o => o.definition.id)).size, 21);
  const budget = createLinkBudget(restored);
  for (const slot of ['A', 'B', 'C']) {
    const point = budget.calculateNamedLink({ id: 'rf', name: 'RF', from: { instancePath: [slot], portId: 'RF_IN' },
      to: { instancePath: [slot], portId: 'RF_OUT' } }, { frequencyGHz: 10, inputPowerDbm: -20 });
    assert.equal(point.gainDb.availability === 'available' && point.gainDb.value, 14);
    assert.equal(point.powerDbm.availability === 'available' && point.powerDbm.value, -6);
    for (const id of ['one', 'two']) {
      const copied = tree.resolveInstance([slot, id])!.definition as ModuleDefinition;
      assert.deepEqual(copied.connections, pair.connections);
      assert.deepEqual(copied.portMappings, pair.portMappings);
      assert.deepEqual(copied.parameterMappings, pair.parameterMappings);
      assert.deepEqual(tree.resolveInstance([slot, id, 'second'])!.parameters.get('gain')!.value, { kind: 'fixed', value: 6 });
    }
  }
  const before = store.getSnapshot();
  assert.equal(store.commit(p => addTemplateInstance(p, [rack, pair], rack.id, 'system', 'invalid', 'Invalid')).ok, false);
  assert.equal(store.getSnapshot(), before);
  assert.deepEqual(store.commit(p => instantiateModule(p, ['A'], 'reuse', 'reuse', () => assert.fail())), { ok: true });
  assert.equal(store.resolveInstance(['reuse', 'two', 'second'])!.definition.id, store.resolveInstance(['A', 'two', 'second'])!.definition.id);
  store.undo();
  assert.equal(store.getSnapshot().project, before.project);
  store.redo();
  assert.equal(store.resolveInstance(['reuse'])!.definition.id, sourceId);
});

function oldSnapshot(template: typeof gain | typeof stage, id: string, name: string): Project {
  return { ...empty, componentDefinitions: [structuredClone(gain)], moduleDefinitions: [
    { ...empty.moduleDefinitions[0], instances: [{ id, name, definitionId: template.id }] },
    ...(template.kind === 'module' ? [structuredClone(template)] : []),
  ] };
}

test('explicit compatible update preserves scoped wiring and retained instance configuration in one undo', () => {
  const inserted = oldSnapshot(stage, 'stage', 'Stage');
  const project: Project = {
    ...inserted,
    moduleDefinitions: inserted.moduleDefinitions.map(module => module.id === 'system' ? {
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
  const installed = oldSnapshot(stage, 'stage', 'Stage');
  const localConnection = { id: 'local-feed',
    from: { instanceId: 'amplifier', portId: 'RF_OUT' }, to: { instanceId: 'amplifier', portId: 'RF_IN' } };
  const defaultValue = { kind: 'fixed', value: 0 } as const;
  const project: Project = {
    ...installed,
    moduleDefinitions: installed.moduleDefinitions.map(module => module.id === stage.id ? {
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
  const independent = addTemplateInstance(conflicting, builtInDefinitions, gain.id, 'system', 'new', 'New');
  assert.equal(resolveHierarchy(independent).resolveInstance(['new'])!.definition.kind, 'component');
  assert.equal(previewTemplateUpdate(conflicting, builtInDefinitions, gain.id).ok, false);
  const installed = oldSnapshot(gain, 'amp', 'Amp');
  const store = createProjectStore({
    ...installed,
    namedLinks: [{ id: 'used', name: 'Used', from: { instancePath: ['amp'], portId: 'RF_OUT' } }],
  });
  const before = store.getSnapshot();
  const incompatible = previewTemplateUpdate(before.project, [{ ...gain, ports: [], transfers: [] }], gain.id);
  assert.equal(incompatible.ok, false);
  assert.match(incompatible.message, /链路「Used」.*起点端点引用无效/);
  assert.ok(incompatible.removedPorts.includes('RF_OUT'));
  assert.equal(store.getSnapshot(), before);
});
