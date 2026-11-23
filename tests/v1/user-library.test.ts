import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { blankModuleId } from '../../src/library/v1/built-in';
import { insertLibraryItem } from '../../src/library/v1/insert-library-item';
import { captureInstance, factory, factoryLibrary, libraryDefinitions, parseLibrary, removeDefinition, restoreDefinition, saveDefinition, validateLibrary } from '../../src/library/v1/user-library';
import type { LibraryConfig } from '../../src/library/v1/user-library';
import type { Project } from '../../src/model/v1/types';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';

const empty: Project = { id: 'project', name: 'Project', rootModuleDefinitionId: 'root', componentDefinitions: [],
  moduleDefinitions: [{ id: 'root', kind: 'module', name: 'System', ports: [], instances: [] }] };
const gain = factory.get('library-rf-gain')!;
const stage = factory.get('library-rf-stage')!;
const add = (project: Project, config: LibraryConfig, id: string, slot: string) => insertLibraryItem(project,
  { source: 'template', id, name: slot }, 'root', [], slot, undefined, config);

test('edited, hidden and custom templates survive migration without changing installed project snapshots', () => {
  const original = add(empty, factoryLibrary(), gain.id, 'before');
  const renamed = { ...gain, name: 'Updated' };
  let config = saveDefinition(factoryLibrary(), renamed);
  const libraryCopy = { ...renamed, id: 'custom', name: 'Copy' };
  config = removeDefinition(saveDefinition(config, libraryCopy), gain.id);
  config = parseLibrary(JSON.stringify(config));
  assert.throws(() => add(empty, config, gain.id, 'hidden'), /隐藏/);
  const fromModule = add(empty, config, stage.id, 'module');
  assert.equal(fromModule.componentDefinitions[0].name, 'Updated');
  assert.equal(add(original, config, stage.id, 'module').componentDefinitions[0].name, gain.name);
  assert.equal(parseProjectJson(serializeProjectJson(original)).componentDefinitions[0].name, gain.name);
  assert.equal(add(empty, restoreDefinition(config, gain.id), gain.id, 'after').componentDefinitions[0].name, gain.name);
  assert.equal(add(empty, config, libraryCopy.id, 'copy').componentDefinitions[0].name, 'Copy');
});

test('snapshot of a mapped occurrence materializes effective defaults and clones module dependencies', () => {
  const base = add(empty, factoryLibrary(), stage.id, 'stage');
  const project = { ...base, instanceSettings: [{ instancePath: ['stage'], parameterOverrides: { gain: { kind: 'fixed' as const, value: 12 } } }] };
  const before = serializeProjectJson(project);
  const [effective] = captureInstance(project, ['stage', 'amplifier'], true);
  const [raw] = captureInstance(project, ['stage', 'amplifier'], false);
  assert.deepEqual(effective.parameters?.[0].defaultValue, { kind: 'fixed', value: 12 });
  assert.deepEqual(raw.parameters?.[0].defaultValue, { kind: 'fixed', value: 6 });
  assert.notEqual(effective.id, raw.id);
  const [module, dependency] = captureInstance(project, ['stage'], true);
  assert.notEqual(dependency.id, gain.id);
  const config = [module, dependency].reduce(saveDefinition, factoryLibrary());
  validateLibrary(config);
  const restored = add(empty, config, module.id, 'saved');
  assert.deepEqual(resolveHierarchy(restored).resolveInstance(['saved', 'amplifier'])?.parameters.get('gain')?.value, { kind: 'fixed', value: 12 });
  assert.equal(serializeProjectJson(project), before);
  assert.throws(() => removeDefinition(config, dependency.id), /引用/);
  assert.throws(() => captureInstance(project, [], true), /独立设置/);
});

test('invalid files fail before replacing the effective library', () => {
  const config = saveDefinition(factoryLibrary(), { ...gain, id: 'custom' });
  assert.throws(() => parseLibrary(serializeProjectJson(empty)));
  const badModule = { kind: 'module', name: 'Module', id: 'module', ports: [], instances: [] };
  for (const bad of [
    { custom: [gain] }, { overrides: [gain, gain] }, { custom: [config.custom[0], config.custom[0]] },
    { hidden: ['unknown'] }, { hidden: [gain.id, gain.id] }, { layout: {} },
    { custom: [{ ...badModule, instances: [{ id: 'child', name: 'Child', definitionId: 'library-validation-root' }] }] },
    { custom: [{ ...badModule, instances: [{ id: 'child', name: 'Child', definitionId: 'module' }] }] },
    { custom: [{ ...gain, id: 'bad', parameters: [] }] },
    { custom: [{ ...gain, id: 'bad', parameters: [{ ...gain.parameters![0], defaultValue: { kind: 'fixed', value: Infinity } }] }] },
  ]) assert.throws(() => parseLibrary(JSON.stringify({ ...config, ...bad })));
  assert.equal(libraryDefinitions(config).at(-1)?.name, gain.name);
});

test('blank module variants install dependencies and the toolbar can create a blank module independently', () => {
  assert.equal(stage.kind, 'module');
  const config = saveDefinition(factoryLibrary(), { ...stage, id: blankModuleId });
  const first = add(empty, config, blankModuleId, 'one');
  assert.ok(first.componentDefinitions.some(d => d.id === gain.id));
  assert.equal(first.moduleDefinitions.find(d => d.id === 'one')?.instances.length, 1);
  const hidden = removeDefinition(config, blankModuleId);
  assert.throws(() => add(empty, hidden, blankModuleId, 'no'));
  const fresh = insertLibraryItem(empty, { source: 'blank-module', id: blankModuleId, name: 'Module' }, 'root', [], 'yes', undefined, hidden);
  assert.equal(fresh.moduleDefinitions.find(d => d.id === 'yes')?.instances.length, 0);
});
