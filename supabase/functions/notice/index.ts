// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import Parser from "rss-parser";
import {Telegraf} from "telegraf";
import axios from "axios";

// 필요한 타입 정의
type Category = {
	name: string;
	url: string;
}

type Notice = {
	category_id: number;
	notice_id: number;
	title: string;
	summary: string;
	link: string;
	date: string;
	author: string;
}

// RSS 파서 객체 (전역 인스턴스)
const parser = new Parser();

// 유틸 함수 - 마크다운 제거
function escapeMarkdown(text: string): string {
  return text.replace(/[_*#`\[\]]/g, "\\$&");
}

// 유틸 함수 - RSS 파싱
const parseRSS = async (url: string) => {
    const response = await axios.get(url);
    let rawData = response.data;
    const fixedData = rawData.replace(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g, "&amp;");

    try {
        const feed = await parser.parseString(fixedData);
        // pubDate 기준 최신순(시간 역순) 정렬
        feed.items.sort((a, b) => {
          const aTime = Date.parse(a.pubDate ?? "") || 0;
          const bTime = Date.parse(b.pubDate ?? "") || 0;
          return bTime - aTime;
        });
        return feed;
    } 
    catch (err: any) {
        console.error(err);
        return null;
    }
}

// 카테고리 별 이름, URL 정의
const categories: {[key: number]: Category} = {
	79: {
		name: '학사 공지', 
		url: 'https://www.yeonsung.ac.kr/bbs/ko/79/rssList.do?row=10'
	},
	78: {
		name: '일반 공지', 
		url: 'https://www.yeonsung.ac.kr/bbs/ko/78/rssList.do?row=10'
	},
	77: {
		name: '장학/대출 공지', 
		url: 'https://www.yeonsung.ac.kr/bbs/ko/77/rssList.do?row=10'
	}
}

// Supabase Cron으로 주기적으로 돌릴 RSS 파싱 밎 새 공지 전송 API
export default {
	fetch: withSupabase({ auth: ["secret"] }, async (req, ctx) => {
		// 텔레그램 봇 객체
		const bot = new Telegraf(Deno.env.get(TELEGRAM_BOT_TOKEN) as string);

		// 구독자 목록 가져오기
		const { data: chatIdsData } = await ctx.supabaseAdmin.from('subscription').select('chat_id');
		const chatIds = chatIdsData || [];

		// 로깅을 위한 처리 결과 데이터
		let message_count = 0
		let send_count = 0
		let reject_count = 0

		try {

			// 카테고리별로 순회하며 각 피드 가져오기
			for (const [key, category] of Object.entries(categories)) {
				// RSS 파싱
				const feeds = await parseRSS(category.url);
				if (!feeds) continue;
				// 파싱된 후 각 피드 객체들을 순회
				for (const feed of feeds.items) {
					// 게시글 ID 추출
					const match = feed.link?.match(/\/(\d+)\/artclView\.do/);
					if (!match || !match[1]) {
						console.error(`${key}: notice id 추출 실패. url: ${feed.link}`);
						continue;
					}
					const nid = match[1];
	
	  
					// 테이블에서 추출한 nid를 조회. 조회 결과가 있으면 이미 존재하는 공지사항
					const { data } = await ctx.supabaseAdmin
						.from('notice')
						.select('notice_id')
						.eq('category_id', key)
						.eq('notice_id', nid)
						.maybeSingle(); // 해당 항목이 없으면 null 반환
					
					// 이미 존재하는 공지사항이면 스킵
					if (data) {
						continue;
					}
					// 새로운 공지사항이면 데이터 구조화 후 DB 저장 및 메세지 전송
					else {
						const newNotice: Notice = {
							notice_id: Number(nid),
							category_id: Number(key),
							title: feed.title || '제목없음',
							summary: feed.contentSnippet?.slice(0, 250) || '',
							link: `https://www.yeonsung.ac.kr${feed.link}`,
							date: feed.pubDate || '',
							author: feed.author || ''
						}
						// 테이블에 삽입
						const { error } = await ctx.supabaseAdmin
							.from('notice')
							.insert(newNotice);
	
						if (error) {
							console.error(error);
							continue;
						}
	
						// 새 공지 알림 전송
						if (chatIds.length > 0) {
							const message = 
								`*[📢${category.name}]${escapeMarkdown(newNotice.title)}*\n\n` +
								`*담당자*: ${escapeMarkdown(newNotice.author)}\n` +
								`*날짜*: ${newNotice.date}\n\n` +
								`${escapeMarkdown(newNotice.summary)}\n\n` +
								`${newNotice.link}`;
							
							// 모든 사용자에게 메시지 전송 (병렬 처리 및 에러 무시)
							const results = await Promise.allSettled(
								chatIds.map(id => bot.telegram.sendMessage(id.chat_id, message, {parse_mode: 'Markdown'}))
							);
							
							// 새 공지 매세지 수
							message_count += 1
						
							// 전송 실패 로그
							results.forEach((r) => {
								if (r.status === "rejected") {
									console.error(r.reason);
									// 실패 횟수
									reject_count += 1
								}
								else {
									// 전송 횟수
									send_count += 1
								}
							});
						}
					}
				}
			}
		}
		catch (err: any) {
			return Response.json({
				message: `처리 실패: ${err}!`,
			});
		}

		return Response.json({
			message: '처리 성공',
			new: message_count,
			sended: send_count,
			rejected: reject_count
		});
	}),
};
