import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignedPosition, inspectLayout, placementBounds } from '../../src/editors/layout/v1/layout-geometry';
import { parseProjectJson, serializeProjectJson } from '../../src/storage/v1/project-json';
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

test('quarter-turn bounds use the original placement anchor and unknown sizes do not cause warnings', () => {
  const placed = exampleProject.layout.physical[0];
  const footprint = { widthMm: 40, depthMm: 20 };
  const a = { name: 'A', footprint, placement: { ...placed, xMm: 15, yMm: 5, rotationDeg: 90 } };
  assert.deepEqual(placementBounds(a.placement, footprint), { left: -5, top: 5, right: 15, bottom: 45 });
  assert.deepEqual(placementBounds({ ...a.placement, rotationDeg: 270 }, footprint),
    { left: 15, top: -35, right: 35, bottom: 5 });
  const b = { name: 'B', footprint, placement: { ...placed, xMm: 14, yMm: 6, rotationDeg: 0 } };
  const unknown = { name: 'Unknown', placement: { ...placed, xMm: -50, yMm: -10 } };
  const enclosure = { widthMm: 100, depthMm: 60 };
  assert.deepEqual(inspectLayout(enclosure, [a, b, unknown]), [
    { kind: 'outside', object: a }, { kind: 'overlap', object: a, other: b },
  ]);
  const inside = { ...a, placement: { ...a.placement, xMm: 20 } };
  const touches = { ...b, placement: { ...b.placement, xMm: 20 } };
  assert.deepEqual(inspectLayout(enclosure, [inside, touches, unknown]), []);
  assert.deepEqual(alignedPosition({ x: 17.2, y: -13.1 }, true), { x: 20, y: -10 });
  assert.deepEqual(alignedPosition({ x: 17.2, y: -13.1 }, false), { x: 17.2, y: -13.1 });
});

test('physical dimensions round-trip per occurrence and outside or overlapping designs remain savable', () => {
  const suggested = { widthMm: 35, depthMm: 18 };
  const project = { ...exampleProject, componentDefinitions: exampleProject.componentDefinitions.map(component =>
    ({ ...component, physicalFootprint: suggested })) };
  const store = createProjectStore(project);
  const [a, b, childEnclosure] = store.getSnapshot().project.layout!.physical!;
  const placement = { ...a, xMm: -20, rotationDeg: 270, footprint: { widthMm: 60, depthMm: 30 } };
  assert.ok(store.commit(draft => updatePhysicalPlacement(draft, placement)).ok);
  const restored = parseProjectJson(serializeProjectJson(store.getSnapshot().project));
  assert.deepEqual(restored.layout?.physical?.slice(0, 2), [placement, b]);
  assert.deepEqual(restored.componentDefinitions[0].physicalFootprint, suggested);
  assert.deepEqual(restored.layout?.topology, project.layout.topology);
  assert.equal(store.commit(draft => updatePhysicalPlacement(draft, { ...childEnclosure, footprint: suggested })).ok, false);
  assert.equal(store.commit(draft => updatePhysicalPlacement(draft, { ...placement, footprint: { widthMm: 0, depthMm: 10 } })).ok, false);
  store.undo();
  assert.deepEqual(store.getSnapshot().project.layout?.physical?.[0], a);
});
