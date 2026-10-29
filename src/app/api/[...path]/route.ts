import { apiNotFound } from "@/lib/api-response";

export const dynamic = "force-dynamic";

// Unknown API paths use the same opaque error contract as known resources.
function notFound() {
  return apiNotFound();
}

export { notFound as GET, notFound as POST, notFound as PUT, notFound as PATCH, notFound as DELETE, notFound as OPTIONS };
