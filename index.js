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

const required = { BRAVE_API_KEY, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY };
for (const k of Object.keys(required)) {
  if (!required[k]) throw new Error(`Missing env var: ${k}`);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const QUERIES = [
  "trading cards hobby news",
  "sports cards grading PSA Beckett SGC",
  "pokemon tcg market news",
  "one piece tcg market news",
  "Whatnot trading cards news"
];

async function braveSearch(q) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", q);
  url.searchParams.set("count", "10");

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", "X-Subscription-Token": BRAVE_API_KEY }
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

async function extract(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; HobbyHeadlinesBot/1.0)" }
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status}`);

  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const art = reader.parse();

  return {
    title: (art?.title || "").trim(),
    text: (art?.textContent || "").trim()
  };
}

async function summarize(title, text) {
  const clip = "";


  const prompt = `Return STRICT JSON with keys summary,snippet,tags.
summary: 1-2 neutral sentences.
snippet: 8-15 words.
tags: 3-6 tags.

Title: ${title}

Article:
${clip}`;

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
    return { summary: raw.slice(0, 600), snippet: "", tags: [] };
  }
}

async function insert(row) {
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

  if (res.status === 409) return false;
  if (!res.ok) throw new Error(await res.text());
  return true;
}

async function main() {
  let items = [];
  for (const q of QUERIES) items.push(...(await braveSearch(q)));

  const seen = new Set();
  items = items.filter(x => x?.url && !seen.has(x.url) && seen.add(x.url));

  let inserted = 0;
  for (const it of items.slice(0, 25)) {
    try {
      const { title, text } = await extract(it.url);
      if (!text || text.length < 400) continue;

      const ai = await summarize(title || it.title || it.url, text);

      const ok = await insert({
        url: it.url,
        title: (title || it.title || it.url).slice(0, 200),
        source: it.source,
        summary: ai.summary,
        snippet: ai.snippet,
        tags: ai.tags
      });

      if (ok) inserted++;
    } catch (e) {
      console.log("Skip:", it.url, e?.message || e);
    }
  }

  console.log(`Inserted ${inserted} articles`);
}

main().catch(e => {
  console.error("FATAL:", e?.message || e);
  process.exit(1);
});
