import { useEffect, useRef, useState } from 'react';
import type Konva from 'konva';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type { InstancePath, PhysicalEnclosure, PhysicalPlacement } from '../../../model/v1/types';
import { alignedPosition, gridStepMm, normalizeRotation, placementBounds } from './layout-geometry';
import type { LayoutBounds, LayoutPoint, PlacedObject } from './layout-geometry';

type Props = {
  enclosure: PhysicalEnclosure;
  objects: readonly PlacedObject[];
  selectedKey?: string;
  warned: ReadonlySet<string>;
  snap: boolean;
  select: (path?: InstancePath) => void;
  move: (placement: PhysicalPlacement) => void;
  drop: (key: string, point: LayoutPoint) => void;
};

export const physicalDragType = 'application/x-persona-v1-physical-instance';
const height = 420;
const padding = 26;

function sceneBounds(enclosure: PhysicalEnclosure, objects: readonly PlacedObject[]): LayoutBounds {
  let left = 0, top = 0, right = enclosure.widthMm, bottom = enclosure.depthMm;
  for (const { placement, footprint } of objects) {
    const bounds = placementBounds(placement, footprint);
    left = Math.min(left, bounds.left);
    top = Math.min(top, bounds.top);
    right = Math.max(right, bounds.right);
    bottom = Math.max(bottom, bounds.bottom);
  }
  return { left, top, right, bottom };
}

function Grid({ enclosure, scale }: { enclosure: PhysicalEnclosure; scale: number }) {
  const step = gridStepMm * Math.max(1, Math.ceil(9 / scale / gridStepMm));
  const lines: number[][] = [];
  for (let x = step; x < enclosure.widthMm; x += step) lines.push([x, 0, x, enclosure.depthMm]);
  for (let y = step; y < enclosure.depthMm; y += step) lines.push([0, y, enclosure.widthMm, y]);
  return <>{lines.map((points, index) => <Line key={index} points={points} stroke="#d5e3dd" strokeWidth={1 / scale} listening={false} />)}</>;
}

export function LayoutCanvas({ enclosure, objects, selectedKey, warned, snap, select, move, drop }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const stage = useRef<Konva.Stage>(null);
  const scene = useRef<Konva.Group>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = container.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { left, top, right, bottom } = sceneBounds(enclosure, objects);
  const scale = Math.min(Math.max(width - 2 * padding, 1) / (right - left), (height - 2 * padding) / (bottom - top));

  return <div className="v1-layout-canvas" ref={container} aria-label="机箱俯视画布"
    onDragOver={event => {
      if (!event.dataTransfer.types.includes(physicalDragType)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    }}
    onDrop={event => {
      if (!event.dataTransfer.types.includes(physicalDragType)) return;
      event.preventDefault();
      stage.current?.setPointersPositions(event.nativeEvent);
      const point = scene.current?.getRelativePointerPosition();
      if (point) drop(event.dataTransfer.getData(physicalDragType), alignedPosition(point, snap));
    }}>
    {width > 0 && <Stage ref={stage} width={width} height={height} onClick={event => {
      if (event.target === event.target.getStage()) select();
    }}>
      <Layer>
        <Group ref={scene} x={padding - left * scale} y={padding - top * scale} scaleX={scale} scaleY={scale}>
          <Rect width={enclosure.widthMm} height={enclosure.depthMm} fill="#f8fcfa" stroke="#64867f" strokeWidth={2 / scale} listening={false} />
          <Grid enclosure={enclosure} scale={scale} />
          <Text text="0, 0" x={4 / scale} y={-17 / scale} fontSize={12 / scale} fill="#45635f" listening={false} />
          {objects.map(({ placement, name, footprint }) => {
            const key = JSON.stringify(placement.instancePath);
            const active = key === selectedKey;
            const warning = warned.has(key);
            const color = warning ? '#b14029' : active ? '#905017' : '#257168';
            const area = placementBounds(placement, footprint);
            const x = area.left - placement.xMm, y = area.top - placement.yMm;
            const w = area.right - area.left, h = area.bottom - area.top;
            const pixel = 1 / scale;
            const insetLabel = footprint && w * scale > 90 && h * scale > 28;
            return <Group key={key} x={placement.xMm} y={placement.yMm} draggable
              onClick={() => select(placement.instancePath)} onTap={() => select(placement.instancePath)}
              onDragStart={() => select(placement.instancePath)}
              onDragMove={event => {
                if (snap) event.target.position(alignedPosition(event.target.position(), true));
              }}
              onDragEnd={event => {
                const { x, y } = alignedPosition(event.target.position(), snap);
                if (x !== placement.xMm || y !== placement.yMm) move({ ...placement, xMm: x, yMm: y });
              }}>
              {footprint ? <Rect x={x} y={y} width={w} height={h} fill={active ? '#f5e4d1' : '#cce7df'}
                stroke={color} strokeWidth={(active ? 3 : 2) * pixel} /> : <Circle radius={8 * pixel}
                fill="#fbfdfc" stroke={color} strokeWidth={(active ? 3 : 2) * pixel} dash={[3 * pixel, 2 * pixel]} />}
              <Group rotation={normalizeRotation(placement.rotationDeg)} listening={false}>
                <Line points={[0, 0, 15 * pixel, 0, 11 * pixel, -3 * pixel]} stroke={color} strokeWidth={1.5 * pixel} />
              </Group>
              <Circle radius={2.4 * pixel} fill={color} listening={false} />
              <Text text={footprint ? name : `${name} · 尺寸未设置`} x={footprint ? x + 5 * pixel : 12 * pixel}
                y={insetLabel ? y + 8 * pixel : y - 16 * pixel} width={insetLabel ? w - 10 * pixel : undefined}
                wrap="none" ellipsis={!!insetLabel} fontSize={12 * pixel} fill="#183039" listening={false} />
            </Group>;
          })}
        </Group>
      </Layer>
    </Stage>}
  </div>;
}
