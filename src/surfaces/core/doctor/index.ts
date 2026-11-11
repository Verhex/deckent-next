export { renderAuditStatus, renderAuditReason } from './internal/audit.js';
export { renderDoctorReport } from './internal/report.js';
export { DOCTOR_BACKUP_PASSPHRASE_SECRET, DOCTOR_FIXES, DOCTOR_RETIREMENT_STATES, doctorChecks, doctorNeedsAttention, renderDoctorChecks } from './internal/checks.js';
export { firstJobStages, firstJobSteps, firstJobTitle, onboardingNext, poolProvisioned, type FirstJobFacts } from './internal/first-job.js';
export type { DoctorCheck, DoctorCheckFacts, ExecutionEnvironmentDoctorView } from './internal/checks.js';
export type { DoctorRenderInput, InstallationBindingReport, RecoveryFilesDoctorView, ShellRealmDoctorView } from './internal/report.js';
export { filesystemIdentityText } from './internal/report.js';

export type { InstallationStartabilityView } from './internal/report.js';
