import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankModuleId } from '../../src/library/v1/built-in';
import { insertLibraryItem } from '../../src/library/v1/insert-library-item';
import { editablePortName, portDisplayName } from '../../src/model/v1/display-names';
import { topologyExample } from '../../src/model/v1/topology-example';
import { groupModule } from '../../src/state/v1/group-module';
import { editInstanceSettings } from '../../src/state/v1/instance-settings';
import { instantiateModule, pasteModule } from '../../src/state/v1/instantiate-module';
import { createProjectStore } from '../../src/state/v1/project-store';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
import { createLinkOptions } from '../../src/workbench/v1/links/link-options';

test('module naming checks effective names across scopes and reuses the first free suffix', () => {
  const store = createProjectStore(topologyExample);
  const place = (id: string, parent = 'system', path: string[] = []) => store.commit(project =>
    insertLibraryItem(project, { source: 'template', id: blankModuleId, name: '新建模块', automaticName: true }, parent, path, id));
  const rename = (id: string, name: string) => store.commit(project =>
    editInstanceSettings(project, [id], previous => ({ ...previous, name })));
  const nameAt = (...path: string[]) => store.resolveInstance(path)?.instance?.name;
  assert.ok(place('a').ok);
  assert.ok(place('b', 'a', ['a']).ok);
  assert.ok(place('c').ok);
  assert.deepEqual([nameAt('a'), nameAt('a', 'b'), nameAt('c')], ['新建模块', '新建模块 2', '新建模块 3']);
  assert.ok(rename('a', ' Rack ').ok);
  const before = store.getSnapshot();
  const conflict = { ok: false, message: '模块名称「rAcK」已存在，请使用其他名称。' };
  assert.deepEqual(rename('c', ' rAcK '), conflict);
  assert.deepEqual(store.commit(p => groupModule(p, [['TX_A'], ['TX_B']], 'rAcK', 'new', 'def')), conflict);
  assert.deepEqual(store.commit(p => insertLibraryItem(p, { source: 'template', id: blankModuleId, name: 'rAcK' },
    'system', [], 'new')), conflict);
  assert.equal(store.getSnapshot(), before);
  assert.ok(place('d').ok);
  assert.equal(nameAt('d'), '新建模块');
  store.undo();
  assert.equal(nameAt('d'), undefined);
  store.redo();
  assert.equal(nameAt('d'), '新建模块');
});

test('copies and reuses allocate names only for the outer module and keep reference paths intact', () => {
  const store = createProjectStore(topologyExample);
  const source = ['TX_A'];
  const clipboard = store.getSnapshot().project;
  let serial = 0;
  const nextId = () => 'definition-' + ++serial;
  for (const id of ['copy1', 'copy2']) assert.ok(store.commit(p => pasteModule(p, clipboard, source, [], id, nextId)).ok);
  for (const id of ['reuse1', 'reuse2']) assert.ok(store.commit(p => instantiateModule(p, source, 'reuse', id, nextId)).ok);
  assert.deepEqual(['copy1', 'copy2', 'reuse1', 'reuse2'].map(id => store.resolveInstance([id])?.instance?.name),
    ['Transmitter A 副本', 'Transmitter A 副本 2', 'Transmitter A 复用', 'Transmitter A 复用 2']);
  assert.equal(store.resolveInstance(['reuse2'])?.definition.id, store.resolveInstance(source)?.definition.id);
  assert.equal(store.resolveInstance(['copy2', 'mzm'])?.instance?.name, 'MZM');
  assert.deepEqual(store.getSnapshot().project.namedLinks, clipboard.namedLinks);
});

test('legacy duplicate names round trip and link labels follow occurrence renames without changing keys', () => {
  const legacy = { ...topologyExample, instanceSettings: ['TX_A', 'TX_B'].map(id => ({ instancePath: [id], name: '机箱' })) };
  const store = createProjectStore(parseProjectJson(serializeProjectJson(legacy)));
  const before = createLinkOptions(store.getSnapshot().project);
  const ref = { instancePath: ['TX_B', 'mzm'], portId: 'RF_IN' };
  assert.equal(before.showEndpoint(ref), '机箱（2） / MZM / RF_IN');
  assert.ok(store.commit(p => editInstanceSettings(p, ['TX_B', 'mzm'], prev => ({ ...prev, name: '调制器' }))).ok);
  const after = createLinkOptions(parseProjectJson(serializeProjectJson(store.getSnapshot().project)));
  assert.equal(after.showEndpoint(ref), '机箱（2） / 调制器 / RF_IN');
  assert.equal(after.showEndpoint({ ...ref, instancePath: ['TX_A', 'mzm'] }), '机箱（1） / MZM / RF_IN');
  const wire = after.via.find(item => 'connectionId' in item.value && item.value.connectionId === 'rf-feed'
    && item.value.scopePath[0] === 'TX_B')!;
  assert.equal(wire.label, '机箱（2）：RF source · OUT → 调制器 · RF_IN');
  assert.ok(before.via.some(item => item.key === wire.key));
  assert.deepEqual(store.getSnapshot().project.namedLinks, legacy.namedLinks);
});

test('unnamed ports and legacy generated port names use type and direction without changing their IDs', () => {
  const ports = ['29c45b8c-5ffa-4e1f-a3a0-659b3942b6ea', 'd50e1b9e-e634-41a6-acf9-f499d52c88b0']
    .map(id => ({ id, type: 'RF' as const, direction: 'in' as const }));
  assert.deepEqual(ports.map(p => portDisplayName(p, true, ports)), ['射频输入（1）', '射频输入（2）']);
  assert.equal(editablePortName({ ...ports[0], name: '设备 · ' + ports[0].id }), '设备 · 射频输入');
  assert.equal(portDisplayName({ ...ports[0], id: 'RF_IN', name: '射频输入' }, true), '射频输入（RF_IN）');
});

test('invalid snapshot diagnostics identify the occurrence in the attempted project', () => {
  const store = createProjectStore(topologyExample);
  const before = store.getSnapshot();
  const attempted = { ...topologyExample, instanceSettings: [{ instancePath: ['TX_A'], name: '改名机箱' }],
    layout: { topology: [{ instancePath: ['TX_A', 'missing-device'], x: 0, y: 0 }] } };
  const result = store.replaceProject(attempted);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /改名机箱 \/ 未找到的对象/);
  assert.equal(store.getSnapshot(), before);
});
