"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const dns = require("node:dns").promises;
const net = require("node:net");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const API_BASE = process.env.SIX529_API_BASE || "https://api.6529.io/api";
const STATIC_ROOT = path.join(__dirname, "public");
const PFP_MAX_BYTES = 5_000_000;
const PFP_MAX_REDIRECTS = 3;

const TOP_MEMBER_LIMIT = 100;
const PAGE_SIZE = 100;
const MEMBER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FEED_CACHE_TTL_MS = 90 * 1000;
const IDENTITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IDENTITY_LOOKUP_CONCURRENCY = 4;
const CHAT_IDENTITY_ENRICH_LIMIT = 12;
const RAW_DROPS_CACHE_TTL_MS = 2 * 60 * 1000;
const RAW_DROPS_CACHE_MAX_PAGES = 4;
const TOP_POSTS_TARGET = 12;
const TOP_POSTS_SCAN_PAGES = 5;
const MAIN_STAGE_WAVE_ID = "b6128077-ea78-4dd9-b381-52c4eadb2077";
const MAIN_STAGE_WAVE_NAME = "The Memes - Main Stage";
const MAIN_STAGE_PAGE_SIZE = 20;
const MAIN_STAGE_CACHE_TTL_MS = 60 * 1000;
const MEMBER_PROFILE_CACHE_TTL_MS = 2 * 60 * 1000;
const MEMBER_PROFILE_POST_LIMIT = 30;
const MOVERS_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const MOVERS_RETENTION_MS = 24 * 60 * 60 * 1000;
const MOVERS_MAX_LEADERBOARD_PAGES = 5;
const EXPLORE_CACHE_TTL_MS = 10 * 60 * 1000;
const EXPLORE_TOTAL_WAVES_MAX_PAGES = 500;
const TOTAL_WAVES_CACHE_TTL_MS = 60 * 60 * 1000;
const EXPLORE_TDH_MAX_PAGES = 100;
const MILLION_TDH_THRESHOLD = 1_000_000;
const DAILY_BUZZ_IDENTITY_PAGE_SIZE = 50;
const DAILY_BUZZ_IDENTITY_MAX_PAGE_SIZE = 100;
const DAILY_BUZZ_IDENTITY_CACHE_TTL_MS = 10 * 60 * 1000;
const PUNK_HANDLE = "punk6529";
const PUNK_COMPLETE_DAYS_PER_BATCH = 1;
const PUNK_CACHE_TTL_MS = 5 * 60 * 1000;
const PUNK_MAX_TEXT_LENGTH = 16000;
const PUNK_AUTHOR_BATCH_LIMIT = 20;
const PUNK_AUTHOR_MAX_REQUESTS = 12;
const PUNK_AUTHOR_BATCH_CACHE_MAX = 16;
const MEMES_CONTRACT = "0x33fd426905f149f8376e227d0c9d3340aad17af1";
const MEMES_GALLERY_PAGE_SIZE = 100;
const MEMES_GALLERY_MAX_PAGES = 12;
const MEMES_GALLERY_CACHE_TTL_MS = 30 * 60 * 1000;

const memberCache = { savedAt: 0, value: null };
const enrichedMemberCache = { savedAt: 0, value: null };
const identityProfileCache = new Map();
const chatCache = new Map();
const topPostsCache = new Map();
const mainStageLeaderboardCache = new Map();
const memberProfileCache = new Map();
const mainStageMoverSnapshots = [];
let exploreDashboardCache = null;
let totalWavesCache = null;
const dailyBuzzIdentityPageCache = new Map();
const rawDropsCache = new Map();
const punkPostsCache = new Map();
const punkAuthorBatchCache = new Map();
const punkIdentityCache = { savedAt: 0, value: null };
const punkPostsInFlight = new Map();
const memesGalleryCache = { savedAt: 0, value: null };

const API_MIN_GAP_MS = 1050;
const API_MAX_RETRIES = 5;
let apiRequestChain = Promise.resolve();
let lastApiRequestAt = 0;
let successfulMemberQueryIndex = 0;



function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
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

function optionalNumberValue(...values) {
  for (const value of values) {
    if (
      value === null ||
      value === undefined ||
      value === ""
    ) {
      continue;
    }

    const normalized =
      typeof value === "string"
        ? value.replaceAll(",", "").trim()
        : value;

    if (normalized === "") continue;

    const parsed = Number(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function numberValue(...values) {
  return optionalNumberValue(...values) ?? 0;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function extractList(payload, preferredKeys = []) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const candidates = [];

  for (const key of preferredKeys) {
    candidates.push(payload[key]);
  }

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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForApiTurn() {
  let release;
  const previous = apiRequestChain;

  apiRequestChain = new Promise((resolve) => {
    release = resolve;
  });

  await previous.catch(() => {});

  const elapsed = Date.now() - lastApiRequestAt;
  const waitTime = Math.max(0, API_MIN_GAP_MS - elapsed);

  if (waitTime > 0) {
    await sleep(waitTime);
  }

  lastApiRequestAt = Date.now();
  release();
}

function retryDelayMilliseconds(response, bodyText, attempt) {
  const headerValue = Number(response.headers.get("retry-after"));
  let bodyValue = 0;

  try {
    const parsed = JSON.parse(bodyText);
    bodyValue = Number(parsed?.retryAfter ?? parsed?.retry_after ?? 0);
  } catch {
    bodyValue = 0;
  }

  const requestedSeconds = Math.max(
    Number.isFinite(headerValue) ? headerValue : 0,
    Number.isFinite(bodyValue) ? bodyValue : 0
  );

  return Math.max(
    1000,
    requestedSeconds * 1000,
    Math.min(12_000, 1000 * 2 ** attempt)
  );
}

async function fetchJson(url, timeoutMs = 20_000) {
  let lastError = null;

  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt += 1) {
    await waitForApiTurn();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "brain-buzz/2.1",
        },
        signal: controller.signal,
        cache: "no-store",
      });

      const text = await response.text();

      if (response.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new Error("The 6529 API returned invalid JSON.");
        }
      }

      const error = new Error(
        `HTTP ${response.status}: ${text.slice(0, 300)}`
      );
      lastError = error;

      const retryable = [429, 502, 503, 504].includes(response.status);

      if (!retryable || attempt >= API_MAX_RETRIES) {
        throw error;
      }

      await sleep(retryDelayMilliseconds(response, text, attempt));
    } catch (error) {
      lastError = error;

      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        error?.name === "AbortError" ||
        error?.name === "TypeError" ||
        /^HTTP (429|502|503|504)/.test(message);

      if (!retryable || attempt >= API_MAX_RETRIES) {
        throw error;
      }

      await sleep(Math.min(12_000, 1000 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error("Unable to contact the 6529 API.");
}


async function fetchJsonDirect(
  url,
  {
    timeoutMs = 20_000,
    headers = {},
    sourceLabel = "API",
  } = {}
) {
  let lastError = null;

  for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "brain-buzz/2.2",
          ...headers,
        },
        signal: controller.signal,
        cache: "no-store",
      });

      const text = await response.text();

      if (response.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`${sourceLabel} returned invalid JSON.`);
        }
      }

      const error = new Error(
        `${sourceLabel} HTTP ${response.status}: ${text.slice(0, 300)}`
      );
      lastError = error;

      const retryable = [429, 502, 503, 504].includes(response.status);
      if (!retryable || attempt >= API_MAX_RETRIES) throw error;

      await sleep(retryDelayMilliseconds(response, text, attempt));
    } catch (error) {
      lastError = error;
      const message =
        error instanceof Error ? error.message : String(error);
      const retryable =
        error?.name === "AbortError" ||
        error?.name === "TypeError" ||
        /HTTP (429|502|503|504)/.test(message);

      if (!retryable || attempt >= API_MAX_RETRIES) throw error;
      await sleep(Math.min(12_000, 1000 * 2 ** attempt));
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error(`${sourceLabel} request failed.`);
}

function collectWallets(value, output = []) {
  if (!value) return output;

  if (typeof value === "string") {
    if (/^0x[a-fA-F0-9]{40}$/.test(value.trim())) {
      output.push(value.trim());
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectWallets(item, output);
    }
    return output;
  }

  if (typeof value === "object") {
    for (const key of [
      "wallet",
      "address",
      "wallet_address",
      "primary_address",
    ]) {
      collectWallets(value[key], output);
    }
  }

  return output;
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

function memberTdh(member) {
  return optionalNumberValue(
    member?.tdh,
    member?.profile?.tdh,
    member?.identity?.tdh,
    member?.community_member?.tdh,
    member?.total_tdh,
    member?.boosted_tdh,
    member?.combined_tdh,
    member?.metrics?.tdh
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

function normalizeXUsername(value) {
  const raw = stringValue(value);
  if (!raw) return "";

  let candidate = raw.trim();

  try {
    if (/^https?:\/\//i.test(candidate)) {
      const parsed = new URL(candidate);
      candidate = parsed.pathname.split("/").filter(Boolean)[0] || "";
    }
  } catch {
    candidate = raw;
  }

  candidate = candidate
    .replace(/^@+/, "")
    .split(/[/?#]/)[0]
    .trim();

  return /^[A-Za-z0-9_]{1,15}$/.test(candidate)
    ? candidate
    : "";
}

function memberTwitterHandle(member) {
  return normalizeXUsername(
    stringValue(
      member?.twitter_handle,
      member?.x_handle,
      member?.profile?.twitter_handle,
      member?.profile?.x_handle,
      member?.identity?.twitter_handle,
      member?.identity?.x_handle,
      member?.community_member?.twitter_handle,
      member?.socials?.twitter,
      member?.socials?.x
    )
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

  for (const wallet of wallets) {
    tokens.add(`wallet:${wallet.toLowerCase()}`);
  }

  for (const id of [
    member?.id,
    member?.profile_id,
    member?.profile?.id,
    member?.identity?.id,
    member?.community_member?.id,
    member?.consolidation_key,
    member?.profile?.consolidation_key,
  ]) {
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
      tdh: memberTdh(member),
      handle: memberHandle(member),
      twitter_handle: memberTwitterHandle(member),
      primary_address: memberPrimaryAddress(member),
      pfp: memberImage(member),
      identity_tokens: tokens,
      original_index: originalIndex,
    };

    const current = deduped.get(key);
    if (!current || normalized.level > current.level) {
      deduped.set(key, normalized);
    }
  });

  return [...deduped.values()]
    .sort((a, b) => {
      if (b.level !== a.level) return b.level - a.level;
      return a.original_index - b.original_index;
    })
    .slice(0, TOP_MEMBER_LIMIT)
    .map((member, index) => ({ ...member, rank: index + 1 }));
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
    ...urls
      .map((_, index) => index)
      .filter((index) => index !== successfulMemberQueryIndex),
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
      errors.push(
        `Query ${index + 1}: ${
          error instanceof Error ? error.message : error
        }`
      );
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

function findStringByKeys(value, wantedKeys, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) {
    return "";
  }

  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (
      wantedKeys.has(key.toLowerCase()) &&
      typeof child === "string" &&
      child.trim()
    ) {
      return child.trim();
    }
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findStringByKeys(child, wantedKeys, depth + 1, seen);
      if (found) return found;
    }
  }

  return "";
}

function findNumberByKeys(
  value,
  wantedKeys,
  depth = 0,
  seen = new Set()
) {
  if (
    !value ||
    typeof value !== "object" ||
    depth > 7 ||
    seen.has(value)
  ) {
    return null;
  }

  seen.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (!wantedKeys.has(key.toLowerCase())) continue;

    const parsed = optionalNumberValue(child);
    if (parsed !== null) return parsed;
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findNumberByKeys(
        child,
        wantedKeys,
        depth + 1,
        seen
      );
      if (found !== null) return found;
    }
  }

  return null;
}

function identityProfileFromPayload(payload) {
  return {
    handle:
      memberHandle(payload) ||
      findStringByKeys(
        payload,
        new Set([
          "handle",
          "profile_handle",
          "username",
          "screen_name",
          "display_name",
        ])
      ),
    pfp:
      memberImage(payload) ||
      findStringByKeys(
        payload,
        new Set([
          "pfp",
          "profile_image",
          "profile_image_url",
          "avatar",
          "avatar_url",
        ])
      ),
    primary_address:
      memberPrimaryAddress(payload) ||
      findStringByKeys(
        payload,
        new Set([
          "primary_address",
          "primary_wallet",
          "wallet",
          "wallet_address",
          "address",
        ])
      ),
    tdh: profileTdhFromPayload(payload),
    twitter_handle:
      memberTwitterHandle(payload) ||
      normalizeXUsername(
        findStringByKeys(
          payload,
          new Set([
            "twitter_handle",
            "x_handle",
            "twitter_username",
            "x_username",
          ])
        )
      ),
    identity_tokens: identityTokensForMember(payload),
  };
}

function collectWalletsDeep(value, output = [], seen = new Set()) {
  if (!value || seen.has(value)) return output;

  if (typeof value === "string") {
    if (/^0x[a-fA-F0-9]{40}$/.test(value.trim())) {
      output.push(value.trim());
    }
    return output;
  }

  if (typeof value !== "object") return output;

  seen.add(value);

  for (const child of Object.values(value)) {
    collectWalletsDeep(child, output, seen);
  }

  return output;
}

async function fetchPunkIdentity() {
  if (
    punkIdentityCache.value &&
    Date.now() - punkIdentityCache.savedAt < IDENTITY_CACHE_TTL_MS
  ) {
    return punkIdentityCache.value;
  }

  const payload = await fetchJson(
    `${API_BASE}/identities/${encodeURIComponent(PUNK_HANDLE)}`,
    15_000
  );

  const profile = identityProfileFromPayload(payload);
  const tokens = new Set([
    ...identityTokensForMember(payload),
    `handle:${PUNK_HANDLE}`,
  ]);

  for (const wallet of collectWalletsDeep(payload)) {
    tokens.add(`wallet:${wallet.toLowerCase()}`);
  }

  const value = {
    handle: profile.handle || PUNK_HANDLE,
    pfp: profile.pfp,
    primary_address: profile.primary_address,
    identity_tokens: [...tokens],
  };

  punkIdentityCache.savedAt = Date.now();
  punkIdentityCache.value = value;
  return value;
}

function dropMatchesPunk(drop, identity) {
  const author = dropAuthor(drop);

  if (author.handle.toLowerCase() === PUNK_HANDLE) {
    return true;
  }

  const identityTokens = new Set(identity.identity_tokens);

  return identityTokensForDrop(drop).some((token) =>
    identityTokens.has(token)
  );
}

async function fetchIdentityProfile(wallet) {
  const normalizedWallet = stringValue(wallet).toLowerCase();
  if (!normalizedWallet) return null;

  const cached = identityProfileCache.get(normalizedWallet);

  if (cached && Date.now() - cached.savedAt < IDENTITY_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const payload = await fetchJson(
      `${API_BASE}/identities/by-wallet/${encodeURIComponent(wallet)}`,
      12_000
    );
    const profile = identityProfileFromPayload(payload);

    identityProfileCache.set(normalizedWallet, {
      savedAt: Date.now(),
      value: profile,
    });

    return profile;
  } catch (error) {
    console.error(`Identity lookup failed for ${wallet}:`, error);

    identityProfileCache.set(normalizedWallet, {
      savedAt: Date.now(),
      value: null,
    });

    return null;
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => runWorker()
    )
  );

  return results;
}

async function enrichMembersWithIdentities(members) {
  return mapWithConcurrency(
    members,
    IDENTITY_LOOKUP_CONCURRENCY,
    async (member) => {
      if (!member.primary_address || (member.handle && member.pfp)) {
        return member;
      }

      const identity = await fetchIdentityProfile(member.primary_address);
      if (!identity) return member;

      const tokens = new Set([
        ...member.identity_tokens,
        ...arrayValue(identity.identity_tokens),
      ]);

      if (identity.handle) {
        tokens.add(`handle:${identity.handle.toLowerCase()}`);
      }

      return {
        ...member,
        handle: identity.handle || member.handle,
        pfp: identity.pfp || member.pfp,
        primary_address:
          identity.primary_address || member.primary_address,
        twitter_handle:
          identity.twitter_handle || member.twitter_handle,
        identity_tokens: [...tokens],
      };
    }
  );
}

async function fetchEnrichedTopMembers() {
  if (
    enrichedMemberCache.value &&
    Date.now() - enrichedMemberCache.savedAt < IDENTITY_CACHE_TTL_MS
  ) {
    return enrichedMemberCache.value;
  }

  const result = await fetchTopMembers();
  const enrichedMembers = await enrichMembersWithIdentities(result.members);

  const enrichedResult = {
    ...result,
    members: enrichedMembers,
    generated_at: new Date().toISOString(),
  };

  enrichedMemberCache.savedAt = Date.now();
  enrichedMemberCache.value = enrichedResult;
  return enrichedResult;
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

  for (const address of addresses) {
    tokens.add(`wallet:${address.toLowerCase()}`);
  }

  for (const id of [
    author?.id,
    author?.profile_id,
    author?.profile?.id,
    drop?.author_id,
    drop?.profile_id,
    drop?.profile?.id,
    author?.consolidation_key,
  ]) {
    if (id !== undefined && id !== null && String(id).trim()) {
      tokens.add(`id:${String(id).trim().toLowerCase()}`);
    }
  }

  return [...tokens];
}

function dropAuthor(drop) {
  const author = drop?.author || drop?.profile || drop?.creator || {};

  const primaryAddress = stringValue(
    author?.primary_address,
    author?.address,
    author?.wallet,
    author?.profile?.primary_address,
    drop?.signer_address,
    drop?.author_address
  );

  return {
    handle: stringValue(
      author?.handle,
      author?.profile?.handle,
      drop?.author_handle,
      drop?.profile?.handle
    ),
    pfp: stringValue(
      author?.pfp,
      author?.profile?.pfp,
      drop?.profile?.pfp,
      author?.image
    ),
    primary_address: primaryAddress,
  };
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

function isChatDrop(drop) {
  return String(drop?.drop_type ?? drop?.type ?? "").toUpperCase() === "CHAT";
}

function dropTimestamp(drop) {
  const value =
    drop?.created_at ??
    drop?.createdAt ??
    drop?.timestamp ??
    drop?.created;

  if (value === null || value === undefined || value === "") return 0;

  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return number < 1_000_000_000_000 ? number * 1000 : number;
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

async function fetchDropsPage(page) {
  const cacheKey = String(page);
  const cached = rawDropsCache.get(cacheKey);

  if (cached && Date.now() - cached.savedAt < RAW_DROPS_CACHE_TTL_MS) {
    return cached.value;
  }

  const url = new URL(`${API_BASE}/v2/drops`);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(PAGE_SIZE));

  const payload = await fetchJson(url);
  const drops = extractList(payload, ["drops"]);

  rawDropsCache.set(cacheKey, {
    savedAt: Date.now(),
    value: drops,
  });

  while (rawDropsCache.size > RAW_DROPS_CACHE_MAX_PAGES) {
    const oldestKey = rawDropsCache.keys().next().value;
    rawDropsCache.delete(oldestKey);
  }

  return drops;
}

function proxiedPfpUrl(value) {
  const raw = stringValue(value);
  if (!raw) return "";
  return `/api/pfp?src=${encodeURIComponent(raw)}`;
}

function publicMember(member) {
  return {
    rank: member.rank,
    level: member.level,
    tdh: member.tdh,
    handle: member.handle,
    x_username: normalizeXUsername(
      member.x_username || member.twitter_handle
    ),
    primary_address: member.primary_address,
    pfp: proxiedPfpUrl(member.pfp),
  };
}

async function enrichChatAuthors(chats) {
  const byAddress = new Map();

  for (const drop of chats) {
    const author = dropAuthor(drop);

    if (
      author.primary_address &&
      (!author.handle || !author.pfp) &&
      !byAddress.has(author.primary_address.toLowerCase()) &&
      byAddress.size < CHAT_IDENTITY_ENRICH_LIMIT
    ) {
      byAddress.set(author.primary_address.toLowerCase(), author.primary_address);
    }
  }

  const identities = await mapWithConcurrency(
    [...byAddress.values()],
    IDENTITY_LOOKUP_CONCURRENCY,
    async (address) => [address.toLowerCase(), await fetchIdentityProfile(address)]
  );

  return new Map(identities);
}

async function fetchChatFeed(page) {
  const cacheKey = String(page);
  const cached = chatCache.get(cacheKey);

  if (cached && Date.now() - cached.savedAt < FEED_CACHE_TTL_MS) {
    return cached.value;
  }

  const drops = await fetchDropsPage(page);
  const chats = drops.filter(isChatDrop);
  const identities = await enrichChatAuthors(chats);

  const data = chats.map((drop) => {
    const author = dropAuthor(drop);
    const identity = identities.get(author.primary_address.toLowerCase()) || null;

    return {
      ...drop,
      _display_author: {
        handle: author.handle || identity?.handle || "",
        primary_address:
          author.primary_address || identity?.primary_address || "",
        pfp: proxiedPfpUrl(author.pfp || identity?.pfp || ""),
      },
    };
  });

  const value = {
    data,
    page,
    scanned_drop_count: drops.length,
    chat_count: data.length,
    has_more: drops.length >= PAGE_SIZE,
    warnings: [],
    generated_at: new Date().toISOString(),
  };

  chatCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

async function fetchTopPosts(page) {
  const cacheKey = String(page);
  const cached = topPostsCache.get(cacheKey);

  if (cached && Date.now() - cached.savedAt < FEED_CACHE_TTL_MS) {
    return cached.value;
  }

  const memberResult = await fetchTopMembers();
  const lookup = makeMemberLookup(memberResult.members);
  const firstDropPage = (page - 1) * TOP_POSTS_SCAN_PAGES + 1;
  const scannedPages = [];
  const allDrops = [];
  const matched = [];
  const seen = new Set();
  const warnings = [];
  let lastPageWasFull = false;

  for (let offset = 0; offset < TOP_POSTS_SCAN_PAGES; offset += 1) {
    const dropPage = firstDropPage + offset;

    try {
      const drops = await fetchDropsPage(dropPage);
      scannedPages.push(dropPage);
      allDrops.push(...drops);
      lastPageWasFull = drops.length >= PAGE_SIZE;

      drops.forEach((drop, index) => {
        const member = matchDropToMember(drop, lookup);
        if (!member) return;

        const id = stringValue(
          drop?.id,
          drop?.drop_id,
          drop?.serial_no,
          `${member.rank}:${dropTimestamp(drop)}:${dropPage}:${index}`
        );

        if (seen.has(id)) return;
        seen.add(id);

        const author = dropAuthor(drop);

        matched.push({
          drop,
          member: {
            ...member,
            handle: author.handle || member.handle,
            pfp: author.pfp || member.pfp,
            primary_address:
              author.primary_address || member.primary_address,
          },
        });
      });

      if (matched.length >= TOP_POSTS_TARGET || drops.length < PAGE_SIZE) {
        break;
      }
    } catch (error) {
      warnings.push(
        `Drops page ${dropPage}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      break;
    }
  }

  if (!allDrops.length && warnings.length) {
    throw new Error(warnings.join(" | ").slice(0, 1200));
  }

  const uniqueMembers = [
    ...new Map(
      matched.map(({ member }) => [
        member.primary_address || `rank:${member.rank}`,
        member,
      ])
    ).values(),
  ];

  const enriched = await enrichMembersWithIdentities(uniqueMembers);
  const enrichedByKey = new Map(
    enriched.map((member) => [
      member.primary_address || `rank:${member.rank}`,
      member,
    ])
  );

  const data = matched
    .map(({ drop, member }) => {
      const key = member.primary_address || `rank:${member.rank}`;

      return {
        ...drop,
        _top_member: publicMember(enrichedByKey.get(key) || member),
      };
    })
    .sort((a, b) => dropTimestamp(b) - dropTimestamp(a));

  const value = {
    data,
    page,
    scanned_drop_pages: scannedPages,
    scanned_drop_count: allDrops.length,
    matched_post_count: data.length,
    top_member_count: memberResult.members.length,
    has_more: lastPageWasFull,
    warnings,
    generated_at: new Date().toISOString(),
  };

  topPostsCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}


function normalizeIdentityKey(value) {
  return stringValue(value).trim().toLowerCase();
}

function profileBioFromPayload(payload) {
  return findStringByKeys(
    payload,
    new Set([
      "bio",
      "about",
      "profile_bio",
      "profile_description",
      "description",
    ])
  ).slice(0, 1800);
}

function profileTdhFromPayload(payload) {
  const direct = optionalNumberValue(
    payload?.tdh,
    payload?.identity?.tdh,
    payload?.profile?.tdh,
    payload?.community_member?.tdh,
    payload?.boosted_tdh,
    payload?.total_tdh,
    payload?.consolidated_tdh
  );

  if (direct !== null) return direct;

  return findNumberByKeys(
    payload,
    new Set([
      "tdh",
      "boosted_tdh",
      "total_tdh",
      "consolidated_tdh",
    ])
  );
}

function profileLevelFromPayload(payload) {
  const direct = memberLevel(payload);
  if (direct) return direct;

  return (
    findNumberByKeys(
      payload,
      new Set([
        "level",
        "profile_level",
        "community_level",
        "current_level",
      ])
    ) || 0
  );
}

function memberMatchesIdentity(member, identityPayload, requestedIdentity) {
  const requested = normalizeIdentityKey(requestedIdentity);
  const memberTokens = new Set(identityTokensForMember(member));
  const identityTokens = new Set(identityTokensForMember(identityPayload));

  if (requested) {
    identityTokens.add(`handle:${requested}`);
    identityTokens.add(`wallet:${requested}`);
    identityTokens.add(`id:${requested}`);
  }

  for (const token of identityTokens) {
    if (memberTokens.has(token)) return true;
  }

  return false;
}

function compactMemberDrop(drop, displayAuthor) {
  return {
    id: stringValue(drop?.id, drop?.drop_id),
    drop_id: stringValue(drop?.drop_id),
    serial_no: stringValue(drop?.serial_no, drop?.serial),
    created_at:
      drop?.created_at ??
      drop?.createdAt ??
      drop?.timestamp ??
      drop?.created ??
      null,
    title: stringValue(drop?.title),
    content: compactDropText(drop),
    drop_type: stringValue(drop?.drop_type, drop?.type) || "POST",
    wave_id: stringValue(
      drop?.wave?.id,
      drop?.wave_id,
      drop?.wave?.wave_id
    ),
    wave: {
      id: stringValue(
        drop?.wave?.id,
        drop?.wave_id,
        drop?.wave?.wave_id
      ),
      name:
        stringValue(
          drop?.wave?.name,
          drop?.wave_name,
          drop?.wave?.title,
          drop?.wave_id
        ) || "Unknown Wave",
    },
    _media_count: compactDropMediaCount(drop),
    _display_author: displayAuthor,
  };
}

function summarizeMemberWaves(drops) {
  const waves = new Map();

  for (const drop of drops) {
    const id = stringValue(drop?.wave?.id, drop?.wave_id);
    const name =
      stringValue(drop?.wave?.name, drop?.wave_name, id) ||
      "Unknown Wave";
    const key = id || name.toLowerCase();

    if (!waves.has(key)) {
      waves.set(key, {
        id,
        name,
        post_count: 0,
        last_post_at: drop?.created_at ?? null,
      });
    }

    const wave = waves.get(key);
    wave.post_count += 1;

    if (
      dropTimestamp(drop) >
      dropTimestamp({ created_at: wave.last_post_at })
    ) {
      wave.last_post_at = drop?.created_at ?? wave.last_post_at;
    }
  }

  return [...waves.values()]
    .sort((a, b) => {
      if (b.post_count !== a.post_count) {
        return b.post_count - a.post_count;
      }

      return (
        dropTimestamp({ created_at: b.last_post_at }) -
        dropTimestamp({ created_at: a.last_post_at })
      );
    })
    .slice(0, 9);
}

async function fetchMemberAuthorDrops(
  requestedIdentity,
  identityPayload
) {
  const identity = identityProfileFromPayload(identityPayload);
  const candidates = [
    memberHandle(identityPayload),
    identity.handle,
    requestedIdentity,
    identity.primary_address,
  ]
    .map(stringValue)
    .filter(Boolean);

  const uniqueCandidates = [
    ...new Set(candidates.map((value) => value.trim())),
  ];
  const errors = [];

  for (const candidate of uniqueCandidates) {
    try {
      const url = new URL(`${API_BASE}/drops`);
      url.searchParams.set("author", candidate);
      url.searchParams.set(
        "limit",
        String(MEMBER_PROFILE_POST_LIMIT)
      );
      url.searchParams.set("include_replies", "true");

      const payload = await fetchJson(url, 20_000);
      const drops = extractList(payload, ["drops"]);

      if (drops.length) return drops;
    } catch (error) {
      errors.push(
        `${candidate}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (errors.length === uniqueCandidates.length && errors.length) {
    throw new Error(errors.join(" | ").slice(0, 1200));
  }

  return [];
}

async function fetchMemberTdh(identity) {
  const payload = await fetchJson(
    `${API_BASE}/tdh/consolidation/${encodeURIComponent(identity)}`,
    15_000
  );

  return profileTdhFromPayload(payload);
}

async function buildMemberProfile(
  requestedIdentity,
  { force = false } = {}
) {
  const normalized = normalizeIdentityKey(requestedIdentity);
  if (!normalized) {
    throw new Error("A member handle, ENS name, or wallet is required.");
  }

  const cached = memberProfileCache.get(normalized);

  if (
    !force &&
    cached &&
    Date.now() - cached.savedAt < MEMBER_PROFILE_CACHE_TTL_MS
  ) {
    return cached.value;
  }

  const warnings = [];

  const identityPayload = await fetchJson(
    `${API_BASE}/identities/${encodeURIComponent(requestedIdentity)}`,
    18_000
  );

  const identity = identityProfileFromPayload(identityPayload);

  let drops = [];

  try {
    drops = await fetchMemberAuthorDrops(
      requestedIdentity,
      identityPayload
    );
  } catch (error) {
    warnings.push(
      `Recent posts: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  let topMember = null;

  try {
    const memberResult = await fetchTopMembers();
    topMember =
      memberResult.members.find((member) =>
        memberMatchesIdentity(
          member,
          identityPayload,
          requestedIdentity
        )
      ) || null;
  } catch (error) {
    warnings.push(
      `Top-member rank: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  let tdh = optionalNumberValue(
    profileTdhFromPayload(identityPayload),
    topMember?.tdh
  );

  if (tdh === null) {
    try {
      tdh = await fetchMemberTdh(
        identity.handle ||
        identity.primary_address ||
        requestedIdentity
      );
    } catch (error) {
      warnings.push(
        `TDH: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const displayAuthor = {
    handle: identity.handle || requestedIdentity,
    primary_address: identity.primary_address,
    pfp: proxiedPfpUrl(identity.pfp),
  };

  const recentPosts = drops
    .map((drop) => compactMemberDrop(drop, displayAuthor))
    .sort((a, b) => dropTimestamp(b) - dropTimestamp(a));

  const activeWaves = summarizeMemberWaves(recentPosts);
  const mainStageActivity = recentPosts.filter(
    (drop) =>
      stringValue(drop?.wave?.id, drop?.wave_id) ===
      MAIN_STAGE_WAVE_ID
  );

  const level =
    numberValue(topMember?.level) ||
    profileLevelFromPayload(identityPayload) ||
    null;

  const profileIdentity =
    identity.handle ||
    identity.primary_address ||
    requestedIdentity;

  const value = {
    profile: {
      requested_identity: requestedIdentity,
      handle: identity.handle || requestedIdentity,
      primary_address: identity.primary_address,
      pfp: proxiedPfpUrl(identity.pfp),
      bio: profileBioFromPayload(identityPayload),
      level,
      tdh,
      top_member_rank: topMember?.rank || null,
      profile_url:
        `https://6529.io/${encodeURIComponent(profileIdentity)}`,
    },
    recent_posts: recentPosts,
    main_stage_activity: mainStageActivity,
    active_waves: activeWaves,
    warnings,
    generated_at: new Date().toISOString(),
  };

  memberProfileCache.set(normalized, {
    savedAt: Date.now(),
    value,
  });

  while (memberProfileCache.size > 120) {
    const oldestKey = memberProfileCache.keys().next().value;
    memberProfileCache.delete(oldestKey);
  }

  return value;
}


function nullableNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function mainStageEntryId(drop, fallback = "") {
  return stringValue(
    drop?.id,
    drop?.drop_id,
    drop?.serial_no,
    fallback
  );
}

function mainStageEntryAuthor(drop) {
  return (
    stringValue(
      drop?.author?.handle,
      drop?.author?.profile?.handle,
      drop?.profile?.handle,
      drop?.author_handle
    ) ||
    stringValue(
      drop?.author?.primary_address,
      drop?.author?.address,
      drop?.signer_address
    ) ||
    "Unknown artist"
  );
}

function compactMainStageTrackingEntry(drop, index = 0) {
  return {
    id: mainStageEntryId(drop, `entry-${index}`),
    drop_id: stringValue(drop?.id, drop?.drop_id),
    wave_id: MAIN_STAGE_WAVE_ID,
    rank: nullableNumber(
      drop?._leaderboard_rank,
      drop?.rank,
      drop?.submission_context?.rank
    ),
    voting_tdh: optionalNumberValue(
      drop?._voting_tdh,
      drop?.submission_context?.voting?.current_calculated_vote,
      drop?.submission_context?.voting?.total_votes_given,
      drop?.rating,
      drop?.realtime_rating,
      drop?._leaderboard_score,
      drop?.submission_context?.rating
    ),
    author: mainStageEntryAuthor(drop),
    title:
      stringValue(drop?.title) ||
      compactDropText(drop).slice(0, 120) ||
      "Untitled Main Stage entry",
    created_at:
      drop?.created_at ??
      drop?.createdAt ??
      drop?.timestamp ??
      null,
  };
}

async function fetchTrackedMainStageEntries({ force = false } = {}) {
  if (force) {
    mainStageLeaderboardCache.clear();
  }

  const entries = [];
  const seen = new Set();

  for (
    let page = 1;
    page <= MOVERS_MAX_LEADERBOARD_PAGES;
    page += 1
  ) {
    const result = await fetchMainStageLeaderboard(page);

    result.data.forEach((drop, index) => {
      const compact = compactMainStageTrackingEntry(
        drop,
        (page - 1) * MAIN_STAGE_PAGE_SIZE + index
      );

      if (!compact.id || seen.has(compact.id)) return;
      seen.add(compact.id);
      entries.push(compact);
    });

    if (!result.has_more) break;
  }

  return entries.sort(
    (a, b) =>
      (a.rank || Number.MAX_SAFE_INTEGER) -
      (b.rank || Number.MAX_SAFE_INTEGER)
  );
}

function pruneMoverSnapshots(now) {
  while (
    mainStageMoverSnapshots.length > 1 &&
    now - mainStageMoverSnapshots[0].captured_at >
      MOVERS_RETENTION_MS
  ) {
    mainStageMoverSnapshots.shift();
  }
}

function compareMainStageSnapshots(current, baseline) {
  const baselineMap = new Map(
    baseline.entries.map((entry) => [entry.id, entry])
  );

  return current.map((entry) => {
    const previous = baselineMap.get(entry.id);

    if (!previous) {
      return {
        ...entry,
        status: "new",
        previous_rank: null,
        rank_change: 0,
        voting_tdh_change: 0,
      };
    }

    return {
      ...entry,
      status: "tracked",
      previous_rank: previous.rank,
      rank_change:
        previous.rank && entry.rank
          ? previous.rank - entry.rank
          : 0,
      voting_tdh_change:
        entry.voting_tdh !== null &&
        previous.voting_tdh !== null
          ? entry.voting_tdh - previous.voting_tdh
          : null,
    };
  });
}

async function buildMainStageMovers({ force = false } = {}) {
  const now = Date.now();
  const currentEntries = await fetchTrackedMainStageEntries({
    force,
  });

  pruneMoverSnapshots(now);

  if (!mainStageMoverSnapshots.length) {
    mainStageMoverSnapshots.push({
      captured_at: now,
      entries: currentEntries,
    });
  } else {
    const latest =
      mainStageMoverSnapshots[mainStageMoverSnapshots.length - 1];

    if (
      now - latest.captured_at >= MOVERS_SNAPSHOT_INTERVAL_MS
    ) {
      mainStageMoverSnapshots.push({
        captured_at: now,
        entries: currentEntries,
      });
    }
  }

  pruneMoverSnapshots(now);

  const baseline = mainStageMoverSnapshots[0];
  const compared = compareMainStageSnapshots(
    currentEntries,
    baseline
  );

  const movers = compared
    .filter(
      (entry) =>
        entry.status === "new" ||
        entry.rank_change !== 0 ||
        (
          entry.voting_tdh_change !== null &&
          entry.voting_tdh_change !== 0
        )
    )
    .sort((a, b) => {
      if (a.status === "new" && b.status !== "new") return -1;
      if (b.status === "new" && a.status !== "new") return 1;

      const rankMagnitude =
        Math.abs(b.rank_change) - Math.abs(a.rank_change);
      if (rankMagnitude !== 0) return rankMagnitude;

      const tdhMagnitude =
        Math.abs(b.voting_tdh_change || 0) -
        Math.abs(a.voting_tdh_change || 0);
      if (tdhMagnitude !== 0) return tdhMagnitude;

      return (a.rank || 999999) - (b.rank || 999999);
    })
    .slice(0, 50);

  const trackingAge = Math.max(0, now - baseline.captured_at);

  return {
    movers,
    current_entries: compared.slice(0, 20),
    entries_tracked: currentEntries.length,
    rank_movers_count: compared.filter(
      (entry) => entry.rank_change !== 0
    ).length,
    tdh_gainers_count: compared.filter(
      (entry) =>
        entry.voting_tdh_change !== null &&
        entry.voting_tdh_change > 0
    ).length,
    has_comparison: trackingAge >= 30_000,
    baseline_at: new Date(baseline.captured_at).toISOString(),
    tracking_age_ms: trackingAge,
    snapshot_count: mainStageMoverSnapshots.length,
    warnings: [],
    tracking_note:
      "Mover history is stored in server memory and resets after a restart or redeploy.",
    generated_at: new Date(now).toISOString(),
  };
}

function compactHotWave(wave) {
  const creator =
    wave?.creator ||
    wave?.author ||
    wave?.created_by ||
    {};

  return {
    id: stringValue(wave?.id, wave?.wave_id),
    name: stringValue(wave?.name, wave?.title) || "Unnamed Wave",
    pfp: proxiedPfpUrl(
      stringValue(wave?.pfp, wave?.picture, wave?.image)
    ),
    creator_handle: stringValue(
      creator?.handle,
      creator?.name,
      creator?.primary_address
    ),
    last_drop_time:
      wave?.last_drop_time ??
      wave?.last_activity_at ??
      wave?.updated_at ??
      null,
    subscribers_count:
      nullableNumber(
        wave?.subscribers_count,
        wave?.followers_count
      ) || 0,
    total_drops_count:
      nullableNumber(
        wave?.total_drops_count,
        wave?.drops_count
      ) || 0,
  };
}

async function fetchHotWaves() {
  const url = new URL(`${API_BASE}/v2/waves`);
  url.searchParams.set("view", "HOT");
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "12");

  const payload = await fetchJson(url, 20_000);
  return extractList(payload, ["data", "waves"])
    .map(compactHotWave)
    .filter((wave) => wave.id);
}


function responseCount(payload) {
  return optionalNumberValue(
    payload?.count,
    payload?.data?.count,
    payload?.total,
    payload?.data?.total
  );
}

function responseNext(payload) {
  return (
    payload?.next ??
    payload?.data?.next ??
    payload?.next_page ??
    payload?.data?.next_page ??
    null
  );
}

function wavePageItems(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.waves)) return payload.waves;
  if (Array.isArray(payload?.data?.waves)) return payload.data.waves;
  return [];
}

function wavePageHasNext(payload) {
  const next = responseNext(payload);

  if (typeof next === "boolean") return next;
  if (typeof next === "string") return next.trim().length > 0;
  return false;
}

async function fetchWavePage(page, pageSize, includeView = true) {
  const url = new URL(`${API_BASE}/v2/waves`);

  if (includeView) {
    url.searchParams.set("view", "SEARCH");
  }

  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(pageSize));
  url.searchParams.set("direct_message", "false");

  const payload = await fetchJson(url, 30_000);
  const waves = wavePageItems(payload);

  if (!Array.isArray(waves)) {
    throw new Error("The Waves response did not include a list.");
  }

  return {
    payload,
    waves,
    has_more: wavePageHasNext(payload),
  };
}

async function selectWavePaginationVariant() {
  const variants = [
    { page_size: 100, include_view: true },
    { page_size: 50, include_view: true },
    { page_size: 20, include_view: true },
    { page_size: 20, include_view: false },
  ];

  const errors = [];

  for (const variant of variants) {
    try {
      const firstPage = await fetchWavePage(
        1,
        variant.page_size,
        variant.include_view
      );

      return {
        ...variant,
        first_page: firstPage,
      };
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  throw new Error(
    `Unable to load public Waves. ${errors.join(" | ")}`
  );
}

async function fetchTotalWaves({ force = false } = {}) {
  const now = Date.now();

  if (
    !force &&
    totalWavesCache &&
    now - totalWavesCache.saved_at <
      TOTAL_WAVES_CACHE_TTL_MS
  ) {
    return totalWavesCache.value;
  }

  const variant = await selectWavePaginationVariant();
  const seen = new Set();
  let fallbackCount = 0;
  let previousPageSignature = "";

  for (
    let page = 1;
    page <= EXPLORE_TOTAL_WAVES_MAX_PAGES;
    page += 1
  ) {
    const result =
      page === 1
        ? variant.first_page
        : await fetchWavePage(
            page,
            variant.page_size,
            variant.include_view
          );

    const pageKeys = [];

    for (let index = 0; index < result.waves.length; index += 1) {
      const wave = result.waves[index];
      const id = stringValue(
        wave?.id,
        wave?.wave_id,
        wave?.serial_no
      );

      if (id) {
        seen.add(id);
        pageKeys.push(id);
      } else {
        fallbackCount += 1;
        pageKeys.push(`page-${page}-row-${index}`);
      }
    }

    const signature = pageKeys.join("|");

    if (
      page > 1 &&
      signature &&
      signature === previousPageSignature
    ) {
      throw new Error(
        "The Waves API repeated a page instead of advancing."
      );
    }

    previousPageSignature = signature;

    if (!result.waves.length || !result.has_more) {
      const total = seen.size + fallbackCount;

      totalWavesCache = {
        saved_at: Date.now(),
        value: total,
      };

      return total;
    }
  }

  throw new Error(
    "The public Wave count exceeded the safe pagination limit."
  );
}

async function fetchNetworkNerdCount({
  collector = "",
  sort = "level",
  sortDirection = "DESC",
  tdhView = "boosted",
} = {}) {
  const url = new URL(`${API_BASE}/tdh/consolidated_metrics`);
  url.searchParams.set("page", "1");
  url.searchParams.set("page_size", "1");
  url.searchParams.set("sort", sort);
  url.searchParams.set("sort_direction", sortDirection);

  if (collector) {
    url.searchParams.set("collector", collector);
  }

  if (tdhView) {
    url.searchParams.set("tdh_view", tdhView);
  }

  const payload = await fetchJson(url, 25_000);
  const count = responseCount(payload);

  if (count === null) {
    throw new Error(
      "The Network Nerd response did not include a total count."
    );
  }

  return count;
}

async function fetchTotalIdentities() {
  return fetchNetworkNerdCount();
}

async function fetchFullSetHolders() {
  return fetchNetworkNerdCount({
    collector: "Meme SZN Set",
  });
}

function responseHasMore(payload, rowCount = 0, pageSize = 0) {
  const next = responseNext(payload);

  if (typeof next === "boolean") return next;
  if (typeof next === "string") return next.trim().length > 0;
  if (typeof next === "number") return Number.isFinite(next) && next > 0;
  return pageSize > 0 && rowCount >= pageSize;
}

function normalizeDailyBuzzIdentity(row, index = 0, extras = {}) {
  const profile = identityProfileFromPayload(row || {});
  const handle = stringValue(
    extras.handle,
    profile.handle,
    row?.profile_handle,
    row?.identity_handle,
    row?.recipient_handle,
    row?.display_name,
    row?.name
  ).replace(/^@/, "");
  const primaryAddress = stringValue(
    extras.primary_address,
    profile.primary_address,
    row?.wallet_address,
    row?.address
  );
  const consolidationKey = stringValue(
    extras.consolidation_key,
    row?.consolidation_key,
    row?.profile?.consolidation_key,
    row?.identity?.consolidation_key,
    row?.recipient?.consolidation_key
  );
  const pfp = stringValue(
    extras.pfp,
    profile.pfp,
    row?.pfp,
    row?.profile?.pfp,
    row?.identity?.pfp,
    row?.community_member?.pfp,
    row?.profile_image,
    row?.profile_image_url,
    row?.profile?.profile_image,
    row?.profile?.profile_image_url,
    row?.avatar,
    row?.avatar_url,
    row?.profile?.avatar,
    row?.profile?.avatar_url,
    row?.picture,
    row?.picture_url,
    row?.profile?.picture,
    row?.profile?.picture_url,
    row?.image,
    row?.image_url,
    row?.profile?.image,
    row?.profile?.image_url
  );
  const level = optionalNumberValue(
    extras.level,
    row?.level,
    row?.profile?.level,
    row?.identity?.level,
    findNumberByKeys(row, new Set(["level", "profile_level"]))
  );
  const tdh = optionalNumberValue(
    extras.tdh,
    profile.tdh,
    row?.tdh,
    row?.boosted_tdh,
    row?.total_tdh,
    findNumberByKeys(
      row,
      new Set(["tdh", "boosted_tdh", "total_tdh", "combined_tdh"])
    )
  );
  const rep = optionalNumberValue(extras.rep);
  const key = stringValue(
    extras.key,
    consolidationKey,
    primaryAddress,
    handle,
    row?.id,
    `row-${index}`
  ).toLowerCase();

  return {
    key,
    handle,
    primary_address: primaryAddress,
    consolidation_key: consolidationKey,
    pfp,
    level,
    tdh,
    rep,
  };
}

async function enrichDailyBuzzIdentities(identities) {
  return mapWithConcurrency(
    identities,
    IDENTITY_LOOKUP_CONCURRENCY,
    async (identity) => {
      if (!identity?.primary_address || (identity.handle && identity.pfp)) {
        return identity;
      }

      const profile = await fetchIdentityProfile(identity.primary_address);
      if (!profile) return identity;

      return {
        ...identity,
        handle: identity.handle || profile.handle,
        primary_address:
          profile.primary_address || identity.primary_address,
        pfp: identity.pfp || profile.pfp,
        tdh: optionalNumberValue(identity.tdh, profile.tdh),
      };
    }
  );
}

function publicDailyBuzzIdentity(identity) {
  const address = stringValue(identity?.primary_address).toLowerCase();
  const handle = stringValue(identity?.handle).replace(/^@/, "").toLowerCase();
  const cachedIdentity = address
    ? identityProfileCache.get(address)?.value
    : null;
  const cachedMembers = [
    ...arrayValue(enrichedMemberCache.value?.members),
    ...arrayValue(memberCache.value?.members),
  ];
  const cachedMember = cachedMembers.find((member) => {
    const memberAddress = stringValue(member?.primary_address).toLowerCase();
    const memberHandle = stringValue(member?.handle)
      .replace(/^@/, "")
      .toLowerCase();
    return (
      (address && memberAddress === address) ||
      (handle && memberHandle === handle)
    );
  });

  return {
    ...identity,
    handle: stringValue(
      identity?.handle,
      cachedIdentity?.handle,
      cachedMember?.handle
    ).replace(/^@/, ""),
    primary_address: stringValue(
      identity?.primary_address,
      cachedIdentity?.primary_address,
      cachedMember?.primary_address
    ),
    pfp: proxiedPfpUrl(
      stringValue(
        identity?.pfp,
        cachedIdentity?.pfp,
        cachedMember?.pfp
      )
    ),
    level:
      optionalNumberValue(identity?.level, cachedMember?.level),
    tdh:
      optionalNumberValue(
        identity?.tdh,
        cachedIdentity?.tdh,
        cachedMember?.tdh
      ),
  };
}

function dailyBuzzMetricVariants(metric) {
  if (metric === "million_tdh_identities") {
    return [
      { sort: "tdh", sort_direction: "DESC", tdh_view: "boosted" },
      { sort: "TDH", sort_direction: "DESC", tdh_view: "BOOSTED" },
      { sort: "tdh", sort_direction: "desc", tdh_view: "" },
    ];
  }

  return [
    { sort: "level", sort_direction: "DESC", tdh_view: "boosted" },
    { sort: "LEVEL", sort_direction: "DESC", tdh_view: "BOOSTED" },
    { sort: "tdh", sort_direction: "DESC", tdh_view: "boosted" },
  ];
}

async function fetchConsolidatedMetricIdentityPage(
  metric,
  page,
  pageSize
) {
  const errors = [];

  for (const variant of dailyBuzzMetricVariants(metric)) {
    try {
      const url = new URL(`${API_BASE}/tdh/consolidated_metrics`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("page_size", String(pageSize));
      url.searchParams.set("sort", variant.sort);
      url.searchParams.set("sort_direction", variant.sort_direction);

      if (variant.tdh_view) {
        url.searchParams.set("tdh_view", variant.tdh_view);
      }

      if (metric === "full_set_holders") {
        url.searchParams.set("collector", "Meme SZN Set");
      }

      const payload = await fetchJson(url, 25_000);
      const rawRows = extractList(payload, ["data", "items", "metrics"]);
      let rows = rawRows;
      let stoppedAtThreshold = false;

      if (metric === "million_tdh_identities") {
        const matching = [];

        for (const row of rawRows) {
          const tdh = optionalNumberValue(
            row?.tdh,
            row?.boosted_tdh,
            row?.total_tdh,
            memberTdh(row)
          );

          if (tdh !== null && tdh >= MILLION_TDH_THRESHOLD) {
            matching.push(row);
          } else {
            stoppedAtThreshold = true;
            break;
          }
        }

        rows = matching;
      }

      const normalizedIdentities = rows.map((row, index) =>
        normalizeDailyBuzzIdentity(
          row,
          (page - 1) * pageSize + index
        )
      );
      const enrichedIdentities = await enrichDailyBuzzIdentities(
        normalizedIdentities
      );
      const identities = enrichedIdentities.map(publicDailyBuzzIdentity);

      let total = responseCount(payload);

      if (metric === "million_tdh_identities") {
        const cachedTotal = optionalNumberValue(
          exploreDashboardCache?.value?.daily_buzz?.million_tdh_identities
        );
        total =
          cachedTotal !== null
            ? cachedTotal
            : await fetchMillionTdhIdentities();
      }

      return {
        metric,
        page,
        page_size: pageSize,
        total,
        identities,
        has_more:
          !stoppedAtThreshold &&
          responseHasMore(payload, rawRows.length, pageSize),
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(
    `Unable to load identities for ${metric}. ${errors.join(" | ").slice(0, 1200)}`
  );
}

async function buildDailyBuzzIdentityPage(
  metric,
  { page = 1, pageSize = DAILY_BUZZ_IDENTITY_PAGE_SIZE, force = false } = {}
) {
  const supported = new Set([
    "total_identities",
    "full_set_holders",
    "million_tdh_identities",
  ]);

  if (!supported.has(metric)) {
    throw new Error("Unknown Daily Buzz metric.");
  }

  const cacheKey = `${metric}:${page}:${pageSize}`;
  const cached = dailyBuzzIdentityPageCache.get(cacheKey);

  if (
    !force &&
    cached &&
    Date.now() - cached.saved_at < DAILY_BUZZ_IDENTITY_CACHE_TTL_MS
  ) {
    return cached.value;
  }

  const value = await fetchConsolidatedMetricIdentityPage(
    metric,
    page,
    pageSize
  );

  dailyBuzzIdentityPageCache.set(cacheKey, {
    saved_at: Date.now(),
    value,
  });

  return value;
}

async function countMillionTdhWithVariant(variant) {
  let count = 0;

  for (
    let page = 1;
    page <= EXPLORE_TDH_MAX_PAGES;
    page += 1
  ) {
    const url = new URL(`${API_BASE}/tdh/consolidated_metrics`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "100");
    url.searchParams.set("sort", variant.sort);
    url.searchParams.set(
      "sort_direction",
      variant.sort_direction
    );

    if (variant.tdh_view) {
      url.searchParams.set("tdh_view", variant.tdh_view);
    }

    const payload = await fetchJson(url, 25_000);
    const identities = extractList(payload, [
      "data",
      "items",
      "metrics",
    ]);

    if (!identities.length) break;

    let reachedBelowThreshold = false;

    for (const identity of identities) {
      const tdh = optionalNumberValue(
        identity?.tdh,
        identity?.boosted_tdh,
        identity?.total_tdh
      );

      if (tdh === null) continue;

      if (tdh >= MILLION_TDH_THRESHOLD) {
        count += 1;
      } else {
        reachedBelowThreshold = true;
        break;
      }
    }

    if (
      reachedBelowThreshold ||
      !responseNext(payload)
    ) {
      break;
    }
  }

  return count;
}

async function fetchMillionTdhIdentities() {
  const variants = [
    {
      sort: "tdh",
      sort_direction: "DESC",
      tdh_view: "boosted",
    },
    {
      sort: "TDH",
      sort_direction: "DESC",
      tdh_view: "BOOSTED",
    },
    {
      sort: "tdh",
      sort_direction: "desc",
      tdh_view: "",
    },
  ];

  const errors = [];

  for (const variant of variants) {
    try {
      return await countMillionTdhWithVariant(variant);
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  throw new Error(
    `Unable to count 1M TDH identities. ${errors.join(" | ")}`
  );
}

async function buildExploreDashboard({ force = false } = {}) {
  if (
    !force &&
    exploreDashboardCache &&
    Date.now() - exploreDashboardCache.saved_at <
      EXPLORE_CACHE_TTL_MS
  ) {
    return exploreDashboardCache.value;
  }

  if (force) {
    exploreDashboardCache = null;
    dailyBuzzIdentityPageCache.clear();
  }

  const sources = [
    ["Wave Radar", fetchHotWaves()],
    ["Total Identities", fetchTotalIdentities()],
    ["Full Set Holders", fetchFullSetHolders()],
    ["1M TDH Identities", fetchMillionTdhIdentities()],
  ];

  const results = await Promise.allSettled(
    sources.map(([, promise]) => promise)
  );

  const warnings = [];

  results.forEach((result, index) => {
    if (result.status !== "rejected") return;

    const label = sources[index][0];
    const message =
      result.reason instanceof Error
        ? result.reason.message
        : String(result.reason);

    warnings.push(`${label}: ${message}`);
  });

  const value = {
    hot_waves:
      results[0].status === "fulfilled"
        ? results[0].value
        : [],
    daily_buzz: {
      total_identities:
        results[1].status === "fulfilled"
          ? results[1].value
          : null,
      full_set_holders:
        results[2].status === "fulfilled"
          ? results[2].value
          : null,
      million_tdh_identities:
        results[3].status === "fulfilled"
          ? results[3].value
          : null,
    },
    warnings,
    generated_at: new Date().toISOString(),
  };

  exploreDashboardCache = {
    saved_at: Date.now(),
    value,
  };

  return value;
}

function mainStageVotingTdh(drop) {
  return optionalNumberValue(
    drop?.submission_context?.voting?.current_calculated_vote,
    drop?.submission_context?.voting?.total_votes_given,
    drop?._voting_tdh,
    drop?.rating,
    drop?.realtime_rating,
    drop?._leaderboard_score,
    drop?.submission_context?.rating,
    drop?.score,
    drop?.rating_prediction,
    drop?.submission_context?.score
  );
}

function compactMainStageDrop(drop, index, page) {
  const fallbackRank =
    (page - 1) * MAIN_STAGE_PAGE_SIZE + index + 1;

  return {
    ...drop,
    wave_id: MAIN_STAGE_WAVE_ID,
    wave: {
      ...(drop?.wave || {}),
      id: MAIN_STAGE_WAVE_ID,
      name: MAIN_STAGE_WAVE_NAME,
    },
    _leaderboard_rank:
      optionalNumberValue(
        drop?.submission_context?.voting?.place,
        drop?.rank,
        drop?.submission_context?.rank
      ) || fallbackRank,
    _voting_tdh: mainStageVotingTdh(drop),
    _leaderboard_score: mainStageVotingTdh(drop),
  };
}

async function fetchMainStageLeaderboard(page) {
  const cacheKey = String(page);
  const cached = mainStageLeaderboardCache.get(cacheKey);

  if (
    cached &&
    Date.now() - cached.savedAt < MAIN_STAGE_CACHE_TTL_MS
  ) {
    return cached.value;
  }

  const url = new URL(
    `${API_BASE}/v2/waves/${MAIN_STAGE_WAVE_ID}/leaderboard`
  );
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(MAIN_STAGE_PAGE_SIZE));
  url.searchParams.set("sort", "RANK");
  url.searchParams.set("sort_direction", "ASC");

  const payload = await fetchJson(url, 20_000);
  const drops = extractList(payload, ["drops"]);

  const data = drops
    .map((drop, index) =>
      compactMainStageDrop(drop, index, page)
    )
    .sort((a, b) => {
      const rankA = numberValue(a?._leaderboard_rank);
      const rankB = numberValue(b?._leaderboard_rank);

      if (rankA !== rankB) return rankA - rankB;

      return (
        numberValue(b?._voting_tdh) -
        numberValue(a?._voting_tdh)
      );
    });

  const value = {
    data,
    page,
    count: numberValue(payload?.count, payload?.total, data.length),
    has_more: data.length >= MAIN_STAGE_PAGE_SIZE,
    wave: payload?.wave || {
      id: MAIN_STAGE_WAVE_ID,
      name: MAIN_STAGE_WAVE_NAME,
    },
    warnings: [],
    generated_at: new Date().toISOString(),
  };

  mainStageLeaderboardCache.set(cacheKey, {
    savedAt: Date.now(),
    value,
  });

  return value;
}

function compactDropText(drop) {
  const direct = stringValue(
    drop?.content,
    drop?.message,
    drop?.text,
    drop?.body
  );

  if (direct) {
    return direct.slice(0, PUNK_MAX_TEXT_LENGTH);
  }

  return arrayValue(drop?.parts)
    .map((part) =>
      stringValue(
        part?.content,
        part?.text,
        part?.message,
        part?.body,
        typeof part === "string" ? part : ""
      )
    )
    .filter(Boolean)
    .join("\n\n")
    .slice(0, PUNK_MAX_TEXT_LENGTH);
}

function compactDropMediaCount(drop) {
  let count = arrayValue(drop?.media).length;

  for (const part of arrayValue(drop?.parts)) {
    if (part?.media_url || part?.url) count += 1;
    count += arrayValue(part?.media).length;
  }

  return count;
}

function compactPunkDrop(drop, displayAuthor) {
  return {
    id: stringValue(drop?.id, drop?.drop_id),
    drop_id: stringValue(drop?.drop_id),
    serial_no: stringValue(drop?.serial_no, drop?.serial),
    created_at:
      drop?.created_at ??
      drop?.createdAt ??
      drop?.timestamp ??
      drop?.created ??
      null,
    title: stringValue(drop?.title),
    content: compactDropText(drop),
    drop_type: stringValue(drop?.drop_type, drop?.type) || "POST",
    wave_id: stringValue(
      drop?.wave?.id,
      drop?.wave_id,
      drop?.wave?.wave_id
    ),
    wave: {
      id: stringValue(
        drop?.wave?.id,
        drop?.wave_id,
        drop?.wave?.wave_id
      ),
      name: stringValue(
        drop?.wave?.name,
        drop?.wave_name,
        drop?.wave?.title,
        drop?.wave_id
      ) || "Unknown Wave",
    },
    _media_count: compactDropMediaCount(drop),
    _display_author: displayAuthor,
  };
}

function punkUtcDayKey(drop) {
  const timestamp = dropTimestamp(drop);
  return timestamp
    ? new Date(timestamp).toISOString().slice(0, 10)
    : "unknown";
}

async function fetchPunkAuthorBatch(serialNoLessThan = null) {
  const cacheKey =
    serialNoLessThan === null ? "latest" : String(serialNoLessThan);
  const cached = punkAuthorBatchCache.get(cacheKey);

  if (cached && Date.now() - cached.savedAt < PUNK_CACHE_TTL_MS) {
    return cached.value;
  }

  const url = new URL(`${API_BASE}/drops`);
  url.searchParams.set("author", PUNK_HANDLE);
  url.searchParams.set("limit", String(PUNK_AUTHOR_BATCH_LIMIT));
  url.searchParams.set("include_replies", "true");

  if (serialNoLessThan !== null) {
    url.searchParams.set(
      "serial_no_less_than",
      String(serialNoLessThan)
    );
  }

  const payload = await fetchJson(url, 20_000);
  const drops = extractList(payload, ["drops"]);

  punkAuthorBatchCache.set(cacheKey, {
    savedAt: Date.now(),
    value: drops,
  });

  while (punkAuthorBatchCache.size > PUNK_AUTHOR_BATCH_CACHE_MAX) {
    const oldestKey = punkAuthorBatchCache.keys().next().value;
    punkAuthorBatchCache.delete(oldestKey);
  }

  return drops;
}

async function buildPunkPosts(page) {
  const cacheKey = String(page);
  const cached = punkPostsCache.get(cacheKey);

  if (cached && Date.now() - cached.savedAt < PUNK_CACHE_TTL_MS) {
    return cached.value;
  }

  const identity = await fetchPunkIdentity();
  const selectedDayStart =
    (page - 1) * PUNK_COMPLETE_DAYS_PER_BATCH;
  const selectedDayEnd =
    selectedDayStart + PUNK_COMPLETE_DAYS_PER_BATCH;
  const requiredDatedDays = selectedDayEnd + 1;

  const allDrops = [];
  const seen = new Set();
  const discoveredDays = [];
  const discoveredDaySet = new Set();
  const warnings = [];
  let serialAnchor = null;
  let reachedEnd = false;
  let completedBoundary = false;
  let requestsMade = 0;

  for (
    let requestIndex = 0;
    requestIndex < PUNK_AUTHOR_MAX_REQUESTS;
    requestIndex += 1
  ) {
    requestsMade += 1;

    let batch;

    try {
      batch = await fetchPunkAuthorBatch(serialAnchor);
    } catch (error) {
      warnings.push(
        error instanceof Error ? error.message : String(error)
      );
      break;
    }

    if (!batch.length) {
      reachedEnd = true;
      break;
    }

    let minimumSerial = null;

    for (const drop of batch) {
      const id = stringValue(
        drop?.id,
        drop?.drop_id,
        drop?.serial_no,
        `${dropTimestamp(drop)}:${allDrops.length}`
      );

      if (seen.has(id)) continue;
      seen.add(id);

      const dayKey = punkUtcDayKey(drop);

      if (!discoveredDaySet.has(dayKey)) {
        discoveredDaySet.add(dayKey);
        discoveredDays.push(dayKey);
      }

      const datedDays = discoveredDays.filter(
        (key) => key !== "unknown"
      );

      if (datedDays.length >= requiredDatedDays) {
        completedBoundary = true;
        break;
      }

      allDrops.push(drop);

      const serial = numberValue(drop?.serial_no, drop?.serial);
      if (serial > 0) {
        minimumSerial =
          minimumSerial === null
            ? serial
            : Math.min(minimumSerial, serial);
      }
    }

    if (completedBoundary) break;

    if (batch.length < PUNK_AUTHOR_BATCH_LIMIT) {
      reachedEnd = true;
      break;
    }

    if (minimumSerial === null || minimumSerial <= 1) {
      reachedEnd = true;
      break;
    }

    serialAnchor = minimumSerial;
  }

  if (!allDrops.length && warnings.length) {
    throw new Error(warnings.join(" | ").slice(0, 1200));
  }

  const selectedDayKeys = discoveredDays
    .filter((key) => key !== "unknown")
    .slice(selectedDayStart, selectedDayEnd);
  const selectedDaySet = new Set(selectedDayKeys);

  const displayAuthor = {
    handle: identity.handle || PUNK_HANDLE,
    primary_address: identity.primary_address || "",
    pfp: proxiedPfpUrl(identity.pfp || ""),
  };

  const data = allDrops
    .filter((drop) => selectedDaySet.has(punkUtcDayKey(drop)))
    .map((drop) => compactPunkDrop(drop, displayAuthor))
    .sort((a, b) => dropTimestamp(b) - dropTimestamp(a));

  const hasMore =
    completedBoundary ||
    (!reachedEnd &&
      requestsMade >= PUNK_AUTHOR_MAX_REQUESTS) ||
    discoveredDays.filter((key) => key !== "unknown").length >
      selectedDayEnd;

  const value = {
    data,
    page,
    matched_post_count: data.length,
    complete_days: selectedDayKeys,
    complete_day_count: selectedDayKeys.length,
    author_batches_requested: requestsMade,
    has_more: hasMore,
    warnings,
    generated_at: new Date().toISOString(),
  };

  punkPostsCache.set(cacheKey, {
    savedAt: Date.now(),
    value,
  });

  return value;
}

async function fetchPunkPosts(page) {
  const cacheKey = String(page);
  const existing = punkPostsInFlight.get(cacheKey);

  if (existing) {
    return existing;
  }

  const promise = buildPunkPosts(page).finally(() => {
    punkPostsInFlight.delete(cacheKey);
  });

  punkPostsInFlight.set(cacheKey, promise);
  return promise;
}

const PFP_ALLOWED_HOSTS = new Set([
  "media.6529.io",
  "6529.io",
  "www.6529.io",
  // Primary 6529 media CDN observed on live community member pfps.
  "d3lqz0a4bldqgf.cloudfront.net",
  "ipfs.io",
  "dweb.link",
  "gateway.pinata.cloud",
  "cloudflare-ipfs.com",
  "cf-ipfs.com",
  "nftstorage.link",
  "w3s.link",
  "arweave.net",
]);

const PFP_ALLOWED_HOST_SUFFIXES = [".arweave.net", ".ipfs.dweb.link"];

const PFP_ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

function isAllowedPfpHost(hostname) {
  const host = stringValue(hostname).toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  if (PFP_ALLOWED_HOSTS.has(host)) return true;
  return PFP_ALLOWED_HOST_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length
  );
}

function isPrivateOrLocalIp(ip) {
  const version = net.isIP(ip);
  if (!version) return true;

  if (version === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
      return true;
    }

    if (parts[0] === 0) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  const normalized = ip.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrLocalIp(normalized.slice("::ffff:".length));
  }

  return false;
}

async function assertSafePfpUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid image URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Only https image URLs are allowed.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Image URLs with credentials are not allowed.");
  }

  if (!isAllowedPfpHost(parsed.hostname)) {
    throw new Error(`Image host not allowed: ${parsed.hostname}`);
  }

  let addresses;
  try {
    addresses = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`Unable to resolve image host: ${parsed.hostname}`);
  }

  if (!addresses.length) {
    throw new Error(`Unable to resolve image host: ${parsed.hostname}`);
  }

  for (const entry of addresses) {
    if (isPrivateOrLocalIp(entry.address)) {
      throw new Error(`Image host resolves to a blocked address: ${entry.address}`);
    }
  }

  return parsed.toString();
}

function imageCandidates(value) {
  const raw = stringValue(value);
  if (!raw) return [];

  if (raw.toLowerCase().startsWith("ipfs://")) {
    const ipfsPath = raw
      .slice("ipfs://".length)
      .replace(/^ipfs\//i, "")
      .replace(/^\/+/, "");

    if (!ipfsPath) return [];

    return [
      `https://ipfs.io/ipfs/${ipfsPath}`,
      `https://dweb.link/ipfs/${ipfsPath}`,
      `https://gateway.pinata.cloud/ipfs/${ipfsPath}`,
    ];
  }

  if (/^(?:ar|arweave):\/\//i.test(raw)) {
    const arPath = raw.replace(/^(?:ar|arweave):\/\//i, "").replace(/^\/+/, "");
    if (!arPath) return [];
    return [
      `https://media.6529.io/arweave/${arPath}`,
      `https://arweave.net/${arPath}`,
    ];
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return [];
    if (!isAllowedPfpHost(url.hostname)) return [];
    return [url.toString()];
  } catch {
    return [];
  }
}

function detectImageType(buffer, headerType, sourceUrl) {
  const declared = stringValue(headerType).split(";")[0].toLowerCase();

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 6 &&
    buffer.subarray(0, 6).toString("ascii").startsWith("GIF8")
  ) {
    return "image/gif";
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  const firstText = buffer
    .subarray(0, 300)
    .toString("utf8")
    .trim()
    .toLowerCase();

  if (firstText.startsWith("<svg") || firstText.startsWith("<?xml")) {
    return "image/svg+xml";
  }

  if (declared.startsWith("image/") && declared !== "image/svg+xml") {
    return declared === "image/jpg" ? "image/jpeg" : declared;
  }

  try {
    const pathname = new URL(sourceUrl).pathname.toLowerCase();

    if (pathname.endsWith(".png")) return "image/png";
    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    if (pathname.endsWith(".gif")) return "image/gif";
    if (pathname.endsWith(".webp")) return "image/webp";
    if (pathname.endsWith(".avif")) return "image/avif";
    if (pathname.endsWith(".svg")) return "image/svg+xml";
  } catch {
    return "";
  }

  return "";
}

async function readResponseBuffer(response, maxBytes) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > maxBytes) {
    throw new Error("image too large");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > maxBytes) {
      throw new Error("invalid image size");
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // ignore cancel errors
      }
      throw new Error("image too large");
    }
    chunks.push(Buffer.from(value));
  }

  const buffer = Buffer.concat(chunks, total);
  if (!buffer.length) throw new Error("invalid image size");
  return buffer;
}

async function fetchPfpImage(source) {
  const candidates = imageCandidates(source);
  const errors = [];

  for (const candidate of candidates) {
    try {
      let currentUrl = await assertSafePfpUrl(candidate);

      for (let hop = 0; hop <= PFP_MAX_REDIRECTS; hop += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 18_000);

        try {
          const response = await fetch(currentUrl, {
            headers: {
              Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
              Referer: "https://6529.io/",
              Origin: "https://6529.io",
              "User-Agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36",
            },
            redirect: "manual",
            signal: controller.signal,
          });

          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get("location");
            if (!location) {
              errors.push(`${currentUrl}: redirect without location`);
              break;
            }

            const nextUrl = new URL(location, currentUrl).toString();
            currentUrl = await assertSafePfpUrl(nextUrl);
            if (hop === PFP_MAX_REDIRECTS) {
              errors.push(`${candidate}: too many redirects`);
            }
            continue;
          }

          if (!response.ok) {
            errors.push(`${currentUrl}: HTTP ${response.status}`);
            break;
          }

          const buffer = await readResponseBuffer(response, PFP_MAX_BYTES);
          const contentType = detectImageType(
            buffer,
            response.headers.get("content-type"),
            currentUrl
          );

          if (!contentType || contentType === "image/svg+xml") {
            errors.push(`${currentUrl}: unsupported or unsafe image type`);
            break;
          }

          if (!PFP_ALLOWED_TYPES.has(contentType)) {
            errors.push(`${currentUrl}: unrecognized image type`);
            break;
          }

          return {
            buffer,
            contentType: contentType === "image/jpg" ? "image/jpeg" : contentType,
          };
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (error) {
      errors.push(
        `${candidate}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  throw new Error(
    errors.join(" | ").slice(0, 1200) || "No usable image URL."
  );
}

async function servePfp(requestUrl, res) {
  const source = requestUrl.searchParams.get("src") || "";

  if (!source) {
    sendJson(res, 400, { error: "Missing image source." });
    return;
  }

  try {
    const image = await fetchPfpImage(source);

    res.writeHead(200, {
      "Content-Type": image.contentType,
      "Content-Length": image.buffer.length,
      "Cache-Control":
        "public, max-age=86400, stale-while-revalidate=604800",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Content-Disposition": "inline",
    });
    res.end(image.buffer);
  } catch (error) {
    console.error("PFP proxy failed:", error);
    sendJson(res, 404, { error: "Profile image could not be loaded." });
  }
}


function parseMaybeJson(value) {
  if (!value || typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function normalizeDecentralizedUrl(value) {
  const raw = stringValue(value);
  if (!raw) return "";
  if (raw.startsWith("ipfs://ipfs/")) {
    return `https://ipfs.io/ipfs/${raw.slice("ipfs://ipfs/".length)}`;
  }
  if (raw.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${raw.slice("ipfs://".length)}`;
  }
  if (raw.startsWith("ar://")) {
    return `https://arweave.net/${raw.slice("ar://".length)}`;
  }
  return raw;
}

function memeAttribute(metadata, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const attributes = [
    metadata?.attributes,
    metadata?.properties?.attributes,
    metadata?.traits,
  ].find(Array.isArray) || [];

  for (const attribute of attributes) {
    const key = stringValue(
      attribute?.trait_type,
      attribute?.traitType,
      attribute?.name,
      attribute?.key
    ).toLowerCase();
    if (!wanted.has(key)) continue;
    const value = attribute?.value ?? attribute?.trait_value ?? attribute?.val;
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return null;
}

function normalizeMemeNft(raw) {
  const metadataCandidate = parseMaybeJson(
    raw?.metadata ?? raw?.metadata_json ?? raw?.raw_metadata
  );
  const metadata =
    metadataCandidate && typeof metadataCandidate === "object"
      ? metadataCandidate
      : {};
  const media = raw?.media && !Array.isArray(raw.media) && typeof raw.media === "object" ? raw.media : {};
  const mediaList = Array.isArray(raw?.media)
    ? raw.media
    : Array.isArray(raw?.media_files)
      ? raw.media_files
      : [];
  const firstImageMedia = mediaList.find((item) =>
    String(item?.mime_type ?? item?.mimeType ?? item?.type ?? "").startsWith("image/")
  ) || mediaList.find((item) => !String(item?.mime_type ?? item?.mimeType ?? item?.type ?? "").startsWith("video/")) || {};
  const firstVideoMedia = mediaList.find((item) =>
    String(item?.mime_type ?? item?.mimeType ?? item?.type ?? "").startsWith("video/")
  ) || {};

  const tokenId = positiveInteger(
    raw?.token_id ?? raw?.tokenId ?? raw?.id ?? raw?.nft_id ?? metadata?.token_id,
    0,
    1_000_000
  );
  if (!tokenId) return null;

  const title = stringValue(
    raw?.name,
    raw?.title,
    raw?.meme_title,
    metadata?.name,
    metadata?.title,
    `The Memes #${tokenId}`
  );
  const description = stringValue(
    raw?.description,
    metadata?.description,
    metadata?.properties?.description
  );
  const artist = stringValue(
    raw?.artist,
    raw?.artist_name,
    raw?.creator,
    metadata?.artist,
    metadata?.properties?.artist,
    memeAttribute(metadata, ["artist", "created by", "creator"])
  );
  const season = optionalNumberValue(
    raw?.season,
    raw?.season_number,
    raw?.szn,
    metadata?.season,
    memeAttribute(metadata, ["season", "szn"])
  );
  const meme = optionalNumberValue(
    raw?.meme,
    raw?.meme_number,
    metadata?.meme,
    memeAttribute(metadata, ["meme", "meme number"])
  );
  const editionSize = optionalNumberValue(
    raw?.edition_size,
    raw?.editionSize,
    raw?.supply,
    raw?.total_supply,
    raw?.minted,
    metadata?.edition_size,
    metadata?.properties?.edition_size,
    memeAttribute(metadata, ["edition size", "edition_size", "supply"])
  );
  const image = normalizeDecentralizedUrl(
    stringValue(
      raw?.image,
      raw?.image_url,
      raw?.imageUrl,
      raw?.thumbnail,
      raw?.thumbnail_url,
      raw?.scaled,
      raw?.scaled_url,
      raw?.static_image,
      media?.image,
      media?.image_url,
      firstImageMedia?.url,
      firstImageMedia?.uri,
      firstImageMedia?.src,
      firstImageMedia?.image,
      metadata?.image,
      metadata?.image_url,
      metadata?.properties?.image,
      metadata?.properties?.files?.find?.((file) =>
        String(file?.type || "").startsWith("image/")
      )?.uri
    )
  );
  const animation = normalizeDecentralizedUrl(
    stringValue(
      raw?.animation,
      raw?.animation_url,
      raw?.animationUrl,
      media?.animation,
      media?.animation_url,
      firstVideoMedia?.url,
      firstVideoMedia?.uri,
      firstVideoMedia?.src,
      firstVideoMedia?.animation,
      metadata?.animation_url,
      metadata?.animation,
      metadata?.properties?.animation_url,
      metadata?.properties?.files?.find?.((file) =>
        String(file?.type || "").startsWith("video/")
      )?.uri
    )
  );

  return {
    token_id: tokenId,
    title,
    description,
    artist,
    season,
    meme,
    edition_size: editionSize,
    image,
    animation,
    official_url: `https://6529.io/the-memes/${tokenId}`,
  };
}

async function fetchMemesGallery({ force = false } = {}) {
  const now = Date.now();
  if (
    !force &&
    memesGalleryCache.value &&
    now - memesGalleryCache.savedAt < MEMES_GALLERY_CACHE_TTL_MS
  ) {
    return memesGalleryCache.value;
  }

  const rows = [];
  let reportedCount = 0;

  for (let page = 1; page <= MEMES_GALLERY_MAX_PAGES; page += 1) {
    const url = new URL(`${API_BASE}/nfts`);
    url.searchParams.set("contract", MEMES_CONTRACT);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", String(MEMES_GALLERY_PAGE_SIZE));

    const payload = await fetchJson(url, 30_000);
    const pageRows = extractList(payload, ["nfts"]);
    reportedCount = Math.max(
      reportedCount,
      numberValue(
        payload?.count,
        payload?.total,
        payload?.total_count,
        payload?.data?.count,
        payload?.data?.total
      )
    );
    rows.push(...pageRows);

    const hasNext = Boolean(
      payload?.next_uri ||
      payload?.next ||
      payload?.next_page ||
      payload?.data?.next_uri ||
      payload?.data?.next
    );
    if (!hasNext && pageRows.length < MEMES_GALLERY_PAGE_SIZE) break;
    if (reportedCount && rows.length >= reportedCount) break;
    if (!pageRows.length) break;
  }

  const deduped = new Map();
  for (const raw of rows) {
    const contract = stringValue(
      raw?.contract,
      raw?.contract_address,
      raw?.contractAddress,
      raw?.collection?.contract
    ).toLowerCase();
    if (contract && contract !== MEMES_CONTRACT) continue;
    const card = normalizeMemeNft(raw);
    if (!card) continue;
    const existing = deduped.get(card.token_id);
    if (!existing || (!existing.image && card.image)) deduped.set(card.token_id, card);
  }

  const cards = [...deduped.values()].sort(
    (a, b) => Number(b.token_id) - Number(a.token_id)
  );
  if (!cards.length) {
    throw new Error("The 6529 NFT API returned no Meme Cards.");
  }

  const value = {
    data: cards,
    count: cards.length,
    contract: MEMES_CONTRACT,
    generated_at: new Date().toISOString(),
    source: "6529 NFT API",
  };
  memesGalleryCache.savedAt = now;
  memesGalleryCache.value = value;
  return value;
}

const STATIC_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeForPath(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (path.basename(filePath) === "manifest.json") {
    return "application/manifest+json; charset=utf-8";
  }
  return STATIC_CONTENT_TYPES[extension] || "application/octet-stream";
}

function resolveStaticFile(pathname) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const relative = requestedPath.replace(/^\/+/, "");
  if (!relative || relative.includes("\0")) return null;

  const resolved = path.resolve(STATIC_ROOT, relative);
  const rootWithSep = STATIC_ROOT.endsWith(path.sep)
    ? STATIC_ROOT
    : STATIC_ROOT + path.sep;

  if (resolved !== STATIC_ROOT && !resolved.startsWith(rootWithSep)) {
    return null;
  }

  return resolved;
}

async function serveStatic(req, res, pathname) {
  const filePath = resolveStaticFile(pathname);

  if (!filePath) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (!stat.isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": contentTypeForPath(filePath),
    "Content-Length": stat.size,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  });

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`
    );

    if (requestUrl.pathname === "/healthz") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const body = JSON.stringify({ ok: true, service: "brain-buzz" });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
      return;
    }

    if (requestUrl.pathname === "/api/pfp") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      await servePfp(requestUrl, res);
      return;
    }

    if (requestUrl.pathname === "/api/memes-gallery") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      try {
        sendJson(
          res,
          200,
          await fetchMemesGallery({
            force: requestUrl.searchParams.get("refresh") === "1",
          })
        );
      } catch (error) {
        console.error("The Memes gallery failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load The Memes gallery.",
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/movers") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      try {
        sendJson(
          res,
          200,
          await buildMainStageMovers({
            force:
              requestUrl.searchParams.get("refresh") === "1",
          })
        );
      } catch (error) {
        console.error("Movers failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to build Main Stage movers.",
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/explore") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      try {
        sendJson(
          res,
          200,
          await buildExploreDashboard({
            force:
              requestUrl.searchParams.get("refresh") === "1",
          })
        );
      } catch (error) {
        console.error("Explore failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load Explore.",
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/daily-buzz-identities") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const metric = stringValue(requestUrl.searchParams.get("metric"));
      const page = positiveInteger(
        requestUrl.searchParams.get("page"),
        1,
        1000
      );
      const pageSize = positiveInteger(
        requestUrl.searchParams.get("page_size"),
        DAILY_BUZZ_IDENTITY_PAGE_SIZE,
        DAILY_BUZZ_IDENTITY_MAX_PAGE_SIZE
      );

      try {
        sendJson(
          res,
          200,
          await buildDailyBuzzIdentityPage(metric, {
            page,
            pageSize,
            force: requestUrl.searchParams.get("refresh") === "1",
          })
        );
      } catch (error) {
        console.error("Daily Buzz identity list failed:", error);
        const message =
          error instanceof Error
            ? error.message
            : "Unable to load Daily Buzz identities.";
        sendJson(res, message === "Unknown Daily Buzz metric." ? 400 : 502, {
          error: message,
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/member-profile") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const identity = stringValue(
        requestUrl.searchParams.get("identity")
      );

      if (!identity) {
        sendJson(res, 400, {
          error: "Missing member identity.",
        });
        return;
      }

      try {
        sendJson(
          res,
          200,
          await buildMemberProfile(identity, {
            force:
              requestUrl.searchParams.get("refresh") === "1",
          })
        );
      } catch (error) {
        console.error("Member profile failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load the member profile.",
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/chats") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const page = positiveInteger(
        requestUrl.searchParams.get("page"),
        1,
        10_000
      );

      try {
        sendJson(res, 200, await fetchChatFeed(page));
      } catch (error) {
        console.error("Chat feed failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load public chats.",
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/punk-posts") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const page = positiveInteger(
        requestUrl.searchParams.get("page"),
        1,
        10_000
      );

      try {
        sendJson(res, 200, await fetchPunkPosts(page));
      } catch (error) {
        console.error("Punk6529 feed failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load Punk6529 posts.",
        });
      }
      return;
    }

    if (
      requestUrl.pathname === "/api/main-stage-leaderboard"
    ) {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const page = positiveInteger(
        requestUrl.searchParams.get("page"),
        1,
        10_000
      );

      try {
        sendJson(
          res,
          200,
          await fetchMainStageLeaderboard(page)
        );
      } catch (error) {
        console.error("Main Stage leaderboard failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load the Main Stage leaderboard.",
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/top-posts") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const page = positiveInteger(
        requestUrl.searchParams.get("page"),
        1,
        10_000
      );

      try {
        sendJson(res, 200, await fetchTopPosts(page));
      } catch (error) {
        console.error("Top 100 feed failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load Top 100 posts.",
        });
      }
      return;
    }

    if (requestUrl.pathname === "/api/top-members") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      try {
        const wantsDetails =
          requestUrl.searchParams.get("details") === "1";
        const force =
          requestUrl.searchParams.get("refresh") === "1";

        if (force) {
          memberCache.savedAt = 0;
          memberCache.value = null;
          enrichedMemberCache.savedAt = 0;
          enrichedMemberCache.value = null;
        }

        const result = wantsDetails
          ? await fetchEnrichedTopMembers()
          : await fetchTopMembers();

        sendJson(res, 200, {
          data: result.members.map(publicMember),
          count: result.members.length,
          ranking: result.ranking,
          detailed: wantsDetails,
          generated_at: result.generated_at,
        });
      } catch (error) {
        console.error("Top-member request failed:", error);
        sendJson(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Unable to load Top 100 members.",
        });
      }
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    if (/^\/the-memes\/?$/.test(requestUrl.pathname)) {
      await serveStatic(req, res, "/the-memes.html");
      return;
    }

    if (/^\/member\/[^/]+\/?$/.test(requestUrl.pathname)) {
      await serveStatic(req, res, "/member-profile.html");
      return;
    }

    await serveStatic(req, res, requestUrl.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Unexpected server error." });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log("");
    console.log("Brain Buzz is running.");
    console.log(`Open: http://localhost:${PORT}`);
    console.log("Press Ctrl+C to stop it.");
    console.log("");
  });
}

module.exports = {
  normalizeMembers,
  matchDropToMember,
  makeMemberLookup,
  topMemberUrls,
  imageCandidates,
  isAllowedPfpHost,
  isPrivateOrLocalIp,
  detectImageType,
  assertSafePfpUrl,
  API_BASE,
  MEMBER_CACHE_TTL_MS,
  FEED_CACHE_TTL_MS,
};
