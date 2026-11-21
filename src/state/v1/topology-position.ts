export function defaultTopologyPosition(index: number, portCount: number) {
  return { x: 260 * (index % 3) + (portCount ? 260 : 25), y: 240 * Math.floor(index / 3) + 25 };
}
