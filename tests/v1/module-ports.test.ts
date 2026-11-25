import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildSignalGraph, signalPortKey } from '../../src/engine/v1/signal-graph';
import { addDefinitionPort, connectBoundaryPort, exposeModulePort, renamePort, updateDefinitionPort } from '../../src/state/v1/module-ports';
import { createProjectStore } from '../../src/state/v1/project-store';
import { editModule, planPortDeletion } from '../../src/state/v1/topology-edits';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { createLinkOptions } from '../../src/workbench/v1/links/link-options';
import { portDisplayName } from '../../src/workbench/v1/labels';

const sample = () => parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const target = { instanceId: 'mzm', portId: 'RF_IN' };
const endpoint = { instancePath: ['TX_A'], portId: 'RF_IN' };
const incoming = { id: 'external-wire', from: { instanceId: 'external-rf', portId: 'OUT' },
  to: { instanceId: 'TX_A', portId: 'RF_IN' } };
const addSource = (project: ReturnType<typeof sample>) => editModule(project, project.rootModuleDefinitionId, module => ({
  ...module, instances: [...module.instances, { id: 'external-rf', name: '外部射频源', definitionId: 'rf-source' }],
}));

test('exposure changes the shared definition once and rejects a target outside the immediate layer', () => {
  const project = sample();
  const store = createProjectStore(project);
  const expose = (draft: typeof project) => exposeModulePort(draft, ['TX_A'], target, '调制器射频口');
  assert.deepEqual(store.commit(expose), { ok: true });
  for (const tx of ['TX_A', 'TX_B']) {
    const definition = store.resolveInstance([tx])?.definition;
    assert.ok(definition?.kind === 'module');
    assert.deepEqual(definition.ports.find(port => port.id === 'RF_IN'),
      { id: 'RF_IN', name: '调制器射频口', type: 'RF', direction: 'in' });
    assert.deepEqual(definition.portMappings?.find(mapping => mapping.portId === 'RF_IN')?.target, target);
  }
  const collision = expose(store.getSnapshot().project);
  assert.ok(collision.moduleDefinitions.find(module => module.id === 'tx')?.ports.some(port => port.id === 'RF_IN_2'));
  assert.throws(() => exposeModulePort(project, [], target, '跨层'), /直接子实例/);
  const optical = exposeModulePort(project, ['TX_A'], { instanceId: 'optical-switch', portId: 'OUT' }, '光开关输出');
  const childPort = project.componentDefinitions.find(component => component.id === 'demo-switch')?.ports.find(port => port.id === 'OUT');
  const boundaryPort = optical.moduleDefinitions.find(module => module.id === 'tx')?.ports.find(port => port.id === 'OUT');
  assert.equal(boundaryPort?.type, 'OPTICAL');
  assert.equal(boundaryPort?.direction, 'out');
  assert.deepEqual(boundaryPort?.channelIds, childPort?.channelIds);
  store.undo();
  assert.deepEqual(store.getSnapshot().project, project);
  assert.equal(store.getSnapshot().canUndo, false);
});

test('rename and internal disconnect retain the upper wire, stable path references and JSON identity', () => {
  const project = exposeModulePort(addSource(sample()), ['TX_A'], target, '调制器射频口');
  const wired = editModule(project, project.rootModuleDefinitionId, module => ({
    ...module, connections: [...(module.connections ?? []), incoming],
  }));
  const renamed = renamePort(wired, 'tx', 'RF_IN', '射频输入');
  const restored = parseProjectJson(serializeProjectJson(renamed));
  const graph = buildSignalGraph(restored);
  const projection = graph.ports.get(signalPortKey(endpoint))!;
  assert.equal(portDisplayName(projection.definition), '射频输入');
  assert.equal(createLinkOptions(restored).showEndpoint(endpoint), '发射机箱 A / 射频输入');
  assert.equal(portDisplayName({ id: 'RF_IN' }), 'RF_IN');
  assert.deepEqual(restored.namedLinks, wired.namedLinks);
  assert.deepEqual(restored.moduleDefinitions.find(module => module.id === project.rootModuleDefinitionId)?.connections,
    wired.moduleDefinitions.find(module => module.id === project.rootModuleDefinitionId)?.connections);
  assert.ok(graph.edges.some(edge => edge.source.kind === 'portMapping' && edge.from === projection
    && edge.to.ref.portId === 'RF_IN' && edge.to.ref.instancePath.at(-1) === 'mzm'));
  const opened = parseProjectJson(serializeProjectJson(connectBoundaryPort(restored, 'tx', 'RF_IN')));
  assert.equal(buildSignalGraph(opened).ports.get(signalPortKey(endpoint))?.unmapped, true);
  assert.deepEqual(opened.moduleDefinitions.find(module => module.id === opened.rootModuleDefinitionId)?.connections,
    restored.moduleDefinitions.find(module => module.id === restored.rootModuleDefinitionId)?.connections);
  const plan = planPortDeletion(restored, 'tx', 'RF_IN')!;
  assert.ok(plan.impacts.some(impact => impact.kind === '连接' && impact.name.includes('外部射频源')));
  assert.ok(plan.impacts.some(impact => impact.kind === '端口映射' && impact.name.includes('射频输入')));
  const removed = parseProjectJson(serializeProjectJson(plan.project));
  assert.equal(buildSignalGraph(removed).ports.has(signalPortKey(endpoint)), false);
  assert.ok(!removed.moduleDefinitions.find(module => module.id === removed.rootModuleDefinitionId)?.connections?.some(wire => wire.id === incoming.id));
  assert.deepEqual(removed.namedLinks, wired.namedLinks);
});

test('declaring a port edits the shared definition and preserves wiring, transfers and stable IDs', () => {
  const project = sample();
  const store = createProjectStore(project);
  const mzm = store.resolveInstance(['TX_A', 'mzm'])?.definition;
  assert.ok(mzm?.kind === 'component');
  const port = { id: 'additional-output', name: '  测试光输出  ', type: 'OPTICAL', direction: 'out' } as const;
  assert.deepEqual(store.commit(draft => addDefinitionPort(draft, mzm.id, port)), { ok: true });
  const declared = store.getSnapshot().project;
  const graph = buildSignalGraph(declared);
  for (const tx of ['TX_A', 'TX_B']) {
    const ref = { instancePath: [tx, 'mzm'], portId: port.id };
    const declaredPort = graph.ports.get(signalPortKey(ref));
    assert.equal(declaredPort?.definition.name, '测试光输出');
    assert.ok(graph.edges.every(edge => edge.from !== declaredPort && edge.to !== declaredPort));
  }
  assert.deepEqual(declared.moduleDefinitions, project.moduleDefinitions);
  assert.deepEqual(declared.namedLinks, project.namedLinks);
  assert.throws(() => addDefinitionPort(declared, mzm.id, port), /ID 重复/);
  store.undo();
  assert.deepEqual(store.getSnapshot().project, project);
  const renamed = renamePort(declared, mzm.id, port.id, '辅助光输出');
  const restored = parseProjectJson(serializeProjectJson(renamed));
  assert.deepEqual(restored.componentDefinitions.find(item => item.id === mzm.id)?.ports.at(-1),
    { ...port, name: '辅助光输出' });
  const module = addDefinitionPort(restored, 'tx', { ...port, id: 'module-output' });
  assert.equal(buildSignalGraph(module).ports.get(signalPortKey({
    instancePath: ['TX_A'], portId: 'module-output',
  }))?.unmapped, true);
});

test('editing a shared boundary port keeps its references and rejects incompatible changes atomically', () => {
  const base = exposeModulePort(addSource(sample()), ['TX_A'], target, '调制器射频口');
  const wired = editModule(base, base.rootModuleDefinitionId, module => ({
    ...module, connections: [...(module.connections ?? []), incoming],
  }));
  const store = createProjectStore(wired);
  const port = store.resolveInstance(['TX_A'])!.definition.ports.find(port => port.id === 'RF_IN')!;
  const edited = { ...port, name: '额定输入', inputRating: { unit: 'dBm' as const, max: 12 } };
  assert.equal(store.commit(project => updateDefinitionPort(project, 'tx', edited)).ok, true);
  const saved = store.getSnapshot().project;
  assert.deepEqual(store.resolveInstance(['TX_B'])!.definition.ports.find(p => p.id === port.id), edited);
  assert.deepEqual(saved.namedLinks, wired.namedLinks);
  assert.deepEqual(saved.moduleDefinitions.map(d => [d.connections, d.portMappings]),
    wired.moduleDefinitions.map(d => [d.connections, d.portMappings]));
  assert.equal(store.commit(project => updateDefinitionPort(project, 'tx', { ...edited, direction: 'out', inputRating: undefined })).ok, false);
  assert.equal(store.getSnapshot().project, saved);
  store.undo();
  assert.deepEqual(store.getSnapshot().project, wired);
  assert.equal(store.getSnapshot().canUndo, false);
  store.redo();
  assert.deepEqual(parseProjectJson(serializeProjectJson(store.getSnapshot().project)), saved);
});
