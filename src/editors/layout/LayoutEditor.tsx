import { useEffect, useRef, useState } from 'react';
import { Stage, Layer, Group, Rect, Text, Line } from 'react-konva';
import { resolveInstances } from '../../engine/graph';
import type { Project } from '../../model/types';

type Props = {
  project: Project; selected: string; highlighted: string[];
  onSelect: (id: string) => void; onMove: (id: string, x: number, y: number) => void;
};
export function LayoutEditor({ project, selected, highlighted, onSelect, onMove }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(850);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    observer.observe(container.current!); return () => observer.disconnect();
  }, []);
  const scale = Math.min((width - 60) / project.chassis.width, 1.8);
  const height = project.chassis.depth * scale + 60;
  const items = resolveInstances(project).filter(i => 'size' in i.definition && project.layout.physical[i.id]);
  return <div ref={container} className="physical-canvas" data-testid="physical-canvas">
    <Stage width={width} height={height}>
      <Layer x={30} y={30} scaleX={scale} scaleY={scale}>
        <Rect width={project.chassis.width} height={project.chassis.depth} fill="#101c25" stroke="#607783" strokeWidth={1 / scale} />
        {Array.from({ length: Math.ceil(project.chassis.width / 50) }, (_, i) => <Line key={`x${i}`} points={[i * 50, 0, i * 50, project.chassis.depth]} stroke="#21343f" strokeWidth={.5} />)}
        {Array.from({ length: Math.ceil(project.chassis.depth / 50) }, (_, i) => <Line key={`y${i}`} points={[0, i * 50, project.chassis.width, i * 50]} stroke="#21343f" strokeWidth={.5} />)}
        <Text text={`1U  /  ${project.chassis.width} × ${project.chassis.depth} mm  /  H ${project.chassis.height} mm`} x={0} y={-12} fill="#8fa6b6" fontSize={9} />
        {items.map(item => {
          if (!('size' in item.definition)) return null;
          const position = project.layout.physical[item.id], size = item.definition.size;
          const active = highlighted.includes(item.id) || !!item.parentId && highlighted.includes(item.parentId);
          const label = item.parentId ? `${item.parentId}\n${item.definition.name}` : item.name;
          return <Group key={item.id} id={item.id} x={position.x} y={position.y} rotation={position.rotation} draggable
            onClick={() => onSelect(item.id)} onTap={() => onSelect(item.id)}
            onDragStart={() => onSelect(item.id)}
            onDragEnd={event => onMove(item.id, event.target.x(), event.target.y())}>
            <Rect width={size.width} height={size.depth} cornerRadius={2} fill={active ? '#244b4a' : '#213340'} stroke={item.id === selected ? '#f0bb73' : active ? '#76deca' : '#516775'} strokeWidth={1.3 / scale} />
            <Text text={label} x={3} y={5} width={size.width - 6} height={size.depth - 7} fontSize={8} fill="#e4edf2" wrap="char" />
          </Group>;
        })}
      </Layer>
    </Stage>
    <div className="canvas-hint">拖动器件定位 · 位置单位 mm · 选中后可在属性面板旋转 90°</div>
  </div>;
}
