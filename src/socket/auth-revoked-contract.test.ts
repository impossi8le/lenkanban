import { describe, expect, it } from 'vitest';
import { isInternalEmitPayload } from './internal-emit-contract';

describe('auth.revoked bridge contract', () => {
  it('accepts a personal-room revocation with a bounded reason', () => {
    expect(isInternalEmitPayload({
      event: 'auth.revoked', roomId: 'user:user-1', data: { userId: 'user-1', reason: 'role-demoted' },
    })).toBe(true);
  });

  it.each([
    [{ event: 'auth.revoked', roomId: 'user:user-1', data: { userId: 'other', reason: 'role-demoted' } }],
    [{ event: 'auth.revoked', roomId: 'user:user-1', data: { userId: 'user-1' } }],
    [{ event: 'auth.revoked', roomId: 'user:user-1', data: { userId: 'user-1', reason: '' } }],
    [{ event: 'auth.revoked', roomId: 'project:user-1', data: { userId: 'user-1', reason: 'role-demoted' } }],
    [{ event: 'auth.revoked', roomId: 'user:user-1', data: { userId: 'user-1', reason: 'x'.repeat(129) } }],
  ])('rejects an invalid revocation payload %#', payload => {
    expect(isInternalEmitPayload(payload)).toBe(false);
  });
});
