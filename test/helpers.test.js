"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeMembers,
  matchDropToMember,
  makeMemberLookup,
  topMemberUrls,
  imageCandidates,
  isAllowedPfpHost,
  isPrivateOrLocalIp,
  detectImageType,
  API_BASE,
  MEMBER_CACHE_TTL_MS,
  FEED_CACHE_TTL_MS,
  FEED_CACHE_MAX_ENTRIES,
  pruneTimedCache,
  isChatDrop,
} = require("../server.js");

describe("cache TTLs", () => {
  it("keeps members cached for 6 hours and feeds for 90 seconds", () => {
    assert.equal(MEMBER_CACHE_TTL_MS, 6 * 60 * 60 * 1000);
    assert.equal(FEED_CACHE_TTL_MS, 90 * 1000);
    assert.equal(FEED_CACHE_MAX_ENTRIES, 50);
  });

  it("prunes expired and excess feed-cache entries", () => {
    const cache = new Map();
    cache.set("old", { savedAt: Date.now() - FEED_CACHE_TTL_MS - 1, value: 1 });
    cache.set("a", { savedAt: Date.now(), value: 2 });
    cache.set("b", { savedAt: Date.now(), value: 3 });
    // maxEntries uses >= so one slot remains for the next write.
    pruneTimedCache(cache, FEED_CACHE_TTL_MS, 2);
    assert.equal(cache.has("old"), false);
    assert.equal(cache.size, 1);
    assert.equal(cache.has("b"), true);
  });
});

describe("isChatDrop (re-exported)", () => {
  it("matches the shared helper", () => {
    assert.equal(isChatDrop({ drop_type: "CHAT" }), true);
    assert.equal(isChatDrop({ type: "post" }), false);
  });
});

describe("topMemberUrls", () => {
  it("returns LEVEL sort variants against the 6529 top-members endpoint", () => {
    const urls = topMemberUrls();
    assert.ok(urls.length >= 4);
    for (const url of urls) {
      assert.ok(url.startsWith(`${API_BASE}/community-members/top?`));
    }
    assert.ok(urls.some((url) => /sort=LEVEL/i.test(url)));
    assert.ok(urls.some((url) => /sort=level/.test(url)));
  });
});

describe("normalizeMembers", () => {
  it("sorts by level descending, dedupes, and keeps top 100", () => {
    const raw = [
      { handle: "alpha", level: 10, primary_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { handle: "beta", level: 50, primary_address: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      { handle: "alpha", level: 12, primary_address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { handle: "gamma", level: 50, primary_address: "0xcccccccccccccccccccccccccccccccccccccccc" },
    ];

    for (let i = 0; i < 120; i += 1) {
      raw.push({
        handle: `member${i}`,
        level: i % 7,
        primary_address: `0x${String(i).padStart(40, "0")}`,
      });
    }

    const normalized = normalizeMembers(raw);
    assert.equal(normalized.length, 100);
    assert.equal(normalized[0].handle, "beta");
    assert.equal(normalized[0].rank, 1);
    assert.equal(normalized[1].handle, "gamma");
    assert.ok(normalized.every((member, index) => member.rank === index + 1));
    assert.ok(
      normalized.every(
        (member, index) =>
          index === 0 || normalized[index - 1].level >= member.level
      )
    );

    const alpha = normalized.find((member) => member.handle === "alpha");
    assert.equal(alpha.level, 12);
  });
});

describe("matchDropToMember", () => {
  it("matches drops by wallet or handle tokens", () => {
    const members = normalizeMembers([
      {
        handle: "wavequeen",
        level: 99,
        primary_address: "0xdddddddddddddddddddddddddddddddddddddddd",
      },
    ]);
    const lookup = makeMemberLookup(members);

    assert.equal(
      matchDropToMember(
        {
          author: {
            handle: "WaveQueen",
            primary_address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          },
        },
        lookup
      )?.handle,
      "wavequeen"
    );

    assert.equal(
      matchDropToMember(
        {
          author: {
            primary_address: "0xDDDDdddddddddddddddddddddddddddddddddddd",
          },
        },
        lookup
      )?.handle,
      "wavequeen"
    );

    assert.equal(
      matchDropToMember(
        { author: { handle: "nobody", primary_address: "0x1111111111111111111111111111111111111111" } },
        lookup
      ),
      null
    );
  });
});

describe("pfp allowlist helpers", () => {
  it("allows known 6529 / IPFS / Arweave hosts only", () => {
    assert.equal(isAllowedPfpHost("media.6529.io"), true);
    assert.equal(isAllowedPfpHost("d3lqz0a4bldqgf.cloudfront.net"), true);
    assert.equal(isAllowedPfpHost("ipfs.io"), true);
    assert.equal(isAllowedPfpHost("arweave.net"), true);
    assert.equal(isAllowedPfpHost("something.arweave.net"), true);
    assert.equal(isAllowedPfpHost("evil.example"), false);
    assert.equal(isAllowedPfpHost("other.cloudfront.net"), false);
    assert.equal(isAllowedPfpHost("127.0.0.1"), false);
  });

  it("builds candidates for ipfs/ar URLs and rejects unknown https hosts", () => {
    const ipfs = imageCandidates("ipfs://QmExampleHash/avatar.png");
    assert.deepEqual(ipfs, [
      "https://ipfs.io/ipfs/QmExampleHash/avatar.png",
      "https://dweb.link/ipfs/QmExampleHash/avatar.png",
      "https://gateway.pinata.cloud/ipfs/QmExampleHash/avatar.png",
    ]);

    const ar = imageCandidates("ar://abc123");
    assert.deepEqual(ar, [
      "https://media.6529.io/arweave/abc123",
      "https://arweave.net/abc123",
    ]);

    assert.deepEqual(
      imageCandidates("https://media.6529.io/pfp/one.png"),
      ["https://media.6529.io/pfp/one.png"]
    );
    assert.deepEqual(imageCandidates("https://evil.example/a.png"), []);
    assert.deepEqual(imageCandidates("http://media.6529.io/a.png"), []);
  });

  it("detects private and link-local addresses", () => {
    assert.equal(isPrivateOrLocalIp("127.0.0.1"), true);
    assert.equal(isPrivateOrLocalIp("10.0.0.5"), true);
    assert.equal(isPrivateOrLocalIp("192.168.1.1"), true);
    assert.equal(isPrivateOrLocalIp("169.254.1.1"), true);
    assert.equal(isPrivateOrLocalIp("172.16.0.1"), true);
    assert.equal(isPrivateOrLocalIp("8.8.8.8"), false);
    assert.equal(isPrivateOrLocalIp("::1"), true);
    assert.equal(isPrivateOrLocalIp("fd00::1"), true);
  });

  it("detects raster types and flags SVG", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(detectImageType(png, "application/octet-stream", "https://x/a"), "image/png");

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    assert.equal(detectImageType(jpeg, "", "https://x/a"), "image/jpeg");

    const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    assert.equal(
      detectImageType(svg, "image/svg+xml", "https://media.6529.io/a.svg"),
      "image/svg+xml"
    );
  });
});
