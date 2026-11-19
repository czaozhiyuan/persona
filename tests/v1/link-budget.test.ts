import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { createLinkBudget } from '../../src/engine/v1/link-budget';
import type { LinkBudgetConditions } from '../../src/engine/v1/link-budget';
import { topologyExample } from '../../src/model/v1/topology-example';
import type { NamedLink } from '../../src/model/v1/topology';
import type { Project } from '../../src/model/v1/types';

const [draft, , calibratedLink] = topologyExample.namedLinks;
const rfLink: NamedLink = {
  id: 'rf', name: 'Pure RF', from: { instancePath: ['rfSource'], portId: 'OUT' },
  to: { instancePath: ['amp'], portId: 'OUT' },
};
const opticalConditions: LinkBudgetConditions = {
  inputPowerDbm: -20,
  opticalSources: [{ endpoint: { instancePath: ['TX_A', 'laser'], portId: 'OUT' }, channelId: 'DWDM_CH28', powerDbm: 0 }],
};

function fixture(operatingPointLoss = 2, alternateRfBranch = false): Project {
  const [root, tx, rx] = topologyExample.moduleDefinitions;
  return {
    ...topologyExample,
    componentDefinitions: [
      ...topologyExample.componentDefinitions,
      { kind: 'component', id: 'laser', name: 'Laser', ports: [{ id: 'OUT', type: 'OPTICAL', direction: 'out' }] },
      { kind: 'component', id: 'amp', name: 'RF amplifier',
        ports: [{ id: 'IN', type: 'RF', direction: 'in' }, { id: 'OUT', type: 'RF', direction: 'out' }],
        transfers: [{ kind: 'rf', fromPortId: 'IN', toPortId: 'OUT',
          gainDb: { kind: 'rfCurve', points: [[1, 10], [67, 20]] }, nfDb: { kind: 'fixed', value: 3 } }] },
    ],
    moduleDefinitions: [{
      ...root,
      instances: [
        ...root.instances.map(item => item.id === 'TX_A' ? { ...item,
          parameterOverrides: { operatingPointLoss: { kind: 'fixed' as const, value: operatingPointLoss } },
        } : item),
        { id: 'amp', name: 'Amp', definitionId: 'amp' },
        { id: 'rfSource', name: 'RF source', definitionId: 'rf-source' },
        ...(alternateRfBranch ? [{ id: 'alternate', name: 'Alternate amp', definitionId: 'amp' }] : []),
      ],
      connections: [
        ...(root.connections ?? []),
        { id: 'rf', from: { instanceId: 'rfSource', portId: 'OUT' }, to: { instanceId: 'amp', portId: 'IN' } },
        ...(alternateRfBranch ? [
          { id: 'alternate-in', from: { instanceId: 'rfSource', portId: 'OUT' }, to: { instanceId: 'alternate', portId: 'IN' } },
          { id: 'alternate-out', from: { instanceId: 'alternate', portId: 'OUT' }, to: { instanceId: 'amp', portId: 'IN' } },
        ] : []),
      ],
    }, {
      ...tx,
      instances: [...tx.instances, { id: 'laser', name: 'Laser', definitionId: 'laser' }],
      connections: [...(tx.connections ?? []), { id: 'laser-feed', from: { instanceId: 'laser', portId: 'OUT' },
        to: { instanceId: 'mzm', portId: 'SUPPLY' } }],
    }, {
      ...rx, portMappings: [{ portId: 'OPT_IN', target: { instanceId: 'pd', portId: 'IN' } }],
    }],
    conversionProfiles: [{ id: 'reference', name: 'Measured span',
      rfGainRefDb: { kind: 'rfCurve', points: [[1, -22], [67, -16]] }, pdPowerRefDbm: -5 }],
    namedLinks: [...topologyExample.namedLinks, rfLink],
  };
}

function value(metric: BudgetMetric) {
  assert.equal(metric.availability, 'available');
  return metric.value;
}

test('inclusive fixed-step RF scans retain all 68 points and agree with single-point budgets', () => {
  const { calculateNamedLink, scanNamedLink } = createLinkBudget(fixture());
  const conditions = { inputPowerDbm: -20 };
  const result = scanNamedLink(rfLink, { startGHz: 0, stopGHz: 67 }, conditions);
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.points.map(point => point.frequencyGHz), Array.from({ length: 68 }, (_, index) => index));
  const [first] = result.points;
  assert.equal(first.kind, 'rf');
  assert.equal(first.status, 'partial');
  assert.equal(first.gainDb.availability, 'unavailable');
  assert.match(first.gainDb.reason, /outside the empirical curve/);
  assert.equal(value(first.stages[0].powerDbm), -20);
  for (const frequencyGHz of [0, 1, 34, 67]) {
    assert.deepEqual(result.points[frequencyGHz], calculateNamedLink(rfLink, { ...conditions, frequencyGHz }));
  }
  assert.deepEqual(result.points.slice(1).map(point => point.status), Array(67).fill('valid'));
  assert.equal(value(result.points[34].gainDb), 15);
  assert.equal(value(result.points[67].powerDbm), 0);
  for (const frequencyGHz of [0, 67]) {
    assert.deepEqual(scanNamedLink(rfLink, { startGHz: frequencyGHz, stopGHz: frequencyGHz }, conditions),
      { status: 'complete', points: [result.points[frequencyGHz]] });
  }
});

test('invalid ranges are rejected while draft and ambiguous paths keep a diagnostic at every requested frequency', () => {
  const budget = createLinkBudget(fixture());
  for (const [startGHz, stopGHz] of [[0.5, 2], [1, 2.5], [5, 4], [-1, 0], [0, 68], [NaN, 67]]) {
    const result = budget.scanNamedLink(rfLink, { startGHz, stopGHz });
    assert.equal(result.status, 'invalid_range');
    assert.match(result.reason, /integers from 0 to 67 GHz/);
    assert.deepEqual(result.points, []);
  }
  const ambiguous = createLinkBudget(fixture(2, true));
  for (const [scan, code] of [
    [budget.scanNamedLink(draft, { startGHz: 5, stopGHz: 6 }), 'incomplete'],
    [ambiguous.scanNamedLink(rfLink, { startGHz: 5, stopGHz: 6 }), 'ambiguous'],
  ] as const) {
    assert.equal(scan.status, 'complete');
    assert.deepEqual(scan.points.map(point => point.frequencyGHz), [5, 6]);
    for (const point of scan.points) {
      assert.equal(point.kind, 'unresolved');
      assert.equal(point.status, 'error');
      assert.equal(point.pathIssue.status, code);
      assert.equal(point.gainDb.availability, 'unavailable');
    }
  }
});

test('EO→OE scans keep optical power and diagnostics, use discrete channels and reflect new project snapshots', () => {
  const budget = createLinkBudget(fixture());
  const scan = budget.scanNamedLink(calibratedLink, { startGHz: 0, stopGHz: 67 }, opticalConditions);
  for (const [frequencyGHz, expectedGain] of [[0, undefined], [1, -22], [34, -19], [67, -16]] as const) {
    const point = scan.points[frequencyGHz];
    assert.deepEqual(point, budget.calculateNamedLink(calibratedLink, { ...opticalConditions, frequencyGHz }));
    assert.equal(point.kind, 'conversion');
    assert.equal(point.status, 'partial');
    assert.equal(value(point.segments[0].pdPowerDbm), -5);
    assert.equal(point.segments[0].channelId, 'DWDM_CH28');
    assert.equal(point.nfDb.availability, 'unavailable');
    assert.match(point.nfDb.reason, /not modeled/);
    if (expectedGain === undefined) {
      assert.equal(point.gainDb.availability, 'unavailable');
      assert.match(point.gainDb.reason, /outside the empirical curve/);
    } else {
      assert.equal(value(point.gainDb), expectedGain);
    }
  }
  const updated = createLinkBudget(fixture(3)).scanNamedLink(calibratedLink, { startGHz: 34, stopGHz: 34 }, opticalConditions).points[0];
  assert.equal(updated.kind, 'conversion');
  assert.equal(value(updated.segments[0].pdPowerDbm), -6);
  assert.equal(value(updated.gainDb), -20.8);
  assert.equal(value(budget.calculateNamedLink(calibratedLink, { ...opticalConditions, frequencyGHz: 34 }).gainDb), -19);
  const changedChannel = budget.scanNamedLink({ ...calibratedLink, channelId: 'DWDM_CH30' },
    { startGHz: 34, stopGHz: 34 }, opticalConditions).points[0];
  assert.equal(changedChannel.kind, 'conversion');
  assert.equal(changedChannel.gainDb.availability, 'unavailable');
  assert.ok(changedChannel.diagnostics.some(diagnostic => diagnostic.code === 'optical_supply'));
  const suppliedCh30 = budget.scanNamedLink({ ...calibratedLink, channelId: 'DWDM_CH30' }, { startGHz: 34, stopGHz: 34 },
    { ...opticalConditions, opticalSources: [{ ...opticalConditions.opticalSources![0], channelId: 'DWDM_CH30', powerDbm: 5 }] }).points[0];
  assert.equal(suppliedCh30.kind, 'conversion');
  assert.equal(suppliedCh30.segments[0].channelId, 'DWDM_CH30');
  assert.equal(value(suppliedCh30.segments[0].pdPowerDbm), 0);
  assert.equal(value(suppliedCh30.gainDb), -10);
});
