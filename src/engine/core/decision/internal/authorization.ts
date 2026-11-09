import { evaluatePolicy, policyResources, type VerifiedPrincipal } from '#domain/index.js';
import { PolicyAuthorizationError, policyVerdictRefusal, type PolicySource } from '#engine/core/policy/index.js';
import type { DecisionAction } from './contract.js';
export class DecisionPolicyAuthorization {
 constructor(private readonly source:PolicySource){}
 async authorize(action:DecisionAction,scopeId:string,id:string,principal:VerifiedPrincipal){
  let decision;try{decision=evaluatePolicy(await this.source.load(),{principal,scopeId,action,resource:{kind:policyResources.decision.kind,id}});}
  catch{throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');}
  const refusal=policyVerdictRefusal(decision.decision,{deny:'POLICY_DENIED'});
  if(refusal)throw new PolicyAuthorizationError(refusal);
  if(!decision.ruleId)throw new PolicyAuthorizationError('POLICY_UNAVAILABLE');
  return {revision:decision.revision,ruleId:decision.ruleId};
 }
}
