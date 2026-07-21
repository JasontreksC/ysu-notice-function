// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { Telegraf } from "telegraf";

// 텔레그램 봇 /start 웹훅 — subscription 테이블에 chat_id, joined_at 저장
// Telegram은 Supabase 자격 증명을 보내지 않으므로 auth: 'none' + FUNCTION_SECRET 쿼리로 보호
export default {
  fetch: withSupabase({ auth: "none" }, async (req, ctx) => {
    try {
      const url = new URL(req.url);
      if (url.searchParams.get("secret") !== Deno.env.get("FUNCTION_SECRET")) {
        return new Response("not allowed", { status: 405 });
      }

      if (req.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }

      const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
      if (!token) {
        console.error("TELEGRAM_BOT_TOKEN is not set");
        return new Response("misconfigured", { status: 500 });
      }

      const bot = new Telegraf(token);

      bot.start(async (tgCtx) => {
        const chatId = tgCtx.chat.id;
        const { error } = await ctx.supabaseAdmin.from("subscription").upsert({
          chat_id: chatId,
          joined_at: new Date().toISOString(),
        });

        if (error) {
          console.error("Error saving chat ID:", error);
          await tgCtx.reply("구독 등록 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
          return;
        }

        await tgCtx.reply("반갑습니다! 새로운 공지가 올라오면 알려드리겠습니다.");
      });

      const update = await req.json();
      await bot.handleUpdate(update);
      return new Response("ok");
    } catch (err) {
      console.error("Error handling update:", err);
      return new Response("Internal Server Error", { status: 500 });
    }
  }),
};
