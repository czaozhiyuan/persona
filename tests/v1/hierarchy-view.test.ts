import assert from 'node:assert/strict';
import { test } from 'node:test';
import { displayDepth, hierarchyKey, layoutHierarchy } from '../../src/editors/topology/v1/hierarchy-view';
import { resolveHierarchy } from '../../src/engine/v1/hierarchy';
import { exampleProject } from '../../src/model/v1/example';

test('depth shows direct children first and can expand every nested instance without mixing reused scopes', () => {
  const instances = [...resolveHierarchy(exampleProject).walkInstances()];
  assert.equal(displayDepth(instances, []), 5);
  assert.deepEqual(layoutHierarchy(instances, [], 1).map(node => node.item.instancePath), [['TX_A'], ['TX_B']]);
  const projected = layoutHierarchy(instances, [], displayDepth(instances, []));
  assert.equal(projected.length, instances.length - 1);
  const a = ['TX_A', 'TX_SLOT', 'TX_CBB', 'MZM_MODULE', 'MZM_OPTICAL'];
  const b = ['TX_B', ...a.slice(1)];
  assert.equal(projected.find(node => node.key === hierarchyKey(a))?.parentKey, hierarchyKey(a.slice(0, -1)));
  assert.equal(projected.find(node => node.key === hierarchyKey(b))?.parentKey, hierarchyKey(b.slice(0, -1)));
  assert.equal(projected.find(node => node.key === hierarchyKey(['TX_A']))?.expanded, true);
  assert.equal(displayDepth(instances, ['TX_A', 'TX_SLOT']), 3);
  const scoped = layoutHierarchy(instances, ['TX_A', 'TX_SLOT'], 3);
  assert.ok(scoped.every(node => node.item.instancePath[0] === 'TX_A'));
  assert.equal(scoped[0].item.definition.id, 'slot');
});
