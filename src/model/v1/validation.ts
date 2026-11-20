export function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function indexById<T extends { id: string }>(items: readonly T[], context: string): Map<string, T> {
  const index = new Map<string, T>();
  for (const item of items) {
    requireValid(item.id.trim(), `${context}: ID 不得为空`);
    requireValid(!index.has(item.id), `${context}: ID「${item.id}」重复`);
    index.set(item.id, item);
  }
  return index;
}
