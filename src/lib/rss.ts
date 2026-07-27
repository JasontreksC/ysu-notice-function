import Parser from "rss-parser";

const parser = new Parser();

export async function parseRSS(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`RSS fetch failed (${response.status}): ${url}`);
    return null;
  }

  const rawData = await response.text();
  // 잘못된 엔티티(& alone)를 교정해 XML 파싱이 깨지지 않게 함
  const fixedData = rawData.replace(/&(?!(amp|lt|gt|quot|apos|#\d+);)/g, "&amp;");

  try {
    const feed = await parser.parseString(fixedData);
    feed.items.sort((a, b) => {
      const aTime = Date.parse(a.pubDate ?? "") || 0;
      const bTime = Date.parse(b.pubDate ?? "") || 0;
      return bTime - aTime;
    });
    return feed;
  } catch (err) {
    console.error(err);
    return null;
  }
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[_*#`\[\]]/g, "\\$&");
}

export function extractNoticeId(link: string | undefined): number | null {
  const match = link?.match(/\/(\d+)\/artclView\.do/);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

/** https://www.yeonsung.ac.kr/bbs/ko/{category_id}/{notice_id}/artclView.do */
export function buildNoticeLink(categoryId: number, noticeId: number): string {
  return `https://www.yeonsung.ac.kr/bbs/ko/${categoryId}/${noticeId}/artclView.do`;
}
