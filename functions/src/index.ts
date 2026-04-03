import {setGlobalOptions} from "firebase-functions";
import {onRequest} from "firebase-functions/https";
import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import {getFirestore} from "firebase-admin/firestore";
import Parser from "rss-parser";
import {Telegraf} from "telegraf";
import axios from "axios";

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

type FeedItem = {
  item: any;
  link: string;
};

/**
 * DB에 저장할 공지사항 데이터 형식
 */
type Notice = {
  category: string;
  title: string;
  link: string;
  date: string;
  author: string;
  contentSnippet: string;
};

// 구독자 목록 가져오기 및 텔레그램 봇 초기화
const db = getFirestore(admin.app(), "ysu-notice-db");
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN as string);
let chatIds: any;
db.collection("users").get().then((snap) => {
    chatIds = snap.docs.map((doc) => doc.data().chatId);
});

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
  try {
    // 1. RSS 피드 데이터 가져오기

    const campus_feed = await parseRSS(CAMPUS_RSS_URL);
    const general_feed = await parseRSS(GENERAL_RSS_URL);
    const scholar_feed = await parseRSS(SCHOLAR_RSS_URL);

    // RSS 파싱 실패 시 오류 발생 및 함수 종료
    if (!campus_feed || !general_feed || !scholar_feed) {
        throw new Error("Failed to parse RSS feeds.");
    }

    // RSS 파싱 성공
    logger.info(`Fetched ${campus_feed.items.length} items from CAMPUS_RSS.`);
    logger.info(`Fetched ${general_feed.items.length} items from GENERAL_RSS.`);
    logger.info(`Fetched ${scholar_feed.items.length} items from SCHOLAR_RSS.`);

    const campusFeedItems: FeedItem[] = [];
    const generalFeedItems: FeedItem[] = [];
    const scholarFeedItems: FeedItem[] = [];

    const campusDocRefs: admin.firestore.DocumentReference[] = [];
    const generalDocRefs: admin.firestore.DocumentReference[] = [];
    const scholarDocRefs: admin.firestore.DocumentReference[] = [];

    // 2-1. CAMPUS RSS 아이템 분석 및 Firestore 문서 참조 생성
    for (const item of campus_feed.items) {
      const link = item.link;
      if (!link) continue;

      // 링크에서 게시물 고유 ID 추출 (예: .../238893/artclView.do -> 238893)
      const match = link.match(/\/(\d+)\/artclView\.do/);
      if (match && match[1]) {
        const docId = match[1];
        const docRef = db.collection("notices_campus").doc(docId);

        campusFeedItems.push({item, link});
        campusDocRefs.push(docRef);
      }
    }

    // 2-2. GENERAL RSS 아이템 분석 및 Firestore 문서 참조 생성
    for (const item of general_feed.items) {
      const link = item.link;
      if (!link) continue;

      // 링크에서 게시물 고유 ID 추출 (예: .../238893/artclView.do -> 238893)
      const match = link.match(/\/(\d+)\/artclView\.do/);
      if (match && match[1]) {
        const docId = match[1];
        const docRef = db.collection("notices_general").doc(docId);

        generalFeedItems.push({item, link});
        generalDocRefs.push(docRef);
      }
    }

    // 2-3. SCHOLAR RSS 아이템 분석 및 Firestore 문서 참조 생성
    for (const item of scholar_feed.items) {
      const link = item.link;
      if (!link) continue;

      // 링크에서 게시물 고유 ID 추출 (예: .../238893/artclView.do -> 238893)
      const match = link.match(/\/(\d+)\/artclView\.do/);
      if (match && match[1]) {
        const docId = match[1];
        const docRef = db.collection("notices_scholar").doc(docId);

        scholarFeedItems.push({item, link});
        scholarDocRefs.push(docRef);
      }
    }

    // 3. Firestore에 이미 존재하는 문서인지 병렬로 확인
    const batch = db.batch();

    const campus_snapshots = await Promise.all(campusDocRefs.map((ref) => ref.get()));
    const general_snapshots = await Promise.all(generalDocRefs.map((ref) => ref.get()));
    const scholar_snapshots = await Promise.all(scholarDocRefs.map((ref) => ref.get()));

    // 알림을 보낼 새 공지사항 목록
    const newCampusNotices: Notice[] = [];
    const newGeneralNotices: Notice[] = [];
    const newScholarNotices: Notice[] = [];

    // 4-1. 존재하지 않는(새로운) 학과 공지사항만 Batch에 추가
    campus_snapshots.forEach((snap, index) => {
      if (!snap.exists) {
        const {item, link} = campusFeedItems[index];
        const docRef = campusDocRefs[index];

        const newNotice = {
          category: "학사 공지",
          title: item.title || "제목없음",
          link: `https://www.yeonsung.ac.kr${link}`,
          date: item.pubDate || "",
          author: item.author || "",
          contentSnippet: item.contentSnippet?.slice(0, 250) || "",
          fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        batch.set(docRef, newNotice);
        newCampusNotices.push(newNotice);
      }
    });

    // 4-2. 존재하지 않는(새로운) 일반 공지사항만 Batch에 추가
    general_snapshots.forEach((snap, index) => {
      if (!snap.exists) {
        const {item, link} = generalFeedItems[index];
        const docRef = generalDocRefs[index];

        const newNotice = {
          category: "일반 공지",
          title: item.title || "제목없음",
          link: `https://www.yeonsung.ac.kr${link}`,
          date: item.pubDate || "",
          author: item.author || "",
          contentSnippet: item.contentSnippet?.slice(0, 250) || "",
          fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        batch.set(docRef, newNotice);
        newGeneralNotices.push(newNotice);
      }
    });

    // 4-3. 존재하지 않는(새로운) 장학 공지사항만 Batch에 추가
    scholar_snapshots.forEach((snap, index) => {
      if (!snap.exists) {
        const {item, link} = scholarFeedItems[index];
        const docRef = scholarDocRefs[index];

        const newNotice = {
          category: "장학/대출 공지",
          title: item.title || "제목없음",
          link: `https://www.yeonsung.ac.kr${link}`,
          date: item.pubDate || "",
          author: item.author || "",
          contentSnippet: item.contentSnippet?.slice(0, 250) || "",
          fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
        };

        batch.set(docRef, newNotice);
        newScholarNotices.push(newNotice);
      }
    });

    // DB에 저장
    await batch.commit();

    // 5. 새 공지사항이 있을 경우 저장 및 알림 전송
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      logger.error("잘못된 토큰");
      return;
    }

    if (!chatIds.length) {
      logger.warn("구독자가 없음");
      return;
    }
    
    // 모든 새로운 공지 알림 전송
    for (const notice of [
      ...newCampusNotices.reverse(),
      ...newGeneralNotices.reverse(),
      ...newScholarNotices.reverse()]
    ) {
      const message = `*[📢${notice.category}]${escapeMarkdown(notice.title)}*\n\n` +
      `*담당자*: ${escapeMarkdown(notice.author)}\n` +
      `*날짜*: ${notice.date}\n\n` +
      `${escapeMarkdown(notice.contentSnippet)}\n\n` +
      `${notice.link}`;
  
      // 모든 사용자에게 메시지 전송 (병렬 처리 및 에러 무시)
      const results = await Promise.allSettled(
        chatIds.map((id: string) =>
          bot.telegram.sendMessage(id, message, {parse_mode: "Markdown"})
        )
      );
  
      // 전송 실패 로그
      results.filter((r) => {
        if (r.status === "rejected") {
          logger.error(r.reason);
        }
      });
    }
  } catch (error) {
    logger.error("Error fetching RSS feed:", error);
  }
});

/**
 * 텔레그램 봇의 웹훅 요청을 처리하는 HTTP 함수
 */
export const telegramWebhook = onRequest(async (request, response) => {

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.error("TELEGRAM_BOT_TOKEN is not defined");
    response.sendStatus(500);
    return;
  }

  const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

  // 사용자가 /start 명령을 보냈을 때 처리
  bot.start(async (ctx) => {
    const chatId = ctx.chat.id;
    try {
      // 사용자 정보를 'users' 컬렉션에 저장 (구독 처리)
      await db.collection("users").doc(chatId.toString()).set({
        chatId: chatId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});

      ctx.reply("반갑습니다! 새로운 공지가 올라오면 알려드리겠습니다.");
    } catch (error) {
      logger.error("Error saving chat ID:", error);
    }
  });

  // 텔레그램에서 온 업데이트 데이터를 봇 엔진에 전달
  try {
    await bot.handleUpdate(request.body, response);
  } catch (error) {
    logger.error("Error handling Telegram update", error);
    if (!response.headersSent) {
      response.sendStatus(500);
    }
  }
});
