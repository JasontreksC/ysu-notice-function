/**
 * FUNCTION_SECRET으로 요청 인증.
 * - Authorization: Bearer <secret>
 * - ?secret=<secret>
 * - X-Telegram-Bot-Api-Secret-Token: <secret> (setWebhook secret_token)
 */
export function isAuthorized(request: Request): boolean {
  const secret = process.env.FUNCTION_SECRET;
  if (!secret) return false;

  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return true;

  const telegramSecret = request.headers.get(
    "x-telegram-bot-api-secret-token",
  );
  if (telegramSecret === secret) return true;

  const url = new URL(request.url);
  if (url.searchParams.get("secret") === secret) return true;

  return false;
}
