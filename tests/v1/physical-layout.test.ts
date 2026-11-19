import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleProject } from '../../src/model/v1/example';
import { updatePhysicalPlacement } from '../../src/state/v1/physical-layout';
import { createProjectStore } from '../../src/state/v1/project-store';

test('a physical edit updates only the selected occurrence and undoes independently of topology', () => {
  const store = createProjectStore(exampleProject);
  const before = store.getSnapshot().project;
  const [a, b] = before.layout!.physical!;
  const moved = { ...a, xMm: -5.25, yMm: 72.5, rotationDeg: 180 };
  assert.equal(store.commit(draft => updatePhysicalPlacement(draft, moved)).ok, true);
  const after = store.getSnapshot().project;
  assert.deepEqual(after.layout?.physical?.slice(0, 2), [moved, b]);
  assert.deepEqual(after.layout?.topology, before.layout?.topology);
  assert.deepEqual(after.moduleDefinitions, before.moduleDefinitions);
  store.undo();
  assert.equal(store.getSnapshot().project, before);
  assert.equal(store.getSnapshot().canUndo, false);
});

test('placement can use a different logical scope and invalid geometry creates no history', () => {
  const before = { ...exampleProject, layout: undefined };
  const store = createProjectStore(before);
  const placement = {
    instancePath: exampleProject.layout.physical[0].instancePath,
    enclosurePath: ['TX_B'], xMm: 10, yMm: 12, rotationDeg: 90,
  };
  assert.equal(store.commit(draft => updatePhysicalPlacement(draft, placement)).ok, true);
  const valid = store.getSnapshot();
  assert.deepEqual(valid.project.layout?.physical, [placement]);
  assert.equal(store.commit(draft => updatePhysicalPlacement(draft, { ...placement, rotationDeg: 45 })).ok, false);
  const cycle = { ...placement, instancePath: ['TX_B'] };
  assert.equal(store.commit(draft => updatePhysicalPlacement(draft, cycle)).ok, false);
  assert.equal(store.getSnapshot(), valid);
});
