// The search of the Work list, shared by the list and the counts so that the numbers beside the segments describe the rows.

/**
 * Title, the wanted result and the request, when they are words. Arguments an agent stored as JSON are machinery, not
 * something the reader wrote: "hi" must not find "passenger_relationship". `w` is the alias of the works table.
 */
export function workKeywordFilter(keyword: string): { sql: string; params: string[] } {
  const words = (column: string) =>
    `(COALESCE(${column}, '') NOT LIKE '{%' AND COALESCE(${column}, '') NOT LIKE '[%' AND COALESCE(${column}, '') LIKE ? ESCAPE '\\')`;
  const like = `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return {
    sql: `(w.title LIKE ? ESCAPE '\\' OR ${words("w.outcome_text")} OR ${words("w.request_text")})`,
    params: [like, like, like],
  };
}
