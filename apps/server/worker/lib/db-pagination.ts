const DB_PAGE_SIZE = 100

export async function readAllById<T extends { id: string }>(
  readPage: (cursor: string | null, limit: number) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = []
  let cursor: string | null = null
  while (true) {
    const page = await readPage(cursor, DB_PAGE_SIZE)
    rows.push(...page)
    if (page.length < DB_PAGE_SIZE) return rows
    const last = page[page.length - 1]
    if (!last || last.id === cursor) return rows
    cursor = last.id
  }
}
