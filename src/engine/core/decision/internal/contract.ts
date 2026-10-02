import { z } from 'zod';
import { createImmutableJsonObjectSchema, identitySchema, decisionCaseSchema, decisionPolicySchema, decisionAdviceSchema, decisionRecordSchema,
  modelReferenceSchema, modelActivationBindingSchema, verifiedPrincipalSchema, MODEL_INVOCATION_NATIVE_JSON_LIMITS,
  type DecisionCase, type DecisionAdvice, type DecisionPolicy, type DecisionRecord, type AuditEvent, type ModelInvocationCommand, type VerifiedPrincipal } from '#domain/index.js';
import type { PrincipalVerifier } from '#engine/core/authentication/index.js';
import type { ModelInvocationResult } from '#engine/core/model-invocation/index.js';
const ingress = createImmutableJsonObjectSchema(MODEL_INVOCATION_NATIVE_JSON_LIMITS);
const target = {schemaVersion:z.literal(1),scopeId:identitySchema,decisionId:identitySchema};
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const decisionPrepareInputSchema=ingress.pipe(z.object({schemaVersion:z.literal(1),case:decisionCaseSchema}).strict());
export const decisionAskCommandSchema=ingress.pipe(z.object({schemaVersion:z.literal(1),commandId:identitySchema,scopeId:identitySchema,case:decisionCaseSchema,
  invocation:z.object({reference:modelReferenceSchema,catalogRevision:identitySchema,expectedBinding:modelActivationBindingSchema}).strict()}).strict());
export const decisionQuerySchema=ingress.pipe(z.object(target).strict());
export const decisionRecordCommandSchema=ingress.pipe(z.object({...target,commandId:identitySchema,selectedOption:identitySchema,rationale:z.string().min(1)}).strict());
export const decisionOutcomeCommandSchema=ingress.pipe(z.object({...target,commandId:identitySchema,
  outcome:z.object({observedAt:z.string().datetime({offset:true}),observation:z.string().min(1)}).strict()}).strict());
export type DecisionPrepareInput=z.infer<typeof decisionPrepareInputSchema>;
export type DecisionAskCommand=z.infer<typeof decisionAskCommandSchema>;
export type DecisionQuery=z.infer<typeof decisionQuerySchema>;
export type DecisionRecordCommand=z.infer<typeof decisionRecordCommandSchema>;
export type DecisionOutcomeCommand=z.infer<typeof decisionOutcomeCommandSchema>;
export type DecisionStatus='advised'|'below-threshold'|'unknown'|'cancelled'|'unavailable';
export const decisionSnapshotSchema=z.object({schemaVersion:z.literal(1),scopeId:identitySchema,decisionId:identitySchema,
  command:decisionAskCommandSchema,requestDigest:digest,caseDigest:digest,policy:decisionPolicySchema,principal:verifiedPrincipalSchema,
  policyRevision:identitySchema,claimedAtMs:z.number().int().nonnegative(),status:z.enum(['pending','advised','below-threshold','unknown','cancelled','unavailable']),
  advice:decisionAdviceSchema.nullable(),adviceDigest:digest.nullable(),invocationId:identitySchema.nullable(),record:decisionRecordSchema.nullable()}).strict();
export type DecisionSnapshot=z.infer<typeof decisionSnapshotSchema>;
export interface DecisionPrepareResult {readonly schemaVersion:1;readonly case:DecisionCase;readonly caseDigest:string;readonly thresholds:DecisionPolicy['thresholds']}
export interface DecisionAskResult {readonly schemaVersion:1;readonly status:DecisionStatus;readonly decisionId:string;readonly caseDigest:string;
 readonly adviceDigest:string|null;readonly advice:DecisionAdvice|null;readonly thresholds:DecisionPolicy['thresholds'];readonly invocationId:string|null;readonly record:DecisionRecord|null;readonly replayed:boolean}
export type DecisionInspection=(DecisionAskResult & {readonly case:DecisionCase})|{readonly schemaVersion:1;readonly status:'not-found';readonly decisionId:string};
export interface DecisionRecordResult {readonly schemaVersion:1;readonly replayed:boolean;readonly record:DecisionRecord}
export type DecisionOutcomeResult=DecisionRecordResult;
export interface DecisionMutationReceipt {readonly scopeId:string;readonly commandId:string;readonly decisionId:string;readonly digest:string;readonly result:DecisionRecordResult}
export interface DecisionStore {
 load(scopeId:string,decisionId:string):Promise<DecisionSnapshot|null>;
 claim(snapshot:DecisionSnapshot,event:AuditEvent):Promise<{replayed:boolean;snapshot:DecisionSnapshot}>;
 settle(previous:DecisionSnapshot,next:DecisionSnapshot,event:AuditEvent):Promise<DecisionSnapshot>;
 receipt(scopeId:string,commandId:string):Promise<DecisionMutationReceipt|null>;
 mutate(previous:DecisionSnapshot,next:DecisionSnapshot,receipt:DecisionMutationReceipt,event:AuditEvent):Promise<{replayed:boolean;record:DecisionRecord}>;
 close():void;
}
export type DecisionAction='prepare'|'ask'|'record'|'outcome'|'inspect';
export interface DecisionDependencies {readonly verifier:PrincipalVerifier;
 readonly authorize:(action:DecisionAction,scopeId:string,resourceId:string,principal:VerifiedPrincipal)=>Promise<{revision:string;ruleId:string}>;
 readonly policy:()=>Promise<DecisionPolicy|null>;readonly openStore:(access:'read'|'write')=>Promise<DecisionStore>;
 readonly invoke:(command:ModelInvocationCommand,credential?:unknown,signal?:AbortSignal)=>Promise<ModelInvocationResult>;
 readonly now:()=>number;readonly eventId:()=>string;}
export class DecisionApplicationError extends Error {constructor(readonly code:'DECISION_INVALID'|'DECISION_UNAVAILABLE'|'DECISION_COMMAND_CONFLICT'|'DECISION_CORRUPT'|'DECISION_RECORD_REQUIRED'|'DECISION_OUTCOME_UNKNOWN') {super(code);this.name='DecisionApplicationError';}}
