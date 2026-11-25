import { readableError } from '../../model/v1/display-names';
import type { PortDefinition, Project } from '../../model/v1/types';
import { validateProject } from '../../model/v1/validate';
import { assertProjectShape, ProjectStructureError } from './project-schema';
export { ProjectStructureError } from './project-schema';

export const PROJECT_FILE_FORMAT = 'persona-project';
export const PROJECT_SCHEMA_VERSION = 2;

export class ProjectFileError extends Error {
  constructor(readonly stage: 'syntax' | 'format' | 'domain', message: string, options?: ErrorOptions, readonly displayMessage?: string) {
    super(message, options);
    this.name = 'ProjectFileError';
  }
}

export function projectErrorMessage(error: unknown, project?: Project): string {
  return error instanceof ProjectFileError && error.displayMessage
    ? error.displayMessage : readableError(error instanceof Error ? error.message : String(error), project);
}

/** Checks an in-memory snapshot without changing it. */
export function validateProjectSnapshot(value: unknown): asserts value is Project {
  assertProjectShape(value);
  try {
    validateProject(value);
  } catch (error) {
    const message = `$.project: ${(error as Error).message}`;
    throw new ProjectFileError('domain', message, { cause: error }, readableError(message, value));
  }
}

function jsonSyntaxMessage(source: string, error: unknown): string {
  const message = '工程 JSON 语法无效。';
  if (!(error instanceof SyntaxError)) return message;

  const location = /\bline (\d+) column (\d+)(?:\)| of the JSON data)?$/.exec(error.message);
  if (location) return `${message} 第 ${location[1]} 行，第 ${location[2]} 列。`;

  const position = /\bat position (\d+)$/.exec(error.message);
  if (position) return `${message} 字符偏移 ${position[1]}（从 0 开始）。`;

  if (/^(?:Unexpected end of JSON input|JSON Parse error: Unexpected EOF)$/.test(error.message)) {
    const lines = source.split(/\r\n|\r|\n/);
    return `${message} 文件在第 ${lines.length} 行，第 ${lines.at(-1)!.length + 1} 列意外结束。`;
  }
  return message;
}

/** Drops obsolete display preferences only from freshly parsed definitions. */
export function discardImportedPortSides(definitions: readonly { ports: readonly PortDefinition[] }[]) {
  for (const definition of definitions) {
    for (const port of definition.ports) {
      if ('side' in port) delete port.side;
    }
  }
}

/** Returns a new snapshot only after the whole file passes validation. */
export function parseProjectJson(source: string): Project {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ProjectFileError('syntax', jsonSyntaxMessage(source, error), { cause: error });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProjectFileError('format', '$：工程文件根节点必须为 Persona 工程对象');
  }
  const file = value as Record<string, unknown>;
  if (!Object.hasOwn(file, 'format') || file.format !== PROJECT_FILE_FORMAT) {
    throw new ProjectFileError('format', `$.format：必须为「${PROJECT_FILE_FORMAT}」`);
  }
  if (!Object.hasOwn(file, 'schemaVersion') || file.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    const reason = file.schemaVersion === 1 ? '版本 1 使用旧参数格式，请在当前工作台重建器件参数。'
      : `仅支持版本 ${PROJECT_SCHEMA_VERSION}。`;
    throw new ProjectFileError('format', `$.schemaVersion：${reason}`);
  }
  for (const key of Object.keys(file)) {
    if (!['format', 'schemaVersion', 'project'].includes(key)) {
      throw new ProjectStructureError(`$[${JSON.stringify(key)}]`, '未知字段');
    }
  }
  const project = Object.hasOwn(file, 'project') ? file.project : undefined;
  validateProjectSnapshot(project);
  discardImportedPortSides([...project.componentDefinitions, ...project.moduleDefinitions]);
  return project;
}

/** Applies the same shape and domain rules as import before producing file content. */
export function serializeProjectJson(project: Project): string {
  validateProjectSnapshot(project);
  const file = { format: PROJECT_FILE_FORMAT, schemaVersion: PROJECT_SCHEMA_VERSION, project };
  return JSON.stringify(file, null, 2) + '\n';
}
