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
  const clip

