import { useEffect, useRef } from 'react';
import type { LinkBudgetPoint } from '../../../engine/v1/link-budget';

export const scanMetrics = { gainDb: '射频增益', powerDbm: '射频输出功率', nfDb: '噪声系数' } as const;
export type ScanMetric = keyof typeof scanMetrics;

const width = 820;
const height = 218;
const left = 66;
const right = 798;
const top = 24;
const bottom = 183;

export function RfScanPlot({ points, metric, selected }: {
  points: readonly LinkBudgetPoint[]; metric: ScanMetric; selected: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const values = points.map(point => point[metric]).filter(item => item.availability === 'available');
  const extrapolated = (point: LinkBudgetPoint) => point.kind === 'conversion' && point.segments.some(segment => segment.extrapolated);
  const unavailableCount = points.length - values.length;

  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || !points.length) return;
    ctx.clearRect(0, 0, width, height);
    const available = points.flatMap(point => {
      const value = point[metric];
      return value.availability === 'available' ? [value.value] : [];
    });
    if (!available.length) return;
    const high = Math.max(...available);
    const low = Math.min(...available);
    const padding = Math.max((high - low) * 0.1, 0.1);
    const min = low - padding;
    const max = high + padding;
    const x = (index: number) => points.length === 1 ? (left + right) / 2
      : left + index / (points.length - 1) * (right - left);
    const y = (value: number) => bottom - (value - min) / (max - min) * (bottom - top);

    ctx.font = '12px system-ui';
    ctx.fillStyle = '#42605f';
    ctx.strokeStyle = '#cfdfdc';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const value = min + (max - min) * i / 4;
      const lineY = y(value);
      ctx.beginPath();
      ctx.moveTo(left, lineY);
      ctx.lineTo(right, lineY);
      ctx.stroke();
      ctx.fillText(value.toFixed(1), left - 8, lineY + 4);
    }
    ctx.textAlign = 'left';
    ctx.fillText(points[0][metric].unit, left, 15);
    ctx.fillText(`${points[0].frequencyGHz} GHz`, left, bottom + 22);
    if (points.length > 1) {
      ctx.textAlign = 'right';
      ctx.fillText(`${points.at(-1)!.frequencyGHz} GHz`, right, bottom + 22);
    }

    ctx.strokeStyle = '#207365';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let continuous = false;
    points.forEach((point, index) => {
      const item = point[metric];
      if (item.availability === 'unavailable') {
        continuous = false;
        return;
      }
      if (continuous) ctx.lineTo(x(index), y(item.value));
      else ctx.moveTo(x(index), y(item.value));
      continuous = true;
    });
    ctx.stroke();
    points.forEach((point, index) => {
      const item = point[metric];
      if (item.availability !== 'available') return;
      ctx.beginPath();
      ctx.fillStyle = extrapolated(point) ? '#a14e0b' : '#207365';
      ctx.arc(x(index), y(item.value), point.frequencyGHz === selected ? 4 : 2, 0, 2 * Math.PI);
      ctx.fill();
    });
  }, [points, metric, selected]);

  return <figure className="v1-scan-plot">
    {values.length ? <canvas ref={canvas} width={width} height={height} role="img"
      aria-label={`${scanMetrics[metric]}扫频曲线，缺值位置留空`} data-available={values.length} data-unavailable={unavailableCount} />
      : <p>当前指标没有可绘制的频点。请查看下方逐点诊断。</p>}
    <figcaption>{points.length} 个频点 · {unavailableCount} 点不可用{points.some(extrapolated) && ' · 橙色点为线性外推'}</figcaption>
  </figure>;
}
