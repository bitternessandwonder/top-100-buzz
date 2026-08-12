"use strict";

const MAIN_STAGE_WAVE_ID =
  "b6128077-ea78-4dd9-b381-52c4eadb2077";

const loadingBox = document.querySelector("#loading-box");
const errorBox = document.querySelector("#error-box");
const warningBox = document.querySelector("#warning-box");
const profileContent = document.querySelector("#profile-content");
const profileAvatar = document.querySelector("#profile-avatar");
const profileName = document.querySelector("#profile-name");
const profileAddress = document.querySelector("#profile-address");
const profileBio = document.querySelector("#profile-bio");
const officialProfileLink = document.querySelector(
  "#official-profile-link"
);
const shareButton = document.querySelector("#share-button");
const punkDailyButton = document.querySelector("#punk-daily-button");
const punkDailySection = document.querySelector("#punk-daily-section");
const punkDailyFeed = document.querySelector("#punk-daily-feed");
const punkDailyLoadMore = document.querySelector(
  "#punk-daily-load-more"
);
const refreshButton = document.querySelector("#refresh-button");
const statRank = document.querySelector("#stat-rank");
const statLevel = document.querySelector("#stat-level");
const statTdh = document.querySelector("#stat-tdh");
const statPosts = document.querySelector("#stat-posts");
const statWaves = document.querySelector("#stat-waves");
const wavesGrid = document.querySelector("#waves-grid");
const mainStageFeed = document.querySelector("#main-stage-feed");
const recentFeed = document.querySelector("#recent-feed");
const updatedLabel = document.querySelector("#updated-label");

let currentProfile = null;
let punkDailyItems = [];
let punkDailyPage = 0;
let punkDailyHasMore = true;
let punkDailyLoading = false;

function stringValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return "";
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized =
    typeof value === "string"
      ? value.replaceAll(",", "").trim()
      : value;

  if (normalized === "") return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value) {
  const parsed = numberValue(value);
  if (parsed === null) return "—";

  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(parsed);
}

function shortenAddress(value) {
  const raw = stringValue(value);
  if (!raw) return "";
  return raw.length > 17
    ? `${raw.slice(0, 9)}…${raw.slice(-6)}`
    : raw;
}

function initial(value) {
  return stringValue(value).charAt(0).toUpperCase() || "?";
}

function identityFromPath() {
  const match = window.location.pathname.match(/^\/member\/(.+?)\/?$/);
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  return new URLSearchParams(window.location.search).get("identity") || "";
}

function dateValue(value) {
  if (value === null || value === undefined || value === "") return null;

  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return new Date(
      parsed < 1_000_000_000_000 ? parsed * 1000 : parsed
    );
  }

  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
  const date = dateValue(value);
  if (!date) return "Unknown date";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function postUrl(drop) {
  const waveId = stringValue(drop?.wave?.id, drop?.wave_id);
  if (!waveId) return "";

  const url = new URL(
    `https://6529.io/waves/${encodeURIComponent(waveId)}`
  );

  const dropId = stringValue(drop?.id, drop?.drop_id);
  const serial = stringValue(drop?.serial_no, drop?.serial);

  if (dropId) url.searchParams.set("drop", dropId);
  else if (serial) url.searchParams.set("serialNo", serial);

  return url.toString();
}

function setAvatar(profile) {
  const name = stringValue(profile?.handle, profile?.requested_identity);
  profileAvatar.replaceChildren();

  if (!profile?.pfp) {
    profileAvatar.textContent = initial(name);
    return;
  }

  const image = document.createElement("img");
  image.alt = "";
  image.src = profile.pfp;
  image.addEventListener(
    "error",
    () => {
      profileAvatar.replaceChildren(initial(name));
    },
    { once: true }
  );

  profileAvatar.append(image);
}

function makeEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function renderWaves(waves) {
  wavesGrid.replaceChildren();

  if (!waves.length) {
    wavesGrid.append(
      makeEmpty("No Wave activity was found in the loaded posts.")
    );
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const wave of waves) {
    const link = document.createElement("a");
    link.className = "wave-card";
    link.href = wave.id
      ? `https://6529.io/waves/${encodeURIComponent(wave.id)}`
      : "https://6529.io/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const copy = document.createElement("div");
    copy.className = "wave-card-copy";

    const title = document.createElement("h3");
    title.textContent = stringValue(wave.name) || "Unknown Wave";

    const meta = document.createElement("p");
    meta.textContent =
      `${formatNumber(wave.post_count)} recent ${
        Number(wave.post_count) === 1 ? "post" : "posts"
      }`;

    const arrow = document.createElement("span");
    arrow.className = "wave-card-arrow";
    arrow.textContent = "↗";

    copy.append(title, meta);
    link.append(copy, arrow);
    fragment.append(link);
  }

  wavesGrid.append(fragment);
}

function createActivityCard(drop) {
  const card = document.createElement("article");
  card.className = "activity-card";

  const url = postUrl(drop);

  if (url) {
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.addEventListener("click", () => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        window.open(url, "_blank", "noopener,noreferrer");
      }
    });
  }

  const head = document.createElement("div");
  head.className = "activity-head";

  const wave = document.createElement("span");
  wave.className = "activity-wave";
  wave.textContent = stringValue(drop?.wave?.name) || "Unknown Wave";

  const time = document.createElement("time");
  time.className = "activity-time";
  time.textContent = formatDate(drop?.created_at);

  head.append(wave, time);
  card.append(head);

  const titleText = stringValue(drop?.title);
  if (titleText) {
    const title = document.createElement("h3");
    title.textContent = titleText;
    card.append(title);
  }

  const textValue = stringValue(drop?.content);
  if (textValue) {
    const text = document.createElement("p");
    text.className = "activity-text";
    text.textContent = textValue;
    card.append(text);
  }

  const foot = document.createElement("div");
  foot.className = "activity-foot";

  const serial = document.createElement("span");
  serial.textContent = drop?.serial_no
    ? `Drop #${drop.serial_no}`
    : "Public Wave activity";

  const type = document.createElement("span");
  type.className = "activity-type";
  type.textContent =
    stringValue(drop?.drop_type, drop?.type) || "POST";

  if (Number(drop?._media_count) > 0) {
    serial.textContent += ` · ${drop._media_count} media`;
  }

  foot.append(serial, type);
  card.append(foot);

  return card;
}

function renderFeed(container, drops, emptyMessage) {
  container.replaceChildren();

  if (!drops.length) {
    container.append(makeEmpty(emptyMessage));
    return;
  }

  const fragment = document.createDocumentFragment();
  drops.forEach((drop) => fragment.append(createActivityCard(drop)));
  container.append(fragment);
}


function isPunk6529Profile(profile) {
  const values = [
    profile?.handle,
    profile?.requested_identity,
    identityFromPath(),
  ]
    .map((value) => stringValue(value).toLowerCase())
    .filter(Boolean);

  return values.some(
    (value) =>
      value === "punk6529" ||
      value === "@punk6529" ||
      value.includes("punk6529")
  );
}

function dailyItemKey(drop) {
  return stringValue(
    drop?.id,
    drop?.drop_id,
    drop?.serial_no,
    `${drop?.created_at}:${drop?.content}`
  );
}

function mergeDailyItems(current, incoming, reset = false) {
  const merged = new Map();

  if (!reset) {
    current.forEach((drop) => {
      merged.set(dailyItemKey(drop), drop);
    });
  }

  incoming.forEach((drop) => {
    merged.set(dailyItemKey(drop), drop);
  });

  return [...merged.values()];
}

function utcDayKey(value) {
  const date = dateValue(value);
  if (!date) return "unknown";

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function formatUtcDay(dayKey) {
  if (dayKey === "unknown") return "Unknown date";

  const date = new Date(`${dayKey}T00:00:00.000Z`);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
    timeZone: "UTC",
  }).format(date);
}

function renderPunkDaily() {
  punkDailyFeed.replaceChildren();

  if (!punkDailyItems.length) {
    punkDailyFeed.append(
      makeEmpty(
        punkDailyLoading
          ? "Loading Punk6529 Daily…"
          : "No Punk6529 posts were returned."
      )
    );
    punkDailyLoadMore.classList.toggle(
      "hidden",
      !punkDailyHasMore || punkDailyLoading
    );
    return;
  }

  const groups = new Map();

  for (const drop of punkDailyItems) {
    const key = utcDayKey(drop?.created_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(drop);
  }

  const orderedDays = [...groups.keys()].sort().reverse();
  const fragment = document.createDocumentFragment();

  for (const day of orderedDays) {
    const section = document.createElement("section");
    section.className = "punk-day-group";

    const heading = document.createElement("h3");
    heading.textContent = formatUtcDay(day);

    const feed = document.createElement("div");
    feed.className = "profile-feed";

    groups
      .get(day)
      .sort((a, b) => {
        const left = dateValue(a?.created_at)?.getTime() || 0;
        const right = dateValue(b?.created_at)?.getTime() || 0;
        return left - right;
      })
      .forEach((drop) => {
        feed.append(createActivityCard(drop));
      });

    section.append(heading, feed);
    fragment.append(section);
  }

  punkDailyFeed.append(fragment);
  punkDailyLoadMore.classList.toggle(
    "hidden",
    !punkDailyHasMore || punkDailyLoading
  );
  punkDailyLoadMore.disabled = punkDailyLoading;
  punkDailyLoadMore.textContent = punkDailyLoading
    ? "Loading…"
    : "Load previous day";
}

async function loadPunkDaily({ reset = false } = {}) {
  if (punkDailyLoading) return;

  punkDailyLoading = true;

  if (reset) {
    punkDailyItems = [];
    punkDailyPage = 0;
    punkDailyHasMore = true;
  }

  renderPunkDaily();

  try {
    const nextPage = reset ? 1 : punkDailyPage + 1;
    const response = await fetch(
      `/api/punk-posts?page=${nextPage}`,
      { cache: "no-store" }
    );
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        payload.error ||
        `Punk6529 Daily failed with HTTP ${response.status}.`
      );
    }

    punkDailyItems = mergeDailyItems(
      punkDailyItems,
      Array.isArray(payload.data) ? payload.data : [],
      reset
    );
    punkDailyPage = nextPage;
    punkDailyHasMore = Boolean(payload.has_more);
  } catch (error) {
    errorBox.textContent =
      error instanceof Error
        ? error.message
        : "Punk6529 Daily could not be loaded.";
    errorBox.classList.remove("hidden");
  } finally {
    punkDailyLoading = false;
    renderPunkDaily();
  }
}

function renderProfile(payload) {
  const profile = payload.profile || {};
  const posts = Array.isArray(payload.recent_posts)
    ? payload.recent_posts
    : [];
  const waves = Array.isArray(payload.active_waves)
    ? payload.active_waves
    : [];
  const mainStage = Array.isArray(payload.main_stage_activity)
    ? payload.main_stage_activity
    : [];

  currentProfile = profile;

  const punkProfile = isPunk6529Profile(profile);
  punkDailyButton.classList.toggle("hidden", !punkProfile);

  if (!punkProfile) {
    punkDailySection.classList.add("hidden");
  }

  const name = stringValue(
    profile.handle,
    profile.requested_identity
  ) || "Member";

  document.title = `${name} | Brain Buzz`;
  profileName.textContent = name;
  profileAddress.textContent =
    stringValue(profile.primary_address) || "No public address returned";

  if (profile.bio) {
    profileBio.textContent = profile.bio;
    profileBio.classList.remove("hidden");
  } else {
    profileBio.textContent = "";
    profileBio.classList.add("hidden");
  }

  setAvatar(profile);

  officialProfileLink.href =
    profile.profile_url || "https://6529.io/";

  statRank.textContent =
    profile.top_member_rank
      ? `#${formatNumber(profile.top_member_rank)}`
      : "—";
  statLevel.textContent = formatNumber(profile.level);
  statTdh.textContent = formatNumber(profile.tdh);
  statPosts.textContent = formatNumber(posts.length);
  statWaves.textContent = formatNumber(waves.length);

  renderWaves(waves);
  renderFeed(
    mainStageFeed,
    mainStage,
    "No recent Main Stage activity was found in the loaded sample."
  );
  renderFeed(
    recentFeed,
    posts,
    "No recent public Wave posts were returned for this identity."
  );

  updatedLabel.textContent =
    `Updated ${new Date(payload.generated_at || Date.now())
      .toLocaleString()}`;

  warningBox.classList.toggle(
    "hidden",
    !Array.isArray(payload.warnings) || payload.warnings.length === 0
  );

  if (Array.isArray(payload.warnings) && payload.warnings.length) {
    warningBox.textContent =
      "Some optional profile information could not be loaded. " +
      "The activity shown may be incomplete.";
  }

  loadingBox.classList.add("hidden");
  profileContent.classList.remove("hidden");
}

async function loadProfile({ force = false } = {}) {
  const identity = identityFromPath();

  if (!identity) {
    loadingBox.classList.add("hidden");
    errorBox.textContent = "No member identity was supplied in the URL.";
    errorBox.classList.remove("hidden");
    return;
  }

  refreshButton.disabled = true;
  errorBox.classList.add("hidden");

  if (force) {
    loadingBox.textContent = "Refreshing public member profile…";
    loadingBox.classList.remove("hidden");
  }

  try {
    const url = new URL(
      "/api/member-profile",
      window.location.origin
    );
    url.searchParams.set("identity", identity);
    if (force) url.searchParams.set("refresh", "1");

    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        payload.error ||
        `Profile request failed with HTTP ${response.status}.`
      );
    }

    renderProfile(payload);
  } catch (error) {
    loadingBox.classList.add("hidden");
    errorBox.textContent =
      error instanceof Error
        ? error.message
        : "The identity profile could not be loaded.";
    errorBox.classList.remove("hidden");
  } finally {
    refreshButton.disabled = false;
  }
}

shareButton.addEventListener("click", async () => {
  const title =
    `${stringValue(currentProfile?.handle, "Member")} on Brain Buzz`;

  try {
    if (navigator.share) {
      await navigator.share({
        title,
        text: "View this public 6529 member activity profile on Brain Buzz.",
        url: window.location.href,
      });
      return;
    }

    await navigator.clipboard.writeText(window.location.href);
    shareButton.textContent = "Link copied";
    window.setTimeout(() => {
      shareButton.textContent = "Share profile";
    }, 1800);
  } catch (error) {
    console.error("Profile sharing failed:", error);
  }
});

punkDailyButton.addEventListener("click", () => {
  punkDailySection.classList.remove("hidden");
  punkDailySection.scrollIntoView({
    behavior: "smooth",
    block: "start",
  });

  if (!punkDailyItems.length) {
    void loadPunkDaily({ reset: true });
  }
});

punkDailyLoadMore.addEventListener("click", () => {
  void loadPunkDaily();
});

refreshButton.addEventListener("click", () => {
  void loadProfile({ force: true });

  if (!punkDailySection.classList.contains("hidden")) {
    void loadPunkDaily({ reset: true });
  }
});

void loadProfile();
