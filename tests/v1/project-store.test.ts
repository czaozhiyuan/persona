import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleProject } from '../../src/model/v1/example';
import { topologyExample } from '../../src/model/v1/topology-example';
import { createProjectStore } from '../../src/state/v1/project-store';

test('valid edits create one history entry and a new edit discards redo', () => {
  const store = createProjectStore(exampleProject);
  const original = store.getSnapshot().project;
  const names: string[] = [];
  const unsubscribe = store.subscribe(() => names.push(store.getSnapshot().project.name));
  assert.equal(store.commit(draft => ({ ...draft, name: 'Edited' })).ok, true);
  assert.equal(store.getSnapshot().canUndo, true);
  store.undo();
  assert.equal(store.getSnapshot().project, original);
  assert.equal(store.getSnapshot().canUndo, false);
  assert.equal(store.getSnapshot().canRedo, true);
  store.redo();
  assert.equal(store.getSnapshot().project.name, 'Edited');
  store.undo();
  assert.equal(store.commit(draft => ({ ...draft, name: 'Other edit' })).ok, true);
  assert.equal(store.getSnapshot().canRedo, false);
  store.redo();
  assert.equal(store.getSnapshot().project.name, 'Other edit');
  unsubscribe();
  store.undo();
  assert.deepEqual(names, ['Edited', original.name, 'Edited', original.name, 'Other edit']);
});

test('invalid edits and invalid replacements preserve the current snapshot and history', () => {
  const store = createProjectStore(exampleProject);
  store.commit(draft => ({ ...draft, name: 'Edited' }));
  store.undo();
  const before = store.getSnapshot();
  let notifications = 0;
  store.subscribe(() => { notifications++; });
  const failure = store.commit(draft => {
    draft.name = 'Rejected change';
    draft.rootModuleDefinitionId = 'missing';
    return draft;
  });
  assert.equal(failure.ok, false);
  assert.match(failure.message, /根定义「missing」/);
  assert.equal(store.replaceProject({ ...exampleProject, rootModuleDefinitionId: 'missing' }).ok, false);
  assert.equal(store.getSnapshot(), before);
  assert.equal(notifications, 0);
  assert.equal(before.canRedo, true);
  store.redo();
  assert.equal(store.getSnapshot().project.name, 'Edited');
});

test('navigation and selections never edit the project, and stale references fall back', () => {
  const store = createProjectStore(topologyExample);
  const project = store.getSnapshot().project;
  store.selectModule(['TX_A']);
  store.selectInstance(['TX_A', 'mzm']);
  store.selectLink('full');
  store.setView('physical');
  assert.deepEqual(store.getSnapshot().selection, {
    modulePath: ['TX_A'], instancePath: ['TX_A', 'mzm'], linkId: 'full', view: 'physical',
  });
  assert.equal(store.getSnapshot().project, project);
  assert.equal(store.getSnapshot().canUndo, false);

  store.commit(draft => ({ ...draft, namedLinks: [] }));
  assert.equal(store.getSnapshot().selection.linkId, undefined);
  assert.deepEqual(store.getSnapshot().selection.instancePath, ['TX_A', 'mzm']);
  store.undo();
  assert.equal(store.getSnapshot().selection.linkId, undefined);
  assert.ok(store.getSnapshot().project.namedLinks?.some(link => link.id === 'full'));

  store.commit(draft => ({
    ...draft,
    moduleDefinitions: [...draft.moduleDefinitions, {
      kind: 'module', id: 'alternate', name: 'Alternate', ports: [], instances: [],
    }],
    rootModuleDefinitionId: 'alternate', namedLinks: [],
  }));
  assert.deepEqual(store.getSnapshot().selection.modulePath, []);
  assert.equal(store.getSnapshot().selection.instancePath, undefined);
  assert.equal(store.getSnapshot().selection.view, 'physical');
  store.undo();
  store.selectModule(['TX_A']);
  store.selectInstance(['TX_A', 'mzm']);
  store.redo();
  assert.deepEqual(store.getSnapshot().selection.modulePath, []);
  assert.equal(store.getSnapshot().selection.instancePath, undefined);
});

test('opening a new project resets history and selections and does not share mutable input', () => {
  const store = createProjectStore(topologyExample);
  store.commit(draft => ({ ...draft, name: 'Edited' }));
  store.selectModule(['TX_A']);
  store.selectLink('full');
  const input = { ...exampleProject };
  assert.equal(store.replaceProject(input).ok, true);
  input.name = 'Caller mutation';
  const state = store.getSnapshot();
  assert.equal(state.project.name, exampleProject.name);
  assert.ok(Object.isFrozen(state.project.moduleDefinitions[0].instances[0]));
  assert.deepEqual(state.selection, { view: 'topology', modulePath: [] });
  assert.equal(state.canUndo, false);
  assert.equal(state.canRedo, false);
});
