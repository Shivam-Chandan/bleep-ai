import 'server-only';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const DDG_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export const SEARCH_MAX_RESULTS = Math.max(
  1,
  Math.min(10, Number(process.env.SEARCH_MAX_RESULTS) || 5)
);

function decodeDdgHref(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') || href;
  } catch {
    return href;
  }
}

export function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split('result results_links results_links_deep web-result');
  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const hrefMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);
    if (!titleMatch || !hrefMatch) continue;
    const title = titleMatch[1].replace(/<[^>]+>/g, '').trim();
    const snippet = (snippetMatch ? snippetMatch[1] : '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) continue;
    results.push({ title, url: decodeDdgHref(hrefMatch[1]), snippet });
  }
  return results;
}

export async function searchWeb(query: string, max = SEARCH_MAX_RESULTS): Promise<SearchResult[]> {
  const clean = query.replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  if (!clean) return [];

  const url = new URL(DDG_HTML_URL);
  url.searchParams.set('q', clean);

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': DDG_USER_AGENT },
    // The free search is best-effort: don't let upstream delays stall the model.
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed: ${response.status}`);
  }
  return parseResults(await response.text()).slice(0, max);
}

export function formatSearchContext(results: SearchResult[]): string {
  if (results.length === 0) return 'No web results were found for this query.';
  const lines = results.map(
    (r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet || '(no snippet)'}`
  );
  return (
    'Up-to-date web search results about the user\'s question. Use them to ground your answer ' +
    'and cite relevant sources inline as [1], [2], etc. (the corresponding URLs follow). ' +
    "If the results are insufficient, say so.\n\n" +
    lines.join('\n\n')
  );
}