import { z } from 'zod';
import { HubServerError, type HubModeratedApplication, type HubServerContext } from '#engine/index.js';

/** The HTTP and MCP entries share this dispatcher; each application method validates its exact input. */
export async function executeHubService(app: HubModeratedApplication, context: HubServerContext, operation: string, input: unknown, signal?: AbortSignal) {
  const object = z.object({}).passthrough().parse(input), string = (key: string) => z.string().parse(object[key]);
  switch (operation) {
    case 'account.logout': return app.accounts.logout(context, signal);
    case 'account.delete': return app.accounts.remove(context, signal);
    case 'account.maintain': return app.accounts.maintain(context, signal);
    case 'profile.create': return app.profiles.create(context, input, signal);
    case 'profile.members': return app.profiles.members(context, string('profileId'), object.members, signal);
    case 'profile.invite': return app.profiles.invite(context, string('profileId'), object.member, signal);
    case 'profile.invitations': return app.profiles.invitations(context, z.string().optional().parse(object.after), z.number().optional().parse(object.limit), signal);
    case 'profile.invitation.respond': return app.profiles.respond(context, string('invitationId'), z.enum(['accept', 'decline']).parse(object.decision), signal);
    case 'profile.key.challenge': return app.profiles.keyChallenge(context, string('profileId'), object.key, signal);
    case 'profile.key.add': return app.profiles.addKey(context, string('profileId'), string('challengeId'), string('signature'), signal);
    case 'profile.key.recover': return app.profiles.requestRecovery(context, string('profileId'), string('challengeId'), string('lostKeyId'), string('signature'), signal);
    case 'profile.domain.challenge': return app.profiles.domainChallenge(context, string('profileId'), string('domain'), signal);
    case 'profile.domain.verify': return app.profiles.verifyDomain(context, string('profileId'), string('challengeId'), signal);
    case 'moderator.roster': return app.profiles.roster(context, input, signal);
    case 'moderation.queue': return app.moderation.queue(context, z.string().optional().parse(object.after), z.number().optional().parse(object.limit), signal);
    case 'moderation.bundle': return app.reviewBundle(context, string('packageId'), string('version'), string('keyId'), signal);
    case 'moderation.act': return app.moderation.act(context, input, signal);
    case 'moderation.escalate': return app.moderation.escalate(context, signal);
    case 'report.create': return app.report(context, input, signal);
    case 'report.list': return app.reports(context, string('keyId'), z.number().optional().parse(object.limit), signal);
    case 'audit.export': return app.accounts.audit(context, z.number().optional().parse(object.after), z.number().optional().parse(object.limit), signal);
    default: throw new HubServerError('HUB_RESOURCE_UNKNOWN');
  }
}
