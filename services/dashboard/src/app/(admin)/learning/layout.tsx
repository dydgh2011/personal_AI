import { LearningTabs } from '@/components/learning/client';
import s from '@/components/learning/learning.module.css';
import { learning } from '@/lib/learning';
import type { LearningStatus } from '@/lib/learning-types';

export const dynamic = 'force-dynamic';

/** Learning section frame: one sub-navigation with live counts (counts are omitted if the service is down). */
export default async function LearningLayout({ children }: { children: React.ReactNode }) {
  const status: LearningStatus | null = await learning.status().catch(() => null);
  const c = status?.counts;
  const decide = (c?.awaitingDecision ?? 0) + (c?.pendingProposals ?? 0);
  return (
    <div className={s.page}>
      <LearningTabs
        items={[
          { href: '/learning', label: 'Overview', count: decide, hot: decide > 0 },
          { href: '/learning/domains', label: 'Domains & goals', also: ['/learning/roadmaps'] },
          { href: '/learning/milestones', label: 'Milestones', count: c?.assignmentsOpen, also: ['/learning/assignments', '/learning/rubrics'] },
          { href: '/learning/planner', label: 'Planner' },
          { href: '/learning/evaluations', label: 'Evaluations', count: c?.awaitingEvaluation, hot: (c?.awaitingEvaluation ?? 0) > 0 },
          { href: '/learning/skills', label: 'Skills & gaps', count: c?.gapsSuggested, hot: (c?.gapsSuggested ?? 0) > 0 },
          { href: '/learning/ideas', label: 'Ideas', count: c?.ideasInbox },
        ]}
      />
      {children}
    </div>
  );
}
