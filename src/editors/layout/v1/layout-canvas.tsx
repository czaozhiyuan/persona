import { useEffect, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type { InstancePath, PhysicalEnclosure, PhysicalPlacement } from '../../../model/v1/types';

type PlacedObject = { placement: PhysicalPlacement; name: string; enclosure?: PhysicalEnclosure };
type Props = {
  enclosure: PhysicalEnclosure;
  objects: readonly PlacedObject[];
  selected?: InstancePath;
  select: (path?: InstancePath) => void;
  move: (placement: PhysicalPlacement) => void;
};

const height = 420;
const padding = 32;

/** Includes outlying placements while keeping the enclosure's own origin fixed in millimetres. */
function sceneBounds(enclosure: PhysicalEnclosure, objects: readonly PlacedObject[]) {
  let left = 0, top = 0, right = enclosure.widthMm, bottom = enclosure.depthMm;
  for (const { placement, enclosure: child } of objects) {
    const { xMm, yMm, rotationDeg } = placement;
    const turn = ((rotationDeg % 360) + 360) % 360 / 90;
    const xSpan = child ? [child.widthMm, -child.depthMm, -child.widthMm, child.depthMm][turn] : 0;
    const ySpan = child ? [child.depthMm, child.widthMm, -child.depthMm, -child.widthMm][turn] : 0;
    left = Math.min(left, xMm, xMm + xSpan);
    right = Math.max(right, xMm, xMm + xSpan);
    top = Math.min(top, yMm, yMm + ySpan);
    bottom = Math.max(bottom, yMm, yMm + ySpan);
  }
  return { left, top, right, bottom };
}

export function LayoutCanvas({ enclosure, objects, selected, select, move }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = container.current!;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { left, top, right, bottom } = sceneBounds(enclosure, objects);
  const scale = Math.min(Math.max(width - 2 * padding, 1) / (right - left), (height - 2 * padding) / (bottom - top));
  const selectedKey = selected && JSON.stringify(selected);

  return <div className="v1-layout-canvas" ref={container} aria-label="机箱俯视画布">
    {width > 0 && <Stage width={width} height={height} onClick={event => {
      if (event.target === event.target.getStage()) select();
    }}>
      <Layer>
        <Group x={padding - left * scale} y={padding - top * scale} scaleX={scale} scaleY={scale}>
          <Rect width={enclosure.widthMm} height={enclosure.depthMm} fill="#f8fcfa" stroke="#64867f" strokeWidth={2 / scale} listening={false} />
          <Text text="0, 0" x={4 / scale} y={-17 / scale} fontSize={12 / scale} fill="#45635f" listening={false} />
          {objects.map(({ placement, name, enclosure: child }) => {
            const key = JSON.stringify(placement.instancePath);
            const active = key === selectedKey;
            const color = active ? '#a9561e' : '#257168';
            return <Group key={key} x={placement.xMm} y={placement.yMm} rotation={placement.rotationDeg % 360}
              draggable
              onClick={() => select(placement.instancePath)} onTap={() => select(placement.instancePath)}
              onDragStart={() => select(placement.instancePath)}
              onDragEnd={event => {
                const { x, y } = event.target.position();
                if (x !== placement.xMm || y !== placement.yMm) move({ ...placement, xMm: x, yMm: y });
              }}>
              {child ? <Rect width={child.widthMm} height={child.depthMm} fill={active ? '#f5e4d1' : '#dcefeb'}
                stroke={color} strokeWidth={2 / scale} /> : <>
                <Circle radius={8 / scale} fill={color} />
                <Line points={[0, 0, 27 / scale, 0, 21 / scale, -4 / scale]} stroke={color} strokeWidth={2 / scale} />
              </>}
              <Circle radius={3 / scale} fill={child ? color : '#fff'} listening={false} />
              <Text text={name} x={9 / scale} y={child ? 9 / scale : 6 / scale} fontSize={12 / scale}
                fill="#183039" listening={false} />
            </Group>;
          })}
        </Group>
      </Layer>
    </Stage>}
  </div>;
}
