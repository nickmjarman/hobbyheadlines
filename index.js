import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import OpenAI from "openai";

const {
  BRAVE_API_KEY,
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

for (const [k, v] of Object.entries({
  BRAVE_API_KEY,
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
})) {
  if (!v) throw new Error(`Missing required env var: ${k}`);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const QUERIES = [
  "trading cards hobby news",
  "sports cards grading PSA Beckett SGC",
  "pokemon tcg market news",
  "one piece tcg cards market",
  "card breaking whatnot hobby"
];

async function braveSearch(query) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": BRAVE_API_KEY
    }
  });

  if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);

  const json = await res.json();
  const results = json?.web?.results ?? [];

  return results.map(r => ({
    url: r.url,
    title: r.title,
    source: new URL(r.url).hostname
  }));
}

async function fetchAndExtract(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; HobbyHeadlinesBot/1.0)"
    }
  });

  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);

  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  return {
    title: (article?.title || "").trim(),
    text: (article?.textContent || "").trim()
  };
}

async function summarize(title, text) {
  const clipped = text.slice(0, 9000);

  const prompt = `
Return STRICT JSON with keys: summary, snippet, tags.

summary: 1–2 neutral sentences.
snippet: 8–15 words (not a quote).
tags: 3–6 short tags.

Title: ${title}

Article:
${clipped}
`.trim();

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }]
  });

  const raw = resp?.choices?.[0]?.message?.content ?? "{}";

  try {
    const data = JSON.parse(raw);
    return {
      summary: String(data.summary || "").slice(0, 600),
      snippet: String(data.snippet || "").slice(0, 140),
      tags: Array.isArray(data.tags) ? data.tags.slice(0, 8) : []
    };
  } catch {
    return {
      summary: raw.slice(0, 600),
      snippet: "",
      tags: []
    };
  }
}

async function insertArticle(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/articles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "return=minimal"
    },
    body: JSON.stringify(row)
  });

  if (res.status === 409) return false; // duplicate url
  if (!res.ok) throw new Error(await res.text());
  return true;
}

async function run() {
  let candidates = [];

  for (const q of QUERIES) {
    const r = await braveSearch(q);
    candidates.push(...r);
  }

  // de-dupe by URL
  const seen = new Set();
  candidates = candidates.filter(c => {
    if (!c?.url || seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });

  let inserted = 0;

  for (const c of candidates.slice(0, 25)) {
    try {
      const { title, text } = await fetchAndExtract(c.url);
      if (!text || text.length < 400) continue;

      const ai = await summarize(title || c.title || c.url, text);

      const ok = await insertArticle({
        url: c.url,
        title: (title || c.title || c.url).slice(0, 200),
        source: c.source,
        summary: ai.summary,
        snippet: ai.snippet,
        tags: ai.tags
      });

      if (ok) inserted++;
    } catch (e) {
      console.log("Skip:", c.url, e?.message || e);
    }
  }

  console.log(`Inserted ${inserted} articles`);
}

run().catch(e => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});

