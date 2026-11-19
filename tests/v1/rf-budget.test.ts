import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRfBudget } from '../../src/engine/v1/rf-budget';
import type { BudgetMetric } from '../../src/engine/v1/budget-metric';
import { topologyExample } from '../../src/model/v1/topology-example';
import type { ComponentDefinition, EndpointRef, PortDefinition, Project } from '../../src/model/v1/types';

const fixed = (value: number) => ({ kind: 'fixed' as const, value });
const port = (id: string, direction: PortDefinition['direction']): PortDefinition => ({ id, direction, type: 'RF' });
const local = (instanceId: string, portId: string) => ({ instanceId, portId });
const endpoint = (instancePath: readonly string[], portId: string): EndpointRef => ({ instancePath, portId });
const from = endpoint(['chain'], 'IN'), to = endpoint(['chain'], 'OUT');
const request = { from, to };
const link = { id: 'rf', name: 'RF budget', ...request };
const input = { frequencyGHz: 10, inputPowerDbm: -20 };

function fixture({ missingNf = false, limitedGain = 'none', route = 'connected' }: {
  missingNf?: boolean; limitedGain?: 'none' | 'first' | 'last'; route?: 'connected' | 'open' | 'ambiguous';
} = {}): Project {
  const curve = { kind: 'rfCurve', points: [[2, 5], [4, 5]] } as const;
  const first: ComponentDefinition = {
    kind: 'component', id: 'first', name: 'First amplifier',
    ports: [{ ...port('IN', 'in'), inputRating: { unit: 'dBm', max: -21 } }, port('OUT', 'out')],
    parameters: [{ id: 'gain', name: 'Gain', kind: 'numeric', unit: 'dB', valueKind: 'fixed',
      defaultValue: fixed(8), overridable: true }],
    transfers: [{ kind: 'rf', fromPortId: 'IN', toPortId: 'OUT', nfDb: fixed(3),
      gainDb: limitedGain === 'first' ? curve : { kind: 'parameter', parameterId: 'gain' } }],
  };
  const second: ComponentDefinition = {
    kind: 'component', id: 'second', name: 'Second stage',
    ports: [port('IN', 'in'), port('OUT', 'out')],
    transfers: [{ kind: 'rf', fromPortId: 'IN', toPortId: 'OUT',
      gainDb: limitedGain === 'last' ? curve : fixed(missingNf ? -5 : 5), nfDb: missingNf ? undefined : fixed(6) }],
  };
  return {
    id: 'rf-budget', name: 'RF budget', rootModuleDefinitionId: 'system',
    componentDefinitions: [first, second],
    moduleDefinitions: [{
      kind: 'module', id: 'system', name: 'System', ports: [],
      instances: [{ id: 'chain', name: 'Chain', definitionId: 'chain' }],
    }, {
      kind: 'module', id: 'chain', name: 'Chain', ports: [port('IN', 'in'), port('OUT', 'out')],
      instances: [
        { id: 'a', name: first.name, definitionId: first.id, parameterOverrides: { gain: fixed(10) } },
        { id: 'b', name: second.name, definitionId: second.id },
        ...(route === 'ambiguous' ? [{ id: 'c', name: 'Alternate stage', definitionId: second.id }] : []),
      ],
      portMappings: [{ portId: 'IN', target: local('a', 'IN') }, { portId: 'OUT', target: local('b', 'OUT') }],
      connections: [
        ...(route === 'open' ? [] : [{ id: 'rf', from: local('a', 'OUT'), to: local('b', 'IN'), mediaKind: 'RF_COAX' as const }]),
        ...(route === 'ambiguous' ? [
          { id: 'branch', from: local('a', 'OUT'), to: local('c', 'IN') },
          { id: 'merge', from: local('c', 'OUT'), to: local('b', 'IN') },
        ] : []),
      ],
    }],
    namedLinks: [link],
  };
}

function value(metric: BudgetMetric) {
  assert.equal(metric.availability, 'available');
  return metric.value;
}

function missing(metric: BudgetMetric, reason: RegExp) {
  assert.equal(metric.availability, 'unavailable');
  assert.match(metric.reason, reason);
}

test('a local or named RF budget uses actual instance gain, linear Friis weighting and independent input ratings', () => {
  const calculator = createRfBudget(fixture());
  const result = calculator.calculateLocal(request, input);
  assert.deepEqual(calculator.calculateNamedLink(link, input), result);
  assert.equal(result.status, 'valid');
  assert.equal(value(result.gainDb), 15);
  assert.equal(value(result.powerDbm), -5);
  assert.ok(Math.abs(value(result.nfDb) - 3.6047) < 0.001);
  assert.deepEqual(result.stages.map(item => value(item.powerDbm)), [-20, -20, -10, -10, -5, -5]);
  assert.deepEqual(result.stages.map(item => value(item.cumulativeGainDb)), [0, 0, 10, 10, 15, 15]);
  assert.deepEqual(result.stages.flatMap(item => item.incoming?.device ? [value(item.incoming.device.nfDb)] : []), [3, 6]);
  assert.deepEqual(result.stages[1].rating, { endpoint: endpoint(['chain', 'a'], 'IN'),
    limits: { unit: 'dBm', max: -21 }, status: 'above_max', value: -20, excess: 1 });
  const withoutPower = calculator.calculateLocal(request, { frequencyGHz: 10 });
  assert.equal(withoutPower.status, 'partial');
  assert.equal(value(withoutPower.gainDb), 15);
  assert.equal(value(withoutPower.nfDb), value(result.nfDb));
  assert.equal(withoutPower.stages[1].rating?.status, 'unknown');
  missing(withoutPower.powerDbm, /未提供射频输入功率/);
});

test('missing NF or out-of-range gain only affects dependent metrics and preserves upstream results', () => {
  const noNf = createRfBudget(fixture({ missingNf: true })).calculateLocal(request, input);
  assert.equal(noNf.status, 'partial');
  assert.equal(value(noNf.gainDb), 5);
  assert.equal(value(noNf.powerDbm), -15);
  missing(noNf.nfDb, /未设置经验值/);
  const last = createRfBudget(fixture({ limitedGain: 'last' })).calculateLocal(request, { ...input, frequencyGHz: 0 });
  assert.equal(last.status, 'partial');
  assert.equal(value(last.stages[2].powerDbm), -10);
  assert.ok(Math.abs(value(last.nfDb) - value(createRfBudget(fixture()).calculateLocal(request, input).nfDb)) < 1e-12);
  missing(last.gainDb, /超出经验曲线范围/);
  missing(last.powerDbm, /超出经验曲线范围/);
  const first = createRfBudget(fixture({ limitedGain: 'first' })).calculateLocal(request, input);
  assert.ok(Math.abs(value(first.stages[2].cumulativeNfDb) - 3) < 1e-12);
  missing(first.nfDb, /前级射频增益/);
});

test('RF budgets preserve path failures and reject invalid frequencies and non-RF ports', () => {
  for (const [route, expected] of [['open', 'unreachable'], ['ambiguous', 'ambiguous']] as const) {
    const result = createRfBudget(fixture({ route })).calculateNamedLink(link, input);
    assert.equal(result.status, 'error');
    assert.equal(result.pathIssue?.status, expected);
    assert.deepEqual(result.stages, []);
    for (const metric of [result.gainDb, result.nfDb, result.powerDbm]) assert.equal(metric.availability, 'unavailable');
  }
  const calculator = createRfBudget(fixture());
  assert.equal(calculator.calculateLocal(request, { frequencyGHz: 67 }).gainDb.availability, 'available');
  for (const frequencyGHz of [-1, 68, NaN]) {
    assert.equal(calculator.calculateLocal(request, { frequencyGHz }).pathIssue?.status, 'invalid_frequency');
  }
  const optical = endpoint(['TX_A', 'mzm'], 'OUT');
  assert.equal(createRfBudget(topologyExample).calculateLocal({ from: optical, to: optical }, input).pathIssue?.status, 'not_pure_rf');
});
