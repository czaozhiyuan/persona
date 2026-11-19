import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasEdgeKey, projectPathHighlight } from '../../src/editors/topology/v1/path-highlight';
import { signalPortKey } from '../../src/engine/v1/signal-graph';
import { topologyExample } from '../../src/model/v1/topology-example';
import { editModule } from '../../src/state/v1/topology-edits';
import { createLinkOptions, requiredEdgeKey } from '../../src/workbench/v1/links/link-options';

test('Link choices distinguish reused scoped records, half-open cores, and EO/OE instance boundaries', () => {
  const options = createLinkOptions(topologyExample);
  assert.deepEqual(options.via.filter(item => 'connectionId' in item.value && item.value.connectionId === 'rf-feed')
    .map(item => item.key), [requiredEdgeKey({ scopePath: ['TX_A'], connectionId: 'rf-feed' }),
    requiredEdgeKey({ scopePath: ['TX_B'], connectionId: 'rf-feed' })]);
  assert.match(options.via.find(item => 'coreId' in item.value && item.value.coreId === 'open')?.label ?? '', /未接全/);
  assert.deepEqual(options.eo.map(item => item.value.instancePath), [['TX_A', 'mzm'], ['TX_B', 'mzm']]);
  assert.deepEqual(options.oe.map(item => item.value.instancePath), [['RX_A', 'pd'], ['RX_B', 'pd']]);
});

test('path projection shows the active fibre and mapping only in their actual occurrence scope', () => {
  const link = topologyExample.namedLinks.find(item => item.id === 'full')!;
  const missing = createLinkOptions(topologyExample).resolveNamedLink(link);
  assert.equal(missing.status, 'incomplete');
  assert.ok(projectPathHighlight(missing, []).ports.has(signalPortKey({ instancePath: ['RX_A'], portId: 'OPT_IN' })));
  const mapped = editModule(topologyExample, 'rx', module => ({
    ...module, portMappings: [{ portId: 'OPT_IN', target: { instanceId: 'pd', portId: 'IN' } }],
  }));
  const result = createLinkOptions(mapped).resolveNamedLink(link);
  assert.equal(result.status, 'unreachable');
  assert.equal(result.trace?.supplies[0].status, 'missing');
  const root = projectPathHighlight(result, []);
  assert.deepEqual([...root.edges], [canvasEdgeKey('core', 'mpo-12', 'wdm')]);
  assert.deepEqual([...root.folded], ['TX_A', 'RX_A']);
  assert.deepEqual([...projectPathHighlight(result, ['TX_A']).edges],
    [canvasEdgeKey('connection', 'rf-feed'), canvasEdgeKey('mapping', 'OPT_OUT')]);
  assert.equal(projectPathHighlight(result, ['TX_B']).edges.size, 0);
});
