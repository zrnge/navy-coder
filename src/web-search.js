// ── Web search backends ───────────────────────────────────────────────────────
// Tavily and Brave when a key is configured, DuckDuckGo otherwise so the tool
// works with no key at all.
//
// Extracted from extension.js unchanged. These are still methods on
// NavyCoderViewProvider — mixed into its prototype at the bottom of
// extension.js — so `this` means what it always did and no call site, no
// signature and no behaviour changed. Written as a class so the block could
// move verbatim; see mixinPrototype in extension.js for how it is applied.

const vscode = require('vscode');
const http = require('http');
const https = require('https');

class WebSearchMethods {
  async toolWebSearch(query, maxResults = 5) {
    const config = vscode.workspace.getConfiguration('navy');
    const searchKey = config.get('searchApiKey', '')
                    || await this.context.secrets.get('navy.searchApiKey') || '';
    if (searchKey.startsWith('tvly-')) return await this._searchTavily(query, maxResults, searchKey);
    if (searchKey) return await this._searchBrave(query, maxResults, searchKey);
    return await this._searchDuckDuckGo(query, maxResults);
  }

  async _searchTavily(query, maxResults, apiKey) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: apiKey, query, max_results: Math.min(maxResults, 10) }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const results = (data.results || []).slice(0, maxResults);
      if (!results.length) return 'No results found for: ' + query;
      return results.map((r, i) =>
        `[${i + 1}] **${r.title}**\n${r.url}\n${(r.content || '').slice(0, 400)}`
      ).join('\n\n---\n\n');
    } catch (e) {
      return 'Tavily search failed (' + e.message + ') — falling back to DuckDuckGo.\n\n'
           + await this._searchDuckDuckGo(query, maxResults);
    }
  }

  async _searchBrave(query, maxResults, apiKey) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(
        'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + Math.min(maxResults, 20),
        { headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey }, signal: ctrl.signal }
      );
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const results = (data.web?.results || []).slice(0, maxResults);
      if (!results.length) return 'No results found for: ' + query;
      return results.map((r, i) =>
        `[${i + 1}] **${r.title}**\n${r.url}\n${r.description || ''}`
      ).join('\n\n---\n\n');
    } catch (e) {
      return 'Brave search failed (' + e.message + ') — falling back to DuckDuckGo.\n\n'
           + await this._searchDuckDuckGo(query, maxResults);
    }
  }

  async _searchDuckDuckGo(query, maxResults) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      // DDG Lite has simpler, more stable HTML than the full search page.
      const res = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; NavyCoder/1.0)',
        },
        body: 'q=' + encodeURIComponent(query),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const html = await res.text();
      const links = [];
      const snips = [];
      let m;
      // Tolerate attribute order and quote-style changes: match whole anchors that
      // carry the result-link class, then pull href out separately.
      const anchorRe = /<a\b[^>]*class=["']?[^"'>]*result-link[^"'>]*["']?[^>]*>([\s\S]*?)<\/a>/gi;
      while ((m = anchorRe.exec(html)) !== null) {
        const href = m[0].match(/href=["']([^"']+)["']/i);
        if (href) links.push({ url: href[1], title: m[1].replace(/<[^>]*>/g, '').trim() });
      }
      const snipRe = /<td\b[^>]*class=["']?[^"'>]*result-snippet[^"'>]*["']?[^>]*>([\s\S]*?)<\/td>/gi;
      while ((m = snipRe.exec(html)) !== null) snips.push(m[1].replace(/<[^>]*>/g, '').trim());
      const results = [];
      for (let i = 0; i < Math.min(links.length, maxResults); i++) {
        if (links[i].url.startsWith('http') && links[i].title)
          results.push({ ...links[i], snippet: snips[i] || '' });
      }
      if (!results.length) return 'No results found for: ' + query;
      return results.map((r, i) => `[${i + 1}] **${r.title}**\n${r.url}\n${r.snippet}`).join('\n\n---\n\n');
    } catch (e) {
      return 'Search failed: ' + e.message;
    }
  }
}

module.exports = {
  WEB_SEARCH_METHODS: WebSearchMethods.prototype,
};
