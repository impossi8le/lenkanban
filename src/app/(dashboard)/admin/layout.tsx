import * as React from "react";
import { notFound } from "next/navigation";

import { requireDbUser } from "@/lib/require-user";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireDbUser();

  // Hide /admin for non-admins.
  if (user.globalRole !== "ADMIN") {
    notFound();
  }

  return <>{children}</>;
}
