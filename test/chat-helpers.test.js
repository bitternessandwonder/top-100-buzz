"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  positiveInteger,
  extractDrops,
  extractList,
  isChatDrop,
  safeUrl,
} = require("../lib/helpers");

describe("positiveInteger", () => {
  it("returns fallback for invalid values", () => {
    assert.equal(positiveInteger(undefined, 7, 100), 7);
    assert.equal(positiveInteger("abc", 7, 100), 7);
    assert.equal(positiveInteger(0, 7, 100), 7);
    assert.equal(positiveInteger(-3, 7, 100), 7);
  });

  it("parses integers and caps at maximum", () => {
    assert.equal(positiveInteger("12", 1, 100), 12);
    assert.equal(positiveInteger(250, 1, 100), 100);
  });
});

describe("extractDrops / extractList", () => {
  it("returns arrays as-is", () => {
    const drops = [{ id: 1 }];
    assert.deepEqual(extractDrops(drops), drops);
  });

  it("finds nested drop arrays", () => {
    assert.deepEqual(extractDrops({ data: [{ id: 1 }] }), [{ id: 1 }]);
    assert.deepEqual(extractDrops({ drops: [{ id: 2 }] }), [{ id: 2 }]);
    assert.deepEqual(extractDrops({ data: { items: [{ id: 3 }] } }), [
      { id: 3 },
    ]);
  });

  it("honors preferred keys on extractList", () => {
    assert.deepEqual(
      extractList({ members: [{ id: 1 }], data: [{ id: 2 }] }, ["members"]),
      [{ id: 1 }]
    );
  });

  it("returns an empty array for unknown shapes", () => {
    assert.deepEqual(extractDrops(null), []);
    assert.deepEqual(extractDrops({ hello: "world" }), []);
  });
});

describe("isChatDrop", () => {
  it("detects CHAT drops case-insensitively", () => {
    assert.equal(isChatDrop({ drop_type: "CHAT" }), true);
    assert.equal(isChatDrop({ type: "chat" }), true);
    assert.equal(isChatDrop({ drop_type: "WAVE" }), false);
    assert.equal(isChatDrop({}), false);
  });
});

describe("safeUrl", () => {
  it("allows https, http, and root-relative paths", () => {
    assert.equal(safeUrl("https://media.6529.io/a.png"), "https://media.6529.io/a.png");
    assert.equal(safeUrl("http://example.com/x"), "http://example.com/x");
    assert.equal(safeUrl("/api/pfp?src=x"), "/api/pfp?src=x");
  });

  it("rejects dangerous or invalid schemes", () => {
    assert.equal(safeUrl("javascript:alert(1)"), "");
    assert.equal(safeUrl("data:text/html,hi"), "");
    assert.equal(safeUrl("//evil.example/x"), "");
    assert.equal(safeUrl("not a url"), "");
    assert.equal(safeUrl(""), "");
    assert.equal(safeUrl(null), "");
  });
});
