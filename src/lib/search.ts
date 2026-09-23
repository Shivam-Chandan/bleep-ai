import 'server-only';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

type SearchProvider = 'bing' | 'ddg';

const BING_URL = 'https://www.bing.com/search';
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';
const SEARCH_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export const SEARCH_MAX_RESULTS = Math.max(
  1,
  Math.min(10, Number(process.env.SEARCH_MAX_RESULTS) || 5)
);

function configuredProvider(): SearchProvider | 'auto' {
  const value = String(process.env.SEARCH_PROVIDER || 'auto').toLowerCase();
  return value === 'bing' || value === 'ddg' ? value : 'auto';
}

function decodeDdgHref(href: string): string {
  try {
    const url = new URL(href, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') || href;
  } catch {
    return href;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function decodeBingHref(href: string): string {
  if (!href.startsWith('https://www.bing.com/ck/')) return href;
  try {
    const url = new URL(decodeEntities(href));
    const encoded = url.searchParams.get('u');
    if (!encoded) return href;
    const decoded = Buffer.from(encoded.replace(/^a1/, ''), 'base64url').toString('utf8');
    return decoded && decoded.startsWith('http') ? decoded : href;
  } catch {
    return href;
  }
}

export function parseDdgResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split('result results_links results_links_deep web-result');
  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const hrefMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);
    if (!titleMatch || !hrefMatch) continue;
    const title = decodeEntities(titleMatch[1].replace(/<[^>]+>/g, '').trim());
    const snippet = decodeEntities(
      (snippetMatch ? snippetMatch[1] : '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
    if (!title) continue;
    results.push({ title, url: decodeDdgHref(hrefMatch[1]), snippet });
  }
  return results;
}

export function parseBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blocks = html.split('<li class="b_algo"');
  for (const block of blocks.slice(1)) {
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/);
    if (!titleMatch) continue;
    const title = decodeEntities(titleMatch[2].replace(/<[^>]+>/g, '').trim());
    if (!title) continue;
    const snippetMatch = block.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const snippet = decodeEntities(
      (snippetMatch ? snippetMatch[1] : '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
    results.push({ title, url: decodeBingHref(titleMatch[1]), snippet });
  }
  return results;
}

async function fetchHtml(url: URL): Promise<string> {
  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': SEARCH_USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    // The free search is best-effort: don't let upstream delays stall the model.
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`search failed: ${response.status}`);
  }
  return response.text();
}

async function bingSearch(query: string): Promise<SearchResult[]> {
  const url = new URL(BING_URL);
  url.searchParams.set('q', query);
  return parseBingResults(await fetchHtml(url));
}

async function ddgSearch(query: string): Promise<SearchResult[]> {
  const url = new URL(DDG_HTML_URL);
  url.searchParams.set('q', query);
  return parseDdgResults(await fetchHtml(url));
}

export async function searchWeb(query: string, max = SEARCH_MAX_RESULTS): Promise<SearchResult[]> {
  const clean = query.replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  if (!clean) return [];

  const mode = configuredProvider();
  const chain: SearchProvider[] = mode === 'auto' ? ['bing', 'ddg'] : [mode];

  for (const provider of chain) {
    const results = await (provider === 'bing' ? bingSearch : ddgSearch)(clean).catch(() => []);
    if (results.length > 0) return results.slice(0, max);
  }
  return [];
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