/**
 * Dashboard modules. A new module (Agents, Skills/MCP, Memory, Assistant, Finance, Voice, Monitoring,
 * GitHub Publisher) adds one entry here plus its own route folder under src/app/(admin)/;
 * navigation and permissions come from this list, so existing pages do not change.
 * Only statically built code is loaded - there is no runtime plugin execution.
 */
export type Permission = 'admin';

export interface DashboardModule {
  id: string;
  title: string;
  href: string;
  description: string;
  permission: Permission;
}

export const MODULES: DashboardModule[] = [
  { id: 'overview', title: 'Overview', href: '/', description: 'Service health and task counts', permission: 'admin' },
  { id: 'tasks', title: 'Tasks', href: '/tasks', description: 'Claude / Codex tasks', permission: 'admin' },
  { id: 'projects', title: 'Projects', href: '/projects', description: 'Project registry', permission: 'admin' },
  { id: 'reviews', title: 'Code Reviews', href: '/reviews', description: 'Diffs and approvals', permission: 'admin' },
  { id: 'learning', title: 'Learning', href: '/learning', description: 'AI Learning OS: domains, ideas, goals, roadmaps', permission: 'admin' },
];
