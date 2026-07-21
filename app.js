"use strict";

const postsView = document.querySelector("#posts-view");
const membersView = document.querySelector("#members-view");
const loadingElement = document.querySelector("#loading-box");
const errorElement = document.querySelector("#error-box");
const warningElement = document.querySelector("#warning-box");
const refreshButton = document.querySelector("#refresh-button");
const loadMoreButton = document.querySelector("#load-more-button");
const loadMoreWrap = document.querySelector("#load-more-wrap");
const searchInput = document.querySelector("#search-input");
const resultCount = document.querySelector("#result-count");
const lastUpdated = document.querySelector("#last-updated");
const postTemplate = document.querySelector("#post-template");
const memberTemplate = document.querySelector("#member-template");
const tabButtons = [...document.querySelectorAll(".tab")];

const REFRESH_INTERVAL_MS = 45_000;

let activeView = "posts";
let currentPage = 0;
let hasMore = true;
let isLoading = false;
let allPosts = [];
let members = [];
let refreshTimer = null;

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function stringValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function authorName(drop) {
  const preferred = stringValue(
    drop?._top_member?.handle,
    drop?.author?.handle,
    drop?.author?.profile?.handle,
    drop?.profile?.handle,
    drop?.author_handle
  );
  if (preferred) return preferred;

  const address = stringValue(
    drop?._top_member?.primary_address,
    drop?.author?.primary_address,
    drop?.author?.address,
    drop?.signer_address
  );
  return shortenAddress(address) || "Unknown author";
}

function authorImage(drop) {
  return stringValue(
    drop?._top_member?.pfp,
    drop?.author?.pfp,
    drop?.author?.profile?.pfp,
    drop?.profile?.pfp,
    drop?.author?.image
  );
}

function waveName(drop) {
  return (
    stringValue(
      drop?.wave?.name,
      drop?.wave_name,
      drop?.wave?.title,
      drop?.wave_id
    ) || "Unknown wave"
  );
}

function extractText(drop) {
  const directText = stringValue(
    drop?.content,
    drop?.message,
    drop?.text,
    drop?.body
  );
  if (directText) return directText;

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
    .join("\n\n");
}

function extractMedia(drop) {
  const found = [];
  const seen = new Set();

  function add(url, mimeType = "") {
    if (!url || typeof url !== "string" || seen.has(url)) return;
    seen.add(url);
    found.push({ url, mimeType: String(mimeType || "") });
  }

  for (const item of arrayValue(drop?.media)) {
    add(item?.url || item?.media_url, item?.mime_type || item?.content_type);
  }

  for (const part of arrayValue(drop?.parts)) {
    add(part?.media_url || part?.url, part?.mime_type || part?.content_type);
    for (const item of arrayValue(part?.media)) {
      add(item?.url || item?.media_url, item?.mime_type || item?.content_type);
    }
  }

  return found;
}

function timestampMilliseconds(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return number < 1_000_000_000_000 ? number * 1000 : number;
  }

  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
}

function createdAt(drop) {
  return timestampMilliseconds(
    drop?.created_at ?? drop?.createdAt ?? drop?.timestamp ?? drop?.created
  );
}

function dropKey(drop, index = 0) {
  return stringValue(
    drop?.id,
    drop?.drop_id,
    drop?.serial_no,
    `${drop?._top_member?.rank}:${createdAt(drop) || "unknown"}:${extractText(drop)}:${index}`
  );
}

function serialLabel(drop) {
  const serial = stringValue(drop?.serial_no, drop?.serial, drop?.id);
  return serial ? `Drop ${serial}` : "6529 post";
}

function formatDate(milliseconds) {
  if (!milliseconds) return "Unknown time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(milliseconds));
}

function shortenAddress(value) {
  if (!value) return "";
  if (value.length > 13) return `${value.slice(0, 7)}…${value.slice(-5)}`;
  return value;
}

function initial(name) {
  return Array.from(String(name || "").trim())[0]?.toUpperCase() || "?";
}

function mergePosts(incoming, replace = false) {
  const merged = new Map();

  if (!replace) {
    allPosts.forEach((post, index) => merged.set(dropKey(post, index), post));
  }
  incoming.forEach((post, index) => merged.set(dropKey(post, index), post));

  allPosts = [...merged.values()].sort(
    (a, b) => (createdAt(b) || 0) - (createdAt(a) || 0)
  );
}

function renderMedia(container, media) {
  container.replaceChildren();

  for (const item of media) {
    const mime = item.mimeType.toLowerCase();
    const urlLower = item.url.toLowerCase();

    if (
      mime.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|avif)(\?|$)/.test(urlLower)
    ) {
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = "Media attached to this post";
      image.loading = "lazy";
      container.append(image);
      continue;
    }

    if (
      mime.startsWith("video/") ||
      /\.(mp4|webm|mov)(\?|$)/.test(urlLower)
    ) {
      const video = document.createElement("video");
      video.src = item.url;
      video.controls = true;
      video.preload = "metadata";
      container.append(video);
      continue;
    }

    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open attached media";
    container.append(link);
  }
}

function renderPosts() {
  const query = searchInput.value.trim().toLowerCase();
  const visible = query
    ? allPosts.filter((drop) => {
        const member = drop?._top_member || {};
        const searchable = [
          authorName(drop),
          waveName(drop),
          stringValue(drop?.title),
          extractText(drop),
          member?.rank,
          member?.level,
          drop?.drop_type,
        ]
          .join(" ")
          .toLowerCase();
        return searchable.includes(query);
      })
    : allPosts;

  postsView.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = allPosts.length
      ? "No loaded posts match that filter."
      : "No matching public posts were found in the scanned pages.";
    postsView.append(empty);
  } else {
    const fragment = document.createDocumentFragment();

    visible.forEach((drop) => {
      const card = postTemplate.content.firstElementChild.cloneNode(true);
      const member = drop?._top_member || {};
      const name = authorName(drop);
      const imageUrl = authorImage(drop);
      const text = extractText(drop);
      const title = stringValue(drop?.title);
      const rank = Number(member?.rank) || "?";
      const level = Number(member?.level) || 0;

      card.querySelector(".rank-badge").textContent = `#${rank}`;

      const avatar = card.querySelector(".avatar");
      if (imageUrl) {
        const image = document.createElement("img");
        image.src = imageUrl;
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => {
          avatar.replaceChildren(initial(name));
        });
        avatar.append(image);
      } else {
        avatar.textContent = initial(name);
      }

      card.querySelector(".author").textContent = name;
      card.querySelector(".member-meta").textContent = `Level ${level}`;

      const time = card.querySelector(".time");
      const timeValue = createdAt(drop);
      time.textContent = formatDate(timeValue);
      if (timeValue) time.dateTime = new Date(timeValue).toISOString();

      card.querySelector(".wave-line").textContent = `Wave: ${waveName(drop)}`;

      const titleElement = card.querySelector(".title");
      if (title) {
        titleElement.textContent = title;
        titleElement.classList.remove("hidden");
      }

      const message = card.querySelector(".message");
      message.textContent = text || "[Media attachment or empty post]";
      if (!text) message.classList.add("empty");

      renderMedia(card.querySelector(".media"), extractMedia(drop));
      card.querySelector(".serial").textContent = serialLabel(drop);
      card.querySelector(".type-badge").textContent =
        stringValue(drop?.drop_type, drop?.type) || "POST";

      fragment.append(card);
    });

    postsView.append(fragment);
  }

  resultCount.textContent =
    query && visible.length !== allPosts.length
      ? `${visible.length} of ${allPosts.length} posts`
      : `${allPosts.length} ${allPosts.length === 1 ? "post" : "posts"}`;
}

function memberDisplayName(member) {
  return (
    stringValue(member?.handle) ||
    shortenAddress(stringValue(member?.primary_address)) ||
    "Unknown member"
  );
}

function renderMembers() {
  const query = searchInput.value.trim().toLowerCase();
  const visible = query
    ? members.filter((member) =>
        [
          memberDisplayName(member),
          member?.rank,
          member?.level,
          member?.primary_address,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)
      )
    : members;

  membersView.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = members.length
      ? "No members match that filter."
      : "The member ranking has not loaded.";
    membersView.append(empty);
  } else {
    const fragment = document.createDocumentFragment();

    visible.forEach((member) => {
      const card = memberTemplate.content.firstElementChild.cloneNode(true);
      const name = memberDisplayName(member);

      card.querySelector(".member-rank").textContent = `#${member.rank}`;

      const avatar = card.querySelector(".member-avatar");
      if (member.pfp) {
        const image = document.createElement("img");
        image.src = member.pfp;
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => {
          avatar.replaceChildren(initial(name));
        });
        avatar.append(image);
      } else {
        avatar.textContent = initial(name);
      }

      card.querySelector(".member-name").textContent = name;
      card.querySelector(".member-level").textContent = `Level ${member.level}`;
      card.querySelector(".member-address").textContent =
        shortenAddress(member.primary_address) || "No public address shown";

      fragment.append(card);
    });

    membersView.append(fragment);
  }

  resultCount.textContent =
    query && visible.length !== members.length
      ? `${visible.length} of ${members.length} members`
      : `${members.length} members`;
}

function renderActiveView() {
  if (activeView === "members") renderMembers();
  else renderPosts();
}

function setLoading(value, loadingOlder = false) {
  isLoading = value;
  refreshButton.disabled = value;
  loadMoreButton.disabled = value;
  refreshButton.textContent = value && !loadingOlder ? "Refreshing…" : "Refresh";
  loadMoreButton.textContent =
    value && loadingOlder ? "Scanning…" : "Scan older posts";

  if (!allPosts.length && value) loadingElement.classList.remove("hidden");
  else loadingElement.classList.add("hidden");
}

function showError(error) {
  const message =
    error instanceof Error ? error.message : "Something went wrong loading the feed.";

  errorElement.textContent =
    `${message}\n\nThe 6529 API may be temporarily unavailable or its fields may have changed.`;
  errorElement.classList.remove("hidden");
}

function clearError() {
  errorElement.textContent = "";
  errorElement.classList.add("hidden");
}

function showWarnings(warnings) {
  const values = arrayValue(warnings).filter(Boolean);
  if (!values.length) {
    warningElement.textContent = "";
    warningElement.classList.add("hidden");
    return;
  }

  warningElement.textContent =
    "Some older source pages did not load, so this page may be incomplete.";
  warningElement.classList.remove("hidden");
}

async function loadMembers() {
  const response = await fetch("/api/top-members", { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Member request failed with HTTP ${response.status}.`);
  }

  members = arrayValue(payload.data);
}

async function fetchFeedPage(page, { replace = false, loadingOlder = false } = {}) {
  if (isLoading) return;

  setLoading(true, loadingOlder);
  clearError();

  try {
    if (!members.length || replace) await loadMembers();

    const response = await fetch(`/api/posts?page=${page}`, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || `Feed request failed with HTTP ${response.status}.`);
    }

    mergePosts(arrayValue(payload.data), replace);
    currentPage = page;
    hasMore = Boolean(payload.has_more);

    if (payload.top_member_count && payload.top_member_count < 100) {
      showWarnings([
        `Only ${payload.top_member_count} ranked members were returned by the API.`,
      ]);
    } else {
      showWarnings(payload.warnings);
    }

    loadMoreButton.classList.toggle("hidden", !hasMore);
    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    renderActiveView();
  } catch (error) {
    showError(error);
  } finally {
    setLoading(false, loadingOlder);
  }
}

async function refreshLatest() {
  await fetchFeedPage(1, { replace: false });
}

function switchView(view) {
  activeView = view;
  tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  postsView.classList.toggle("hidden", view !== "posts");
  membersView.classList.toggle("hidden", view !== "members");
  loadMoreWrap.classList.toggle("hidden", view !== "posts");
  renderActiveView();
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

refreshButton.addEventListener("click", async () => {
  try {
    await loadMembers();
  } catch (error) {
    showError(error);
    return;
  }
  await refreshLatest();
});

loadMoreButton.addEventListener("click", () =>
  fetchFeedPage(currentPage + 1, { loadingOlder: true })
);

searchInput.addEventListener("input", renderActiveView);

fetchFeedPage(1, { replace: true });

refreshTimer = window.setInterval(() => {
  if (!document.hidden && activeView === "posts") refreshLatest();
}, REFRESH_INTERVAL_MS);

window.addEventListener("beforeunload", () => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
