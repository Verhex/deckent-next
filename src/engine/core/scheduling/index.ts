export { planSchedulingWave, measureTaskOccupancy, measureResourceOccupancy, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ SchedulingError } from './internal/wave.js';
export { capacityResourceKeySchema, resourceCapacityInputSchema, remainingCapacity, hasCapacityRoom } from './internal/resource-capacity.js';
export type { ResourceCapacityInput } from './internal/resource-capacity.js';
export { diagnoseReservationWave, reservationDiagnosticParams } from './internal/diagnostic.js';
export type { ReservationDiagnostic, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ReservationDiagnosticReason, /** @deprecated No importer in Core; barrel name kept for one release (Tur 2 Q17). */ ReservationDiagnosticSite } from './internal/diagnostic.js';
