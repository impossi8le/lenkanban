import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { externalIdentityKey, normalizeEmail, planExternalLink, type ExternalIdentity } from "@/lib/auth";
import { corporateAdmission } from "@/lib/sso-provider";
import { emitAuthRevoked } from "@/socket/board-events";

/** All binding decisions and writes share one serializable transaction; conflicts fail closed. */
export async function applyCorporateIdentity(identity: ExternalIdentity, action: "login" | "link" | "sync",
  proof?: { userId: string; password: string }) {
  const key = externalIdentityKey(identity);
  if (!key) return null;
  let revokedId: string | null = null;
  const result = await prisma.$transaction(async tx => {
    const bound = await tx.user.findUnique({ where: { externalId: key } });
    const admitted = corporateAdmission(identity);
    if (action === "sync" || !admitted) {
      // A sync cannot create or rebind users, nor clear an administrator's block.
      if (bound && !admitted) {
        await tx.user.update({ where: { id: bound.id }, data: { isBlocked: true, blockedAt: new Date() } });
        revokedId = bound.id;
      }
      return action === "sync" && bound ? { id: bound.id, admitted: admitted && !bound.isBlocked && !bound.blockedAt } : null;
    }
    const email = normalizeEmail(identity.email);
    if (!email) return null;
    const byEmail = await tx.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } });
    const plan = planExternalLink({ identity, key,
      existingByExternalId: bound && { ...bound, isBlocked: bound.isBlocked || !!bound.blockedAt },
      existingByEmail: byEmail && { ...byEmail, isBlocked: byEmail.isBlocked || !!byEmail.blockedAt },
    });
    if (action === "link") {
      if (!proof || (bound && bound.id !== proof.userId)) return null;
      const user = await tx.user.findUnique({ where: { id: proof.userId } });
      if (!user || user.isBlocked || user.blockedAt || (user.externalId && user.externalId !== key) ||
          !user.passwordHash || !(await bcrypt.compare(proof.password, user.passwordHash))) return null;
      if (byEmail && byEmail.id !== user.id) return null;
      if (plan.action === "deny" && plan.reason !== "email-owned-by-local-account") return null;
      const changed = await tx.user.updateMany({ where: { id: user.id, externalId: user.externalId, isBlocked: false, blockedAt: null },
        data: { externalId: key, authSource: identity.provider, passwordHash: null, resetToken: null, resetTokenExpiry: null } });
      return changed.count === 1 ? { id: user.id } : null;
    }
    if (plan.action === "deny") return null;
    if (plan.action === "link") {
      if (byEmail && byEmail.id !== plan.userId) return null;
      return tx.user.update({ where: { id: plan.userId }, data: { email }, select: { id: true, email: true, name: true } });
    }
    return tx.user.create({ data: { email, name: identity.name, externalId: key, authSource: identity.provider, globalRole: "USER" },
      select: { id: true, email: true, name: true } });
  }, { isolationLevel: "Serializable" });
  if (revokedId) emitAuthRevoked(revokedId, "corporate-access-revoked");
  return result;
}
