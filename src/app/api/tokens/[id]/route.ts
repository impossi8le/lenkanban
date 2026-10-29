import { prisma } from "@/lib/prisma";
import { NotFoundError, ValidationError } from '@/lib/errors';
import { organizationId } from '@/lib/organization-api';
import { tokenApi } from '../token-api';

export function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return tokenApi(request, '/api/tokens/[id]', async userId => {
    const parsed = organizationId.safeParse((await context.params).id);
    if (!parsed.success) throw new ValidationError();
    const id = parsed.data;
    // Ownership is in the write predicate; retries preserve the original time.
    const changed = await prisma.apiToken.updateMany({
      where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    if (changed.count === 0 && !await prisma.apiToken.findFirst({
      where: { id, userId }, select: { id: true },
    })) throw new NotFoundError();
    return new Response(null, { status: 204 });
  }, true);
}
