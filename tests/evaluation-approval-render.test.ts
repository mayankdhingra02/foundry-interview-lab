import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovedEvaluationContent } from '../features/reviews/evaluation-panel';
import { buildEvaluationRepository } from '../lib/server/evaluation-library';
import { hypotheticalApproval } from './evaluation-approval-fixtures';

describe('approved output is escaped read-only inspection content', () => {
  it('renders report, next steps, proposal and evidence metadata without interpreting instructions/HTML', () => {
    const detail = buildEvaluationRepository(hypotheticalApproval().source).details[0];
    const html = renderToStaticMarkup(createElement(ApprovedEvaluationContent, { content: detail.approvedContent! }));
    expect(html).toContain('HYPOTHETICAL-DISPLAY-OUTPUT &lt;script&gt;'); expect(html).not.toContain('<script>');
    expect(html).toContain('it does not establish that the findings are correct');
    expect(html).toContain('Interviewer proposal'); expect(html).toContain('Evidence identifiers and immutable metadata');
    expect(html).toContain(detail.approvedContent!.report.rubric[0].evidenceIds[0]);
    expect(html).not.toContain('PRIVATE-'); expect(html).not.toContain('<button'); expect(html).not.toContain('<textarea');
  });
});
