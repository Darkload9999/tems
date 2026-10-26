// Shared vocabulary for the people, project and ticket pages: labels, tags and
// small helpers. Mirrors the Go API's enums.
import type {
  AgreementStatus, DocCategory, Employee, EmployeeStage, EmploymentType, ProjectHealth, ProjectStatus,
  TicketPriority, TicketStatus, TicketType,
} from './types';
import { html, ico } from './ui';

export const DOCS: Record<DocCategory, { label: string; hint: string; payroll?: boolean }> = {
  birth_certificate: { label: 'Birth certificate', hint: 'Certified copy' },
  nic:               { label: 'NIC / passport', hint: 'Both sides of the NIC, or the passport photo page' },
  education:         { label: 'Educational qualification', hint: 'Degree, diploma, A/L or O/L certificates' },
  cv:                { label: 'CV / résumé', hint: '' },
  agreement:         { label: 'Agreement', hint: 'Signed agreements are filed here automatically' },
  epf:               { label: 'EPF', hint: 'EPF registration / member form', payroll: true },
  etf:               { label: 'ETF', hint: 'ETF registration', payroll: true },
  salary:            { label: 'Salary document', hint: 'Offer letter, salary revision, payslip', payroll: true },
  bank:              { label: 'Bank details', hint: 'Bank book or account confirmation', payroll: true },
  other:             { label: 'Other', hint: '' },
};
export const DOC_ORDER = Object.keys(DOCS) as DocCategory[];

export const STAGES: Array<{ key: EmployeeStage; label: string; icon: string }> = [
  { key: 'documents', label: 'Documents', icon: 'file' },
  { key: 'approval', label: 'Approval', icon: 'shield' },
  { key: 'agreement', label: 'Agreement', icon: 'edit' },
  { key: 'active', label: 'Active', icon: 'check' },
];
export const STAGE_LABEL: Record<EmployeeStage, string> = {
  documents: 'Collecting documents', approval: 'Awaiting approval', agreement: 'Agreement pending', active: 'Active', offboarded: 'Offboarded',
};
const STAGE_TONE: Record<EmployeeStage, string> = { documents: 'info', approval: 'warn', agreement: 'info', active: 'ok', offboarded: 'err' };
export const stageTag = (s: EmployeeStage) => html`<span class="tag ${STAGE_TONE[s]}"><span class="dot"></span>${STAGE_LABEL[s]}</span>`;

export const EMPLOYMENT: Record<EmploymentType, string> = { permanent: 'Permanent', contract: 'Contract', probation: 'Probation', intern: 'Intern' };

export const AGREEMENT_LABEL: Record<AgreementStatus, string> = { draft: 'Draft', sent: 'Sent', viewed: 'Opened', signed: 'Signed', void: 'Void' };
const AGREEMENT_TONE: Record<AgreementStatus, string> = { draft: '', sent: 'info', viewed: 'warn', signed: 'ok', void: 'err' };
export const agreementTag = (s: AgreementStatus) => html`<span class="tag ${AGREEMENT_TONE[s]}">${AGREEMENT_LABEL[s]}</span>`;

export const PROJECT_STATUS: Record<ProjectStatus, string> = { planning: 'Planning', active: 'Active', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' };
const PROJECT_TONE: Record<ProjectStatus, string> = { planning: 'info', active: 'ok', on_hold: 'warn', completed: 'dark', cancelled: 'err' };
export const projectTag = (s: ProjectStatus) => html`<span class="tag ${PROJECT_TONE[s]}">${PROJECT_STATUS[s]}</span>`;

export const HEALTH: Record<ProjectHealth, string> = { on_track: 'On track', at_risk: 'At risk', off_track: 'Off track' };
const HEALTH_TONE: Record<ProjectHealth, string> = { on_track: 'ok', at_risk: 'warn', off_track: 'err' };
export const healthTag = (h: ProjectHealth) => html`<span class="tag ${HEALTH_TONE[h]}"><span class="dot"></span>${HEALTH[h]}</span>`;

export const TICKET_STATUS: Record<TicketStatus, string> = { open: 'Open', in_progress: 'In progress', in_review: 'In review', resolved: 'Resolved', closed: 'Closed' };
export const TICKET_ORDER = Object.keys(TICKET_STATUS) as TicketStatus[];
const TICKET_TONE: Record<TicketStatus, string> = { open: 'info', in_progress: 'warn', in_review: 'warn', resolved: 'ok', closed: 'dark' };
export const ticketTag = (s: TicketStatus) => html`<span class="tag ${TICKET_TONE[s]}">${TICKET_STATUS[s]}</span>`;

export const PRIORITY: Record<TicketPriority, string> = { low: 'Low', medium: 'Medium', high: 'High', urgent: 'Urgent' };
const PRIORITY_TONE: Record<TicketPriority, string> = { low: '', medium: 'info', high: 'warn', urgent: 'err' };
export const priorityTag = (p: TicketPriority) => html`<span class="tag ${PRIORITY_TONE[p]}">${p === 'urgent' ? ico('warn') : ''}${PRIORITY[p]}</span>`;

export const TICKET_TYPE: Record<TicketType, string> = { task: 'Task', bug: 'Bug', feature: 'Feature', support: 'Support' };

export const empName = (e: Pick<Employee, 'firstName' | 'lastName'>) => [e.firstName, e.lastName].filter(Boolean).join(' ');

export function money(n: number, currency = 'LKR') {
  return `${currency} ${n.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Statutory contributions on basic salary (Sri Lanka): EPF 8% employee + 12% employer, ETF 3% employer. */
export function contributions(basic: number) {
  return { epfEmployee: basic * 0.08, epfEmployer: basic * 0.12, etf: basic * 0.03 };
}

export function fmtDate(d: string) {
  if (!d) return '—';
  return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fileSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(0)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

/** A starting point for the employment agreement, filled from the employee record. HR edits it before sending. */
export function agreementTemplate(e: Employee, org: string) {
  const name = empName(e);
  const pay = e.payroll && e.payroll.basicSalary ? money(e.payroll.basicSalary, e.payroll.currency) : '[basic salary]';
  const allow = e.payroll && e.payroll.allowances ? ` plus allowances of ${money(e.payroll.allowances, e.payroll.currency)}` : '';
  return {
    title: `Employment Agreement — ${name}`,
    body: `This Employment Agreement is made between ${org} ("the Company") and ${name}${e.nic ? ` (NIC ${e.nic})` : ''} ("the Employee").

1. Position. The Employee is employed as ${e.jobTitle || '[job title]'}${e.department ? ` in the ${e.department} department` : ''} on a ${EMPLOYMENT[e.employmentType].toLowerCase()} basis, starting on ${e.startDate ? fmtDate(e.startDate) : '[start date]'}.

2. Remuneration. The Company will pay a monthly basic salary of ${pay}${allow}, subject to statutory deductions.

3. EPF and ETF. The Company will contribute 12% of the basic salary to the Employees' Provident Fund (EPF) and 3% to the Employees' Trust Fund (ETF). The Employee contributes 8% of the basic salary to the EPF.

4. Working hours. Normal working hours are 40 hours per week, Monday to Friday, unless agreed otherwise.

5. Leave. The Employee is entitled to annual, casual and medical leave in accordance with the Shop and Office Employees Act and Company policy.

6. Confidentiality. The Employee will keep confidential all information about the Company, its clients and projects, during and after employment.

7. Termination. Either party may end this agreement by giving one month's written notice, or salary in lieu of notice.

By signing below, the Employee confirms that they have read, understood and accept these terms.`,
  };
}
