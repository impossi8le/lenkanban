"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/** The server has already authorized this exact destination. Navigate after commit. */
export function AuthorizedDepartmentRedirect({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => { router.replace(href); }, [href, router]);
  return <section className="p-6" aria-label="Переход в отдел">
    <p role="status">Открываем доску отдела…</p>
    <Link href={href} prefetch={false} className="mt-3 inline-flex min-h-11 items-center underline">Открыть доску</Link>
  </section>;
}
