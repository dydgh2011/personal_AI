/**
 * Dashboard modules. A new module (Agents, Skills/MCP, Memory, Assistant, Finance, Voice, Monitoring,
 * GitHub Publisher) adds one entry here plus its own route folder under src/app/(admin)/ and its
 * title/description in both dictionaries (src/i18n/{ko,en}/core.ts, shell.modules);
 * navigation and permissions come from this list, so existing pages do not change.
 * Only statically built code is loaded - there is no runtime plugin execution.
 */
import type { Dict } from '@/i18n';

export type Permission = 'admin';
export type ModuleId = keyof Dict['shell']['modules'];

export interface DashboardModule {
  id: ModuleId;
  href: string;
  permission: Permission;
}

export const MODULES: DashboardModule[] = [
  { id: 'overview', href: '/', permission: 'admin' },
  { id: 'tasks', href: '/tasks', permission: 'admin' },
  { id: 'projects', href: '/projects', permission: 'admin' },
  { id: 'reviews', href: '/reviews', permission: 'admin' },
  { id: 'learning', href: '/learning', permission: 'admin' },
  { id: 'ai-usage', href: '/ai-usage', permission: 'admin' },
  { id: 'knowledge', href: '/knowledge', permission: 'admin' },
  { id: 'services', href: '/services', permission: 'admin' },
];

/** Title and description of a module in the given language. */
export const moduleText = (t: Dict, id: ModuleId) => t.shell.modules[id];
