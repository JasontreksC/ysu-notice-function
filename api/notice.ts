import { Telegraf } from "telegraf";
import { isAuthorized } from "../lib/auth";
import { buildCategoryRssUrl } from "../lib/categories";
import { getSql } from "../lib/db";
import {
  buildNoticeLink,
  escapeMarkdown,
  extractNoticeId,
  parseRSS,
} from "../lib/rss";

export const config = {
  maxDuration: 60,
};

/**
 * RSS를 파싱해 신규 공지를 Neon에 저장하고, 구독자에게 텔레그램으로 전송합니다.
 * Authorization: Bearer $FUNCTION_SECRET 또는 ?secret= 으로 호출합니다.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set");
    return Response.json({ message: "misconfigured" }, { status: 500 });
  }

  const sql = getSql();
  const bot = new Telegraf(token);

  const categories = (await sql`
    SELECT category_id, name FROM category ORDER BY category_id DESC
  `) as { category_id: number; name: string | null }[];

  const subscribers = (await sql`
    SELECT chat_id FROM subscription
  `) as { chat_id: string | number }[];
  const chatIds = subscribers.map((row) => Number(row.chat_id));

  let messageCount = 0;
  let sendCount = 0;
  let rejectCount = 0;

  try {
    for (const category of categories) {
      const categoryId = Number(category.category_id);
      const categoryName = category.name ?? String(categoryId);
      const rssUrl = buildCategoryRssUrl(categoryId);

      const feeds = await parseRSS(rssUrl);
      if (!feeds) continue;

      for (const feed of feeds.items) {
        const noticeId = extractNoticeId(feed.link);
        if (noticeId === null) {
          console.error(
            `${categoryId}: notice id 추출 실패. url: ${feed.link}`,
          );
          continue;
        }

        const existing = (await sql`
          SELECT notice_id FROM notice WHERE notice_id = ${noticeId} LIMIT 1
        `) as { notice_id: string | number }[];
        if (existing.length > 0) continue;

        const title = feed.title || "제목없음";
        const summary = feed.contentSnippet?.slice(0, 250) || "";
        const author = feed.creator || feed.author || "";
        const publishedAt = feed.pubDate ? new Date(feed.pubDate) : null;
        const link = buildNoticeLink(categoryId, noticeId);

        try {
          await sql`
            INSERT INTO notice (notice_id, title, summary, published_at, author)
            VALUES (
              ${noticeId},
              ${title},
              ${summary},
              ${publishedAt?.toISOString() ?? null},
              ${author}
            )
          `;
        } catch (err) {
          console.error("notice insert failed:", err);
          continue;
        }

        if (chatIds.length === 0) continue;

        const publishedLabel = publishedAt
          ? publishedAt.toISOString()
          : feed.pubDate || "";

        const message =
          `*[📢${categoryName}]${escapeMarkdown(title)}*\n\n` +
          `*담당자*: ${escapeMarkdown(author)}\n` +
          `*날짜*: ${publishedLabel}\n\n` +
          `${escapeMarkdown(summary)}\n\n` +
          `${link}`;

        const results = await Promise.allSettled(
          chatIds.map((chatId) =>
            bot.telegram.sendMessage(chatId, message, {
              parse_mode: "Markdown",
            }),
          ),
        );

        messageCount += 1;
        for (const result of results) {
          if (result.status === "rejected") {
            console.error(result.reason);
            rejectCount += 1;
          } else {
            sendCount += 1;
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
    return Response.json({ message: `처리 실패: ${err}` }, { status: 500 });
  }

  return Response.json({
    message: "처리 성공",
    new: messageCount,
    sended: sendCount,
    rejected: rejectCount,
  });
}
