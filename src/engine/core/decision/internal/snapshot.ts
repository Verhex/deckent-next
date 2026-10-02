import { isDeepStrictEqual } from 'node:util';
import { encodeCommandProjection, prepareDecisionCase, encodeDecisionAdvice, validateDecisionAdvice, DECISION_ABSTENTIONS } from '#domain/index.js';
import { sha256 } from '#platform/index.js';
import { decisionSnapshotSchema, DecisionApplicationError, type DecisionSnapshot } from './contract.js';
export function validateDecisionSnapshot(input:unknown):DecisionSnapshot {
 try {
  const value=decisionSnapshotSchema.parse(input);
  const prepared=prepareDecisionCase(value.command.case,value.policy,value.claimedAtMs);
  if(value.scopeId!==value.command.scopeId||value.decisionId!==value.command.commandId||value.command.case.scope!==value.scopeId
   ||sha256(prepared.canonicalCase)!==value.caseDigest||sha256(encodeCommandProjection('decision-ask:1',value.command))!==value.requestDigest
   ||!value.principal.scopeIds.includes(value.scopeId))throw Error();
  if(value.status==='advised'||value.status==='below-threshold') {
   const checked=validateDecisionAdvice(value.advice,value.command.case,value.policy);
   if(checked.status!==value.status||sha256(encodeDecisionAdvice(checked.advice))!==value.adviceDigest||!value.invocationId)throw Error();
  }else if(value.advice!==null||value.adviceDigest!==null||value.record!==null)throw Error();
  if(value.record&&(value.record.id!==value.decisionId||value.record.scope!==value.scopeId||value.record.caseDigest!==value.caseDigest
   ||!isDeepStrictEqual(value.record.adviceRef,{invocationId:value.invocationId,adviceDigest:value.adviceDigest})
   ||![...value.command.case.options.map(option=>option.id),...DECISION_ABSTENTIONS].includes(value.record.actor.selectedOption)))throw Error();
  return value;
 }catch {throw new DecisionApplicationError('DECISION_CORRUPT');}
}
