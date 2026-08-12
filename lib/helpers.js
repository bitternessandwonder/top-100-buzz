"use strict";

/**
 * Shared parsing helpers for Brain Buzz (and formerly 6529-chat-feed).
 * Kept dependency-free so the Node built-in test runner can exercise them.
 */

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

/** Chat-feed-compatible alias: prefer drops-shaped payloads. */
function extractDrops(payload) {
  return extractList(payload, ["drops", "items", "results"]);
}

function isChatDrop(drop) {
  return String(drop?.drop_type ?? drop?.type ?? "").toUpperCase() === "CHAT";
}

/**
 * Sanitize media / link URLs for client rendering.
 * Allows root-relative paths and http(s) only — rejects javascript:, data:, //host, etc.
 */
function safeUrl(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) {
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch {
    // Reject non-absolute and non-root-relative values.
  }

  return "";
}

module.exports = {
  positiveInteger,
  extractList,
  extractDrops,
  isChatDrop,
  safeUrl,
};
