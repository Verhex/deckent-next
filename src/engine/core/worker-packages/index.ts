export { changePackageAllowance, type PackageConsentRequest, type PackageConsentCard } from './internal/package-consent.js';
export { capturePackageSecrets, scanPackageSecrets } from './internal/package-secrets.js';
export { withPackageUse } from './internal/package-use.js';
export { nativePackageAdmission, inspectNativePackageInputs } from './internal/native-inputs.js';
export { assertAttemptPackageInput, reopenAttemptPackage } from './internal/attempt-reopen.js';
export { packageActivity, packageIntentId } from './internal/package-activity.js';
export type { NativePackageProfileSelector, PackageBinding, PackageKnownSecrets, PackageSecretPort, PackageSecretSnapshot, WorkerPackagePorts } from './internal/ports.js';
