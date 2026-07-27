/** category_id로 연성대 공지 RSS URL을 조립합니다. */
export function buildCategoryRssUrl(categoryId: number): string {
  return `https://www.yeonsung.ac.kr/bbs/ko/${categoryId}/rssList.do?row=10`;
}
