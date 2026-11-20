import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { updatePhysicalPlacement } from '../../src/state/v1/physical-layout';
import { createProjectStore } from '../../src/state/v1/project-store';
import { parseProjectJson } from '../../src/storage/v1/project-json';
import { returnToTopology } from '../../src/workbench/v1/view-navigation';

const project = parseProjectJson(readFileSync(new URL('../../examples/v1-project.json', import.meta.url), 'utf8'));
const modulator = ['TX_A', 'mzm'];

test('returning from another physical enclosure finds the selected device in its logical parent', () => {
  const store = createProjectStore(updatePhysicalPlacement(project, {
    instancePath: modulator, enclosurePath: ['TX_B'], xMm: 20, yMm: 20, rotationDeg: 0,
  }));
  store.selectModule(['TX_A']);
  store.selectInstance(modulator);
  const before = store.getSnapshot();
  store.setView('physical');
  store.selectModule(['TX_B']);
  store.selectInstance(modulator);

  returnToTopology(store, before.selection);

  assert.deepEqual(store.getSnapshot().selection, before.selection);
  assert.equal(store.getSnapshot().project, before.project);
  assert.equal(store.getSnapshot().canUndo, false);
});

test('an unchanged selection keeps the original module scope, including a nested selection in overview', () => {
  const store = createProjectStore(project);
  store.selectInstance(modulator);
  const before = store.getSnapshot().selection;
  store.setView('physical');

  returnToTopology(store, before);

  assert.deepEqual(store.getSnapshot().selection, before);
});
