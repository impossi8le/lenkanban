import { apiBadRequest, apiError, apiForbidden, apiInternalError, apiNotFound, apiUnauthorized } from '@/lib/api-response';
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '@/lib/errors';
import { requireTrustedMutationOrigin } from '@/lib/mutation-origin';
import { requireDbUser } from '@/lib/require-user';
import { withApiLogging } from '@/middleware/api-logger';
import { TelemetryHttpError } from '@/lib/telemetry/http';

/** Token issuance/revocation uses cookie identity only, never bearer delegation. */
export function tokenApi(request: Request, route: string,
  handler: (userId: string) => Promise<Response>, mutation = false): Promise<Response> {
  return withApiLogging(request, async (_request, context) => {
    let response: Response;
    try {
      const user = await requireDbUser(request);
      context.actorId = user.id;
      if (mutation) {
        // Cookies authenticate this endpoint; bearer cannot waive Origin.
        const cookieRequest = new Request(request.url, { headers: request.headers });
        cookieRequest.headers.delete('authorization');
        requireTrustedMutationOrigin(cookieRequest);
      }
      response = await handler(user.id);
    } catch (error) {
      if (error instanceof UnauthorizedError) response = apiUnauthorized();
      else if (error instanceof ForbiddenError) response = apiForbidden();
      else if (error instanceof NotFoundError) response = apiNotFound();
      else if (error instanceof ValidationError) response = apiBadRequest('Invalid token request');
      else if (error instanceof TelemetryHttpError) response = apiError('INVALID_REQUEST', 'Token request rejected', undefined, error.status);
      else response = apiInternalError('Token request failed');
    }
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }, { route });
}
