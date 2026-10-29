import { apiError } from "@/lib/api-response";

/** Local recovery is retired; never inspect submitted credentials or tokens. */
export async function POST(request: Request) {
  void request;
  return apiError(
    "RECOVERY_MANAGED_BY_SSO",
    "Восстановление доступа выполняется через корпоративный SSO.",
    undefined,
    410,
  );
}
