import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveEmpiricalValue } from '../../src/engine/v1/empirical-value';
import { curveAxis, curveProblem, flatCurve, graphValue, moveCurvePoint } from '../../src/workbench/v1/properties/curve-graph';

test('dB editing snaps only the knots and respects neighboring frequencies and field limits', () => {
  const axis = curveAxis('dB', flatCurve(0));
  assert.deepEqual(axis, { min: -20, max: 20, step: 0.5 });
  assert.equal(graphValue(-3.26, axis, 'dB'), -3.5);
  assert.equal(graphValue(-3.26, axis, 'dB', { min: 0.2 }), 0.5);
  const points = moveCurvePoint([[0, 0], [17, 0], [67, 0]], 1, 18.3, -3.5);
  assert.deepEqual(points[1], [18, -3.5]);
  assert.deepEqual(moveCurvePoint(points, 1, 68, 20)[1], [66, 20]);
  assert.deepEqual(moveCurvePoint(points, 0, 2, 10)[0], [0, 10]);
  assert.deepEqual(resolveEmpiricalValue('dB', { kind: 'rfCurve', points }, { frequencyGHz: 9 }),
    { unit: 'dB', availability: 'available', value: -1.75 });
});

test('existing partial and non-grid values remain readable while physical ordinates retain their precision', () => {
  const partial = [[1.5, 22.25], [40, 5]] as const;
  assert.match(curveProblem(partial, 'dB')!, /1.5 GHz，22.25 dB/);
  assert.match(curveProblem([[1, 2], [67, 3]], 'dB')!, /端点/);
  const precise = flatCurve(0.001234567);
  assert.equal(curveProblem(precise, 'V', { min: Number.MIN_VALUE }), undefined);
  const axis = curveAxis('V', precise, { min: Number.MIN_VALUE });
  assert.ok(axis.min < 0.001234567 && axis.max > 0.001234567 && axis.step < 0.0001);
  assert.ok(graphValue(-1, axis, 'V', { min: Number.MIN_VALUE }) > 0);
  assert.equal(curveProblem(flatCurve(-2.34567), 'V/W'), undefined);
});
