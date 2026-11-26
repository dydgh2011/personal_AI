import { LearningTabs } from '@/components/learning/client';
import s from '@/components/learning/learning.module.css';
import { getT } from '@/i18n/server';
import { learning } from '@/lib/learning';
import type { LearningStatus } from '@/lib/learning-types';

export const dynamic = 'force-dynamic';

/** Learning section frame: one sub-navigation with live counts (counts are omitted if the service is down). */
export default async function LearningLayout({ children }: { children: React.ReactNode }) {
  const status: LearningStatus | null = await learning.status().catch(() => null);
  const c = status?.counts;
  const tab = (await getT()).learn.tabs;
  const decide = (c?.awaitingDecision ?? 0) + (c?.pendingProposals ?? 0);
  return (
    <div className={s.page}>
      <LearningTabs
        items={[
          { href: '/learning', label: tab.overview, count: decide, hot: decide > 0 },
          { href: '/learning/domains', label: tab.domains, also: ['/learning/roadmaps'] },
          { href: '/learning/milestones', label: tab.milestones, count: c?.assignmentsOpen, also: ['/learning/assignments', '/learning/rubrics'] },
          { href: '/learning/planner', label: tab.planner },
          { href: '/learning/evaluations', label: tab.evaluations, count: c?.awaitingEvaluation, hot: (c?.awaitingEvaluation ?? 0) > 0 },
          { href: '/learning/skills', label: tab.skills, count: c?.gapsSuggested, hot: (c?.gapsSuggested ?? 0) > 0 },
          { href: '/learning/ideas', label: tab.ideas, count: c?.ideasInbox },
        ]}
      />
      {children}
    </div>
  );
}
