"use strict";

const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const API_BASE = process.env.SIX529_API_BASE || "https://api.6529.io/api";

const TOP_MEMBER_LIMIT = 100;
const DROPS_PER_UPSTREAM_PAGE = 100;
const DROP_PAGES_PER_FEED_PAGE = 5;
const MEMBER_CACHE_TTL_MS = 10 * 60 * 1000;
const POSTS_CACHE_TTL_MS = 30 * 1000;

const memberCache = { savedAt: 0, value: null };
const postsCache = new Map();
let successfulMemberQueryIndex = 0;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function numberValue(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function extractList(payload, preferredKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const candidates = [];
  for (const key of preferredKeys) candidates.push(payload[key]);

  candidates.push(
    payload.data,
    payload.items,
    payload.results,
    payload.members,
    payload.profiles,
    payload.drops,
    payload.data?.data,
    payload.data?.items,
    payload.data?.results,
    payload.data?.members,
    payload.data?.profiles,
    payload.data?.drops
  );

  return candidates.find(Array.isArray) || [];
}

async function fetchJson(url, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "top-100-buzz/1.0",
      },
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error("The API returned invalid JSON.");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function memberLevel(member) {
  return numberValue(
    member?.level,
    member?.profile?.level,
    member?.identity?.level,
    member?.community_member?.level,
    member?.current_level,
    member?.rating?.level,
    member?.metrics?.level
  );
}

function memberHandle(member) {
  return stringValue(
    member?.handle,
    member?.profile?.handle,
    member?.identity?.handle,
    member?.community_member?.handle,
    member?.name
  );
}

function memberImage(member) {
  return stringValue(
    member?.pfp,
    member?.profile?.pfp,
    member?.identity?.pfp,
    member?.community_member?.pfp,
    member?.image
  );
}

function memberPrimaryAddress(member) {
  return stringValue(
    member?.primary_address,
    member?.profile?.primary_address,
    member?.identity?.primary_address,
    member?.community_member?.primary_address,
    member?.wallet,
    member?.address
  );
}

function collectWallets(value, output = []) {
  if (!value) return output;

  if (typeof value === "string") {
    if (/^0x[a-fA-F0-9]{40}$/.test(value.trim())) output.push(value.trim());
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectWallets(item, output);
    return output;
  }

  if (typeof value === "object") {
    for (const key of ["wallet", "address", "wallet_address", "primary_address"]) {
      collectWallets(value[key], output);
    }
  }

  return output;
}

function identityTokensForMember(member) {
  const tokens = new Set();
  const handle = memberHandle(member);
  const primaryAddress = memberPrimaryAddress(member);

  if (handle) tokens.add(`handle:${handle.toLowerCase()}`);
  if (primaryAddress) tokens.add(`wallet:${primaryAddress.toLowerCase()}`);

  const wallets = collectWallets([
    member?.wallets,
    member?.profile?.wallets,
    member?.identity?.wallets,
    member?.community_member?.wallets,
  ]);

  for (const wallet of wallets) tokens.add(`wallet:${wallet.toLowerCase()}`);

  const ids = [
    member?.id,
    member?.profile_id,
    member?.profile?.id,
    member?.identity?.id,
    member?.community_member?.id,
    member?.consolidation_key,
    member?.profile?.consolidation_key,
  ];

  for (const id of ids) {
    if (id !== undefined && id !== null && String(id).trim()) {
      tokens.add(`id:${String(id).trim().toLowerCase()}`);
    }
  }

  return [...tokens];
}

function normalizeMembers(rawMembers) {
  const deduped = new Map();

  rawMembers.forEach((member, originalIndex) => {
    const tokens = identityTokensForMember(member);
    const key =
      tokens.find((token) => token.startsWith("id:")) ||
      tokens.find((token) => token.startsWith("wallet:")) ||
      tokens.find((token) => token.startsWith("handle:")) ||
      `row:${originalIndex}`;

    const normalized = {
      rank: originalIndex + 1,
      level: memberLevel(member),
      handle: memberHandle(member),
      primary_address: memberPrimaryAddress(member),
      pfp: memberImage(member),
      identity_tokens: tokens,
      raw: member,
      original_index: originalIndex,
    };

    const current = deduped.get(key);
    if (!current || normalized.level > current.level) deduped.set(key, normalized);
  });

  const sorted = [...deduped.values()]
    .sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return a.original_index - b.original_index;
    })
    .slice(0, TOP_MEMBER_LIMIT)
    .map((member, index) => ({ ...member, rank: index + 1 }));

  return sorted;
}

function topMemberUrls() {
  const base = `${API_BASE}/community-members/top`;
  const queries = [
    "page=1&page_size=100&sort=LEVEL&sort_direction=DESC",
    "page=1&page_size=100&sort=level&sort_direction=desc",
    "page=1&page_size=100&sort_by=LEVEL&sort_direction=DESC",
    "page=1&page_size=100&sort_by=level&direction=desc",
    "page=1&page_size=100",
    "page=1&limit=100&sort=LEVEL&sort_direction=DESC",
  ];

  return queries.map((query) => `${base}?${query}`);
}

async function fetchTopMembers() {
  if (
    memberCache.value &&
    Date.now() - memberCache.savedAt < MEMBER_CACHE_TTL_MS
  ) {
    return memberCache.value;
  }

  const urls = topMemberUrls();
  const orderedIndexes = [
    successfulMemberQueryIndex,
    ...urls.map((_, index) => index).filter((index) => index !== successfulMemberQueryIndex),
  ];

  const errors = [];
  let bestResult = null;

  for (const index of orderedIndexes) {
    try {
      const payload = await fetchJson(urls[index]);
      const rawMembers = extractList(payload, ["members", "profiles"]);
      const normalized = normalizeMembers(rawMembers);

      if (!normalized.length) {
        errors.push(`Query ${index + 1}: no member rows found`);
        continue;
      }

      const result = {
        members: normalized,
        source_count: rawMembers.length,
        query_variant: index + 1,
        ranking: "level_descending",
        generated_at: new Date().toISOString(),
      };

      if (!bestResult || result.members.length > bestResult.members.length) {
        bestResult = result;
      }

      if (normalized.length >= TOP_MEMBER_LIMIT) {
        successfulMemberQueryIndex = index;
        memberCache.savedAt = Date.now();
        memberCache.value = result;
        return result;
      }
    } catch (error) {
      errors.push(`Query ${index + 1}: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (bestResult) {
    memberCache.savedAt = Date.now();
    memberCache.value = bestResult;
    return bestResult;
  }

  throw new Error(
    `Unable to load 6529 community levels. ${errors.join(" | ").slice(0, 1200)}`
  );
}

function identityTokensForDrop(drop) {
  const author = drop?.author || drop?.profile || drop?.creator || {};
  const tokens = new Set();

  const handle = stringValue(
    author?.handle,
    author?.profile?.handle,
    drop?.author_handle,
    drop?.profile?.handle
  );
  if (handle) tokens.add(`handle:${handle.toLowerCase()}`);

  const addresses = collectWallets([
    author?.primary_address,
    author?.address,
    author?.wallet,
    author?.wallets,
    author?.profile?.primary_address,
    author?.profile?.wallets,
    drop?.signer_address,
    drop?.author_address,
    drop?.profile?.primary_address,
  ]);
  for (const address of addresses) tokens.add(`wallet:${address.toLowerCase()}`);

  const ids = [
    author?.id,
    author?.profile_id,
    author?.profile?.id,
    drop?.author_id,
    drop?.profile_id,
    drop?.profile?.id,
    author?.consolidation_key,
  ];
  for (const id of ids) {
    if (id !== undefined && id !== null && String(id).trim()) {
      tokens.add(`id:${String(id).trim().toLowerCase()}`);
    }
  }

  return [...tokens];
}

function timestampMilliseconds(value) {
  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return number < 1_000_000_000_000 ? number * 1000 : number;
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function dropTimestamp(drop) {
  return timestampMilliseconds(
    drop?.created_at ?? drop?.createdAt ?? drop?.timestamp ?? drop?.created
  );
}

function makeMemberLookup(members) {
  const lookup = new Map();
  for (const member of members) {
    for (const token of member.identity_tokens) {
      if (!lookup.has(token)) lookup.set(token, member);
    }
  }
  return lookup;
}

function matchDropToMember(drop, lookup) {
  for (const token of identityTokensForDrop(drop)) {
    const member = lookup.get(token);
    if (member) return member;
  }
  return null;
}

async function fetchDropsPage(page) {
  const url = new URL(`${API_BASE}/v2/drops`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(DROPS_PER_UPSTREAM_PAGE));

  const payload = await fetchJson(url);
  return extractList(payload, ["drops"]);
}

function publicMember(member) {
  return {
    rank: member.rank,
    level: member.level,
    handle: member.handle,
    primary_address: member.primary_address,
    pfp: member.pfp,
  };
}

async function fetchTopMemberPosts(feedPage) {
  const cacheKey = String(feedPage);
  const cached = postsCache.get(cacheKey);

  if (cached && Date.now() - cached.savedAt < POSTS_CACHE_TTL_MS) {
    return cached.value;
  }

  const memberResult = await fetchTopMembers();
  const lookup = makeMemberLookup(memberResult.members);

  const firstUpstreamPage = (feedPage - 1) * DROP_PAGES_PER_FEED_PAGE + 1;
  const pageNumbers = Array.from(
    { length: DROP_PAGES_PER_FEED_PAGE },
    (_, index) => firstUpstreamPage + index
  );

  const pageResults = await Promise.allSettled(pageNumbers.map(fetchDropsPage));
  const drops = [];
  const errors = [];

  pageResults.forEach((result, index) => {
    if (result.status === "fulfilled") {
      drops.push(...result.value);
    } else {
      errors.push(
        `Drops page ${pageNumbers[index]}: ${
          result.reason instanceof Error ? result.reason.message : result.reason
        }`
      );
    }
  });

  if (!drops.length && errors.length) {
    throw new Error(errors.join(" | ").slice(0, 1200));
  }

  const seen = new Set();
  const posts = [];

  drops.forEach((drop, index) => {
    const member = matchDropToMember(drop, lookup);
    if (!member) return;

    const id = stringValue(
      drop?.id,
      drop?.drop_id,
      drop?.serial_no,
      `${member.rank}:${dropTimestamp(drop)}:${index}`
    );
    if (seen.has(id)) return;
    seen.add(id);

    posts.push({
      ...drop,
      _top_member: publicMember(member),
    });
  });

  posts.sort((a, b) => dropTimestamp(b) - dropTimestamp(a));

  const value = {
    data: posts,
    feed_page: feedPage,
    scanned_drop_pages: pageNumbers,
    scanned_drop_count: drops.length,
    matched_post_count: posts.length,
    top_member_count: memberResult.members.length,
    ranking: memberResult.ranking,
    ranking_query_variant: memberResult.query_variant,
    member_source_count: memberResult.source_count,
    has_more: drops.length >= DROPS_PER_UPSTREAM_PAGE,
    warnings: errors,
    generated_at: new Date().toISOString(),
  };

  postsCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

async function serveStatic(req, res, pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(requestedPath);
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const extension = path.extname(filePath).toLowerCase();

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
      "Content-Length": file.length,
      "Cache-Control": extension === ".html" ? "no-cache" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });

    if (req.method === "HEAD") res.end();
    else res.end(file);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: "Unable to read the requested file." });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`
    );

    if (requestUrl.pathname === "/api/top-members") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      try {
        const result = await fetchTopMembers();
        sendJson(res, 200, {
          data: result.members.map(publicMember),
          count: result.members.length,
          ranking: result.ranking,
          generated_at: result.generated_at,
        });
      } catch (error) {
        console.error("Top-member request failed:", error);
        sendJson(res, 502, {
          error: error instanceof Error ? error.message : "Unable to load top members.",
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/posts") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const page = positiveInteger(requestUrl.searchParams.get("page"), 1, 10_000);

      try {
        const result = await fetchTopMemberPosts(page);
        sendJson(res, 200, result);
      } catch (error) {
        console.error("Top-100 feed request failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load the Top 100 feed.",
        });
      }
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    await serveStatic(req, res, requestUrl.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Unexpected server error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("Top 100 Buzz is running.");
  console.log(`Open: http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop it.");
  console.log("");
});
