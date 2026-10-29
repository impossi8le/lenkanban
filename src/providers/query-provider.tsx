"use client"

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { reconcileMyDaySessionDrafts } from '@/features/my-day/my-day-draft'

const MINUTE = 60_000

/** Task/board data is invalidated by socket events and mutations. */
export const QUERY_STALE_TIME = MINUTE

/** Reference data changes rarely and is invalidated by mutations/sockets. */
export const REFERENCE_STALE_TIME = 5 * MINUTE

export const QUERY_GC_TIME = 5 * MINUTE

/** Access/validation failures and cancelled reads cannot improve on retry. */
export function retryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') return false
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status : undefined
  if (typeof status === 'number' && status >= 400 && status < 500) return false
  return true
}

/**
 * Slow-changing reference data: projects, board structure, members, tags and
 * the settings catalogs. Sockets and mutations invalidate these keys, so a
 * longer stale window does not hide changes; it only avoids refetching them
 * on every section switch.
 */
const REFERENCE_QUERY_KEYS: ReadonlyArray<ReadonlyArray<string>> = [
  ['projects'],
  ['project'],
  ['columns'],
  ['tags'],
  ['project-members'],
  ['projectMembers'],
  ['saved-views'],
  ['templates'],
  ['project-templates'],
  ['automation-rules'],
  ['recurring-tasks'],
  ['board-creation'],
]

export function createQueryClient(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Realtime socket events (task:*, column:*, message:*, notification:*,
        // auth.revoked, project:access-revoked) and mutation callbacks call
        // invalidateQueries, so regaining browser-tab focus must not refetch
        // every active query. Focus refetch was reloading data that was
        // already current and made tab switches feel slow.
        refetchOnWindowFocus: false,
        // Stale data still refetches when its component mounts, so navigating
        // between sections picks up changes without a focus-triggered refetch.
        refetchOnMount: true,
        // Losing and regaining the network is a real gap the socket may miss.
        refetchOnReconnect: true,
        staleTime: QUERY_STALE_TIME,
        // Bound inactive cache instead of keeping entries until a reload.
        gcTime: QUERY_GC_TIME,
        // Bound transient failures to two retries. Definitive rejections and
        // cancelled reads finish immediately instead of repeating slow calls.
        retry: retryQuery,
      },
      mutations: {
        retry: 0,
      },
    },
  })

  for (const queryKey of REFERENCE_QUERY_KEYS) {
    queryClient.setQueryDefaults(queryKey, { staleTime: REFERENCE_STALE_TIME })
  }

  return queryClient
}

// Devtools live in their own lazily loaded chunk and are compiled out of the
// production bundle: the whole expression is dead code when NODE_ENV is not
// "development", so no import edge reaches the devtools package in prod.
const ReactQueryDevtools =
  process.env.NODE_ENV === 'development'
    ? dynamic(
        () =>
          import('@tanstack/react-query-devtools').then((mod) => ({
            default: mod.ReactQueryDevtools,
          })),
        { ssr: false },
      )
    : null

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession()
  // This boundary also exists on sign-in and after leaving the diary page.
  // Cleanup must follow authentication, rather than labels of logout buttons.
  useEffect(() => {
    reconcileMyDaySessionDrafts(session?.user?.id, status)
  }, [session?.user?.id, status])
  // All query keys live inside this identity boundary, including older consumers
  // whose keys contain only a project ID. Ordinary session refreshes retain it.
  const actorId = status === 'unauthenticated' ? undefined : session?.user?.id
  const scope = JSON.stringify([actorId ?? null, actorId ? session?.user?.globalRole ?? null : null])
  return <IdentityQueryProvider key={scope}>{children}</IdentityQueryProvider>
}

function IdentityQueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient)
  useEffect(() => () => {
    void queryClient.cancelQueries()
    queryClient.clear()
  }, [queryClient])

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {ReactQueryDevtools ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </QueryClientProvider>
  )
}
