import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import Parser from "rss-parser";
import {Telegraf} from "telegraf";
import axios from "axios";

// supabase
import { createClient } from "@supabase/supabase-js";

// Firebase Admin SDK 초기화
admin.initializeApp();

// 전역 설정: 함수당 최대 인스턴스 수를 제한하여 비용 및 트래픽 급증 관리
setGlobalOptions({maxInstances: 10});

const parser = new Parser();
const CAMPUS_RSS_URL = "https://www.yeonsung.ac.kr/bbs/ko/79/rssList.do?row=10";
const GENERAL_RSS_URL = "https://www.yeonsung.ac.kr/bbs/ko/78/rssList.do?row=10";
const SCHOLAR_RSS_URL = "https://www.yeonsung.ac.kr/bbs/ko/77/rssList.do?row=10";


/**
 * Escapes special characters for Telegram Markdown.
 * @param {string} text The text to escape.
 * @return {string} The escaped text.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*#`]/g, "\\$&");
}

/**
 * 정기적으로 실행되어 연성대학교 RSS 피드를 가져오고,
 * 새로운 공지사항이 있으면 Firestore에 저장하고 텔레그램 알림을 보냅니다.
 * (한국 시간 기준 매 30분마다 실행)
 */

const categories: {[key: number]: string} = {
  79: '학사 공지',
  78: '일반 공지',
  77: '장학/대출 공지'
}

// RSS 파싱 함수
const parseRSS = async (url: string) => {
    const response = await axios.get(url);
    let rawData = response.data;
    const fixedData = rawData.replace(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g, "&amp;");

    try {
        const feed = await parser.parseString(fixedData);
        return feed;
    } 
    catch (err: any) {
        logger.error(err);
        return null;
    }
}

// 메인 함수
export const scheduledFunction = onSchedule({
  schedule: "*/30 * * * *",
  timeZone: "Asia/Seoul",
}, async () => {
  const supabase = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string);
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);

  try {
    // 구독자 목록을 루프 밖에서 한 번만 조회
    const { data: chatIdsData } = await supabase.from('subscription').select('chat_id');
    const chatIds = chatIdsData || [];

    // 1. RSS 피드 데이터 가져오기
    const [campus, general, scholar] = await Promise.all([
      parseRSS(CAMPUS_RSS_URL),
      parseRSS(GENERAL_RSS_URL),
      parseRSS(SCHOLAR_RSS_URL)
    ]);

    const feeds: {[key: number]: any} = {
      79: campus,
      78: general,
      77: scholar
    };

    for (const [key, value] of Object.entries(feeds)) {
      const cid = Number(key);
      if (!value) continue;

      for (const feed of value.items) {
        const match = feed.link?.match(/\/(\d+)\/artclView\.do/);
        if (!match || !match[1]) {
          logger.error(`${cid}: notice id 추출 실패. url: ${feed.link}`);
          continue;
        }
        const nid = match[1];
  
        const { data } = await supabase
          .from('notice')
          .select('notice_id')
          .eq('category_id', cid)
          .eq('notice_id', nid)
          .maybeSingle(); // 해당 항목이 없으면 null 반환
        
        if (data) { // 이미 존재하는 공지사항이면 스킵
          continue;
        }
        else {
  
          const newNotice = {
            notice_id: nid,
            category_id: cid,
            title: feed.title || '제목없음',
            summary: feed.contentSnippet?.slice(0, 250) || '',
            link: `https://www.yeonsung.ac.kr${feed.link}`,
            date: feed.pubDate || '',
            author: feed.author || ''
          }
  
          const { error } = await supabase
          .from('notice')
          .insert(newNotice);
  
          if (error) {
            logger.error(error);
            continue;
          }
        
          // 새로운 공지 알림 전송
          if (chatIds.length > 0) {
            const message = `*[📢${categories[cid]}]${escapeMarkdown(newNotice.title)}*\n\n` +
            `*담당자*: ${escapeMarkdown(newNotice.author)}\n` +
            `*날짜*: ${newNotice.date}\n\n` +
            `${escapeMarkdown(newNotice.summary)}\n\n` +
            `${newNotice.link}`;
        
            // 모든 사용자에게 메시지 전송 (병렬 처리 및 에러 무시)
            const results = await Promise.allSettled(
              chatIds.map(id => bot.telegram.sendMessage(id.chat_id, message, {parse_mode: 'Markdown'}))
            );
        
            // 전송 실패 로그
            results.forEach((r) => {
              if (r.status === "rejected") {
                logger.error(r.reason);
              }
            });
          }
        }
      }
    }
  } catch (error) {
    logger.error("Error fetching RSS feed:", error);
  }
});

/**
 * 텔레그램 봇의 웹훅 요청을 처리하는 HTTP 함수
 */
export const telegramWebhook = onRequest(async (request, response) => {
  const supabase = createClient(process.env.SUPABASE_URL as string, process.env.SUPABASE_SERVICE_ROLE_KEY as string);
  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);

  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    try {
      logger.log("Saving chat ID:", chatId);
      const { error } = await supabase.from('subscription').upsert({chat_id: chatId});
      if (error) logger.error(error);
      await ctx.reply("반갑습니다! 새로운 공지가 올라오면 알려드리겠습니다.");
    } catch (error) {
      logger.error("Error saving chat ID:", error);
    }
  });

  const handler = bot.webhookCallback('/'); 
  try {
    await handler(request, response);
  } catch (error) {
    logger.error("Error handling update:", error)
    if (!response.headersSent) {
      response.sendStatus(500);
    }
  }
});
