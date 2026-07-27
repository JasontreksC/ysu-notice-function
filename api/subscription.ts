import { Telegraf } from "telegraf";
import type { Update } from "telegraf/types";
import { isAuthorized } from "../lib/auth";
import { getSql } from "../lib/db";

export const config = {
  maxDuration: 30,
};

/**
 * 텔레그램 봇 웹훅 — /start 시 subscription 테이블에 chat_id를 저장합니다.
 * 웹훅 URL 예: https://<project>.vercel.app/api/subscription?secret=$FUNCTION_SECRET
 */
export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return new Response("not allowed", { status: 405 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return new Response("misconfigured", { status: 500 });
  }

  try {
    const sql = getSql();
    const bot = new Telegraf(token);

    bot.start(async (tgCtx) => {
      const chatId = tgCtx.chat.id;

      try {
        await sql`
          INSERT INTO subscription (chat_id, joined_at)
          VALUES (${chatId}, now())
          ON CONFLICT (chat_id) DO UPDATE SET joined_at = EXCLUDED.joined_at
        `;
      } catch (err) {
        console.error("Error saving chat ID:", err);
        await tgCtx.reply(
          "구독 등록 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.",
        );
        return;
      }

      await tgCtx.reply("반갑습니다! 새로운 공지가 올라오면 알려드리겠습니다.");
    });

    const update = (await request.json()) as Update;
    await bot.handleUpdate(update);
    return new Response("ok");
  } catch (err) {
    console.error("Error handling update:", err);
    return new Response("Internal Server Error", { status: 500 });
  }
}
