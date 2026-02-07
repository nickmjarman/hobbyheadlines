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

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Trading card search queries
const QUERIES = [
  "trading cards hobby news",
  "sports cards grading PSA Beckett SGC",
  "pokemon tcg market news",
  "one piece tcg cards market",
  "card breaking whatnot hobby"
];

// Search Brave
async function braveSearch(query) {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "10");

  const res = await fetch(url.toString(), {
    headers: {
      "Accept": "application/json",
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

// Fetch article + extract readable text
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
    title: article?.title || "",
    text: article?.textContent || ""
  };
}

// Ask OpenAI for summary + snippet
async function summarize(title, text) {
  const clipped = text.slice(0, 9000);

  const prompt = `
Return STRICT JSON.

summary: 1–2 neutral sentences.
snippet: 8–15 words.
tags: 3–6 short tags.

Title: ${title}

Article:
${clipped}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.3,
    messages: [{ role: "user", content: prompt }]
  });

  let data = {};
  try {
    data = JSON.parse(resp.choices[0].message.content);
  } catch {
    data.summary = resp.choices[0].message.content.slice(0, 300);
    data.snippet = "";
    data.tags = [];
  }

  return data;
}

// Insert into Supabase
async function insertArticle(row) {
  const res = await fetch(`${https://egurwvorcvczcuuiiwgm.supabase.co}/rest/v1/articles`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVndXJ3dm9yY3ZjemN1dWlpd2dtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0NTAyNjksImV4cCI6MjA4NjAyNjI2OX0.nlafW18ds4vLsSfyW5MBKA7kIq4Z8DfRhT9zvq5ctYE,
      Authorization: `Bearer ${sb_publishable_jJKigtAUsppPgU-6Pk4Ywg__9BDSiGV}`,
      Prefer: "return=minimal"
    },
    body: JSON.stringify(row)
  });

  if (res.status === 409) return false;
  if (!res.ok) throw new Error(await res.text());
  return true;
}

// Main
async function run() {
  let urls = [];

  for (const q of QUERIES) {
    const r = await braveSearch(q);
    urls.push(...r);
  }

  const seen = new Set();
  urls = urls.filter(u => {
    if (!u.url || seen.has(u.url)) return false;
    seen.add(u.url);
    return true;
  });

  let count = 0;

  for (const u of urls.slice(0, 25)) {
    try {
      const { title, text } = await fetchAndExtract(u.url);
      if (text.length < 400) continue;

      const ai = await summarize(title, text);

      const ok = await insertArticle({
        url: u.url,
        title: title || u.url,
        source: u.source,
        summary: ai.summary,
        snippet: ai.snippet,
        tags: ai.tags
      });

      if (ok) count++;
    } catch (e) {
      console.log("Skip", u.url);
    }
  }

  console.log(`Inserted ${count} articles`);
}

run();
