"use strict";

const feedView = document.querySelector("#feed-view");
const moversView = document.querySelector("#movers-view");
const exploreView = document.querySelector("#explore-view");
const membersView = document.querySelector("#members-view");
const identityControls = document.querySelector("#identity-controls");
const identitySortButtons = [
  ...document.querySelectorAll(".identity-sort-button"),
];
const loadingElement = document.querySelector("#loading-box");
const errorElement = document.querySelector("#error-box");
const warningElement = document.querySelector("#warning-box");
const refreshButton = document.querySelector("#refresh-button");
const loadMoreButton = document.querySelector("#load-more-button");
const loadMoreWrap = document.querySelector("#load-more-wrap");
const searchInput = document.querySelector("#search-input");
const resultCount = document.querySelector("#result-count");
const lastUpdated = document.querySelector("#last-updated");
const viewDescription = document.querySelector("#view-description");
const notice = document.querySelector("#notice");
const toolbarElement = document.querySelector(".toolbar");
const searchContainer = document.querySelector("#search-container");
const statusGroup = document.querySelector("#status-group");
const mainstageSubtabs = document.querySelector("#mainstage-subtabs");
const wavesSubtabs = document.querySelector("#waves-subtabs");
const postTemplate = document.querySelector("#post-template");
const memberTemplate = document.querySelector("#identity-template");
const tabButtons = [...document.querySelectorAll(".tab")];
const subtabButtons = [...document.querySelectorAll(".subtab")];

const REFRESH_INTERVAL_MS = 60_000;

const feedState = {
  chats: {
    endpoint: "/api/chats",
    noun: "chat",
    items: [],
    page: 0,
    hasMore: true,
    loaded: false,
    loading: false,
  },
  top: {
    endpoint: "/api/top-posts",
    noun: "post",
    items: [],
    page: 0,
    hasMore: true,
    loaded: false,
    loading: false,
  },
  punk: {
    endpoint: "/api/punk-posts",
    noun: "post",
    items: [],
    page: 0,
    hasMore: true,
    loaded: false,
    loading: false,
  },
  mainstage: {
    endpoint: "/api/main-stage-leaderboard",
    noun: "entry",
    items: [],
    page: 0,
    hasMore: true,
    loaded: false,
    loading: false,
  },
};

const customState = {
  movers: {
    endpoint: "/api/movers",
    data: null,
    loaded: false,
    loading: false,
  },
  explore: {
    endpoint: "/api/explore",
    data: null,
    loaded: false,
    loading: false,
  },
};

const dailyBuzzIdentityState = {
  activeMetric: "",
  items: [],
  page: 0,
  total: null,
  hasMore: false,
  loading: false,
  error: "",
  query: "",
};

const DAILY_BUZZ_METRIC_COPY = {
  total_identities: {
    label: "Total Identities",
    detail: "Consolidated identities in the Network Nerd collector table.",
  },
  full_set_holders: {
    label: "Full Set Holders",
    detail: "Collectors matching Network Nerd’s Meme SZN Set filter.",
  },
  million_tdh_identities: {
    label: "1M TDH Identities",
    detail: "Consolidated identities with at least 1,000,000 TDH.",
  },
};

const viewCopy = {
  chats: {
    description: "Public chat activity from across 6529 Waves.",
    notice:
      "<strong>All Chats:</strong> Public CHAT drops returned by the 6529 API. Select a post or its Wave name to open it on 6529.io.",
    placeholder: "Search author, Wave, or message",
  },
  top: {
    description:
      "Wave activity posted by identities in the Top 100 directory.",
    notice:
      "<strong>Top 100 Buzz:</strong> Public Wave posts filtered to identities in the Top 100 directory.",
    placeholder: "Search identity, Wave, rank, Level, or message",
  },
  punk: {
    description:
      "Punk6529’s public Wave posts, grouped into daily bursts for easier reading.",
    notice:
      "<strong>Punk6529 Daily:</strong> Loads Punk6529’s public posts directly by author. The newest complete UTC day appears first; posts within each day run from earliest to latest.",
    placeholder: "Search Punk6529 posts, Waves, or dates",
  },
  mainstage: {
    description:
      "The live leaderboard for The Memes – Main Stage Wave.",
    notice:
      "<strong>Main Stage Leaderboard:</strong> Ordered by current voting rank, with each entry’s current Voting TDH. Select an entry to open the original submission on 6529.io.",
    placeholder: "Search artist, title, rank, or Voting TDH",
  },
  movers: {
    description:
      "Main Stage entries with actual rank or Voting TDH changes.",
    notice:
      "<strong>Main Stage Movers:</strong> Only entries that changed after the tracking baseline appear here.",
    placeholder: "Search artist, title, rank, or movement",
  },
  radar: {
    description:
      "The currently active public Waves ranked by 6529’s Hot view.",
    notice:
      "<strong>Hot Waves:</strong> Active public Waves from the 6529 hot-Waves view. Select a Wave to open it on 6529.io.",
    placeholder: "Filter Hot Waves by name or creator",
  },
  explore: {
    description:
      "Daily Buzz metrics from current public 6529 network data.",
    notice:
      "<strong>Daily Buzz:</strong> A compact snapshot of identities, full-set collectors, and high-TDH profiles.",
    placeholder: "Daily Buzz metrics",
  },
  members: {
    description: "The Top 100 public identities ranked by profile Level.",
    notice:
      "<strong>Top 100 Identities:</strong> Ranked by profile Level from highest to lowest. Select an identity to open its Brain Buzz activity profile.",
    placeholder: "Search identity, wallet, rank, Level, or TDH",
  },
};

function viewGroup(view) {
  if (view === "mainstage" || view === "movers") return "mainstage";
  if (
    view === "chats" ||
    view === "top" ||
    view === "punk" ||
    view === "radar"
  ) {
    return "waves";
  }
  if (view === "members") return "identities";
  return view;
}

let activeView = "mainstage";
let members = [];
let membersLoaded = false;
let memberDetailsLoading = false;
let memberDetailsLoaded = false;
let identitySort = "level";
let isLoading = false;
const punkDayVisibleCounts = new Map();
const PUNK_POSTS_INITIAL_VISIBLE = 20;
const PUNK_POSTS_VISIBLE_STEP = 20;
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

function arweavePath(value) {
  const raw = stringValue(value).trim();
  if (!raw) return "";

  const protocolMatch = raw.match(/^(?:ar|arweave):\/\/(.+)$/i);
  if (protocolMatch) {
    return protocolMatch[1].replace(/^\/+/, "");
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();

    if (host === "arweave.net" || host.endsWith(".arweave.net")) {
      return `${parsed.pathname.replace(/^\/+/, "")}${parsed.search}${parsed.hash}`;
    }

    if (
      host === "media.6529.io" &&
      parsed.pathname.toLowerCase().startsWith("/arweave/")
    ) {
      return `${parsed.pathname.slice("/arweave/".length)}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // It may be a decentralized-media URI rather than an HTTP URL.
  }

  return "";
}

function assetUrls(value) {
  const raw = stringValue(value).trim();
  if (!raw) return [];

  if (raw.toLowerCase().startsWith("ipfs://")) {
    const ipfsPath = raw
      .slice("ipfs://".length)
      .replace(/^ipfs\//i, "")
      .replace(/^\/+/, "");

    return [
      `https://ipfs.io/ipfs/${ipfsPath}`,
      `https://dweb.link/ipfs/${ipfsPath}`,
    ];
  }

  const arPath = arweavePath(raw);
  if (arPath) {
    return [...new Set([
      `https://media.6529.io/arweave/${arPath}`,
      `https://arweave.net/${arPath}`,
      /^https?:\/\//i.test(raw) ? raw : "",
    ].filter(Boolean))];
  }

  return [raw];
}

function setImageWithFallback(image, value, onFailure) {
  const urls = assetUrls(value);
  let index = 0;

  if (!urls.length) {
    onFailure();
    return;
  }

  image.src = urls[index];

  image.addEventListener("error", () => {
    index += 1;

    if (index < urls.length) {
      image.src = urls[index];
    } else {
      onFailure();
    }
  });
}

function shortenAddress(value) {
  if (!value) return "";
  return value.length > 13
    ? `${value.slice(0, 7)}…${value.slice(-5)}`
    : value;
}

function authorRecord(drop) {
  return drop?._top_member || drop?._display_author || {};
}

function leaderboardRank(drop) {
  const candidates = [
    drop?._leaderboard_rank,
    drop?.submission_context?.voting?.place,
    drop?.rank,
    drop?.submission_context?.rank,
  ];

  for (const value of candidates) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return 0;
}

function leaderboardScore(drop) {
  const candidates = [
    drop?._voting_tdh,
    drop?.submission_context?.voting?.current_calculated_vote,
    drop?.submission_context?.voting?.total_votes_given,
    drop?.rating,
    drop?.realtime_rating,
    drop?._leaderboard_score,
    drop?.submission_context?.rating,
    drop?.score,
    drop?.rating_prediction,
    drop?.submission_context?.score,
  ];

  for (const value of candidates) {
    if (value === null || value === undefined || value === "") {
      continue;
    }

    const parsed = Number(
      typeof value === "string"
        ? value.replaceAll(",", "").trim()
        : value
    );

    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function formatLeaderboardScore(value) {
  if (!Number.isFinite(value)) return "";

  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(value);
}

function optionalDisplayNumber(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? formatLeaderboardScore(parsed)
    : "—";
}

function authorName(drop) {
  const display = authorRecord(drop);

  return (
    stringValue(
      display?.handle,
      drop?.author?.handle,
      drop?.author?.profile?.handle,
      drop?.profile?.handle,
      drop?.author_handle
    ) ||
    shortenAddress(
      stringValue(
        display?.primary_address,
        drop?.author?.primary_address,
        drop?.author?.address,
        drop?.signer_address
      )
    ) ||
    "Unknown author"
  );
}

function authorImage(drop) {
  const display = authorRecord(drop);

  return stringValue(
    display?.pfp,
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
    ) || "Unknown Wave"
  );
}

function waveId(drop) {
  return stringValue(drop?.wave?.id, drop?.wave_id, drop?.wave?.wave_id);
}

function postId(drop) {
  return stringValue(drop?.id, drop?.drop_id);
}

function postSerialNo(drop) {
  return stringValue(drop?.serial_no, drop?.serial);
}

function build6529PostUrl(drop) {
  const id = waveId(drop);
  if (!id) return "";

  const url = new URL(`https://6529.io/waves/${encodeURIComponent(id)}`);
  const dropId = postId(drop);
  const serialNo = postSerialNo(drop);

  if (dropId) {
    url.searchParams.set("drop", dropId);
  } else if (serialNo) {
    url.searchParams.set("serialNo", serialNo);
  }

  return url.toString();
}

function open6529Post(url) {
  if (!url) return;

  const opened = window.open(url, "_blank");
  if (opened) {
    opened.opener = null;
    return;
  }

  // Popup blockers should not make submissions unreachable.
  window.location.assign(url);
}

function extractText(drop) {
  const direct = stringValue(
    drop?.content,
    drop?.message,
    drop?.text,
    drop?.body
  );
  if (direct) return direct;

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

function firstAssetUrl(value) {
  return assetUrls(value)[0] || "";
}

function extractMedia(drop) {
  const found = [];
  const seen = new Set();
  const urlKeys = new Set([
    "url",
    "uri",
    "src",
    "href",
    "media_url",
    "mediaurl",
    "resolved_url",
    "resolvedurl",
    "gateway_url",
    "gatewayurl",
    "download_url",
    "downloadurl",
    "animation_url",
    "animationurl",
    "image_url",
    "imageurl",
  ]);

  function add(value, mimeType = "", kind = "") {
    const urls = assetUrls(value);
    const normalized = urls[0] || "";
    if (!normalized || seen.has(normalized)) return;

    seen.add(normalized);
    found.push({
      url: normalized,
      fallbackUrls: urls.slice(1),
      mimeType: String(mimeType || ""),
      kind: String(kind || ""),
    });
  }

  function scan(value, inheritedMime = "", inheritedKind = "", depth = 0) {
    if (value === null || value === undefined || depth > 6) return;

    if (Array.isArray(value)) {
      value.forEach((item) => scan(item, inheritedMime, inheritedKind, depth + 1));
      return;
    }

    if (typeof value !== "object") return;

    const mime = stringValue(
      value?.mime_type,
      value?.mimeType,
      value?.content_type,
      value?.contentType,
      value?.media_type,
      value?.mediaType,
      inheritedMime
    );
    const kind = stringValue(
      value?.kind,
      value?.media_kind,
      value?.mediaKind,
      value?.type,
      value?.format,
      inheritedKind
    );

    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replaceAll("-", "_");
      const compactKey = normalizedKey.replaceAll("_", "");

      if (
        typeof child === "string" &&
        (urlKeys.has(normalizedKey) || urlKeys.has(compactKey))
      ) {
        add(child, mime, `${kind} ${key}`.trim());
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (!child || typeof child !== "object") continue;
      const lowerKey = key.toLowerCase();

      if (
        depth === 0 ||
        /(media|asset|attachment|part|metadata|submission|preview|animation|image|video|html|content)/i.test(lowerKey)
      ) {
        scan(child, mime, `${kind} ${key}`.trim(), depth + 1);
      }
    }
  }

  const roots = [
    drop?.media,
    drop?.media_files,
    drop?.attachments,
    drop?.parts,
    drop?.metadata,
    drop?.submission_context,
    drop?.preview,
    drop?.nft,
    drop?.referenced_nfts,
    {
      animation_url: drop?.animation_url || drop?.animationUrl,
      image_url: drop?.image_url || drop?.imageUrl,
      media_url: drop?.media_url || drop?.mediaUrl,
      mime_type: drop?.mime_type || drop?.mimeType || drop?.content_type,
      kind: drop?.media_type || drop?.mediaType,
    },
  ];

  roots.forEach((root) => scan(root));
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

function itemKey(drop, index = 0) {
  return stringValue(
    drop?.id,
    drop?.drop_id,
    drop?.serial_no,
    `${authorName(drop)}:${createdAt(drop) || "unknown"}:${extractText(drop)}:${index}`
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

function initial(name) {
  return Array.from(String(name || "").trim())[0]?.toUpperCase() || "?";
}

function mergeItems(current, incoming, replace = false) {
  const merged = new Map();

  if (!replace) {
    current.forEach((item, index) => merged.set(itemKey(item, index), item));
  }

  incoming.forEach((item, index) => merged.set(itemKey(item, index), item));

  return [...merged.values()].sort(
    (a, b) => (createdAt(b) || 0) - (createdAt(a) || 0)
  );
}

function sortFeedItemsForView(view, items) {
  if (view === "mainstage") {
    return [...items].sort((a, b) => {
      const rankDifference =
        leaderboardRank(a) - leaderboardRank(b);

      if (rankDifference !== 0) return rankDifference;

      const scoreA = leaderboardScore(a);
      const scoreB = leaderboardScore(b);

      if (
        Number.isFinite(scoreA) &&
        Number.isFinite(scoreB) &&
        scoreA !== scoreB
      ) {
        return scoreB - scoreA;
      }

      return (createdAt(b) || 0) - (createdAt(a) || 0);
    });
  }

  return items;
}

function mediaUrlCandidates(item) {
  return [...new Set([
    item?.url,
    ...arrayValue(item?.fallbackUrls),
  ].filter(Boolean))];
}

function setMediaWithFallback(element, item) {
  const candidates = mediaUrlCandidates(item);
  let index = 0;

  if (!candidates.length) return;
  element.src = candidates[index];

  element.addEventListener("error", () => {
    index += 1;
    if (index < candidates.length) {
      element.src = candidates[index];
    }
  });
}

function externalLink(href, text, className = "") {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = text;
  if (className) link.className = className;
  return link;
}

function isInteractiveHtml(item) {
  const descriptor = `${item?.mimeType || ""} ${item?.kind || ""} ${item?.url || ""}`.toLowerCase();
  return (
    descriptor.includes("text/html") ||
    descriptor.includes("application/xhtml") ||
    descriptor.includes("interactive") ||
    /(^|[\s_\-/])html([\s_\-/]|$)/.test(descriptor) ||
    /\.html?(\?|#|$)/.test(descriptor)
  );
}

function renderMedia(container, media, submissionUrl = "") {
  container.replaceChildren();

  for (const item of media) {
    const mime = item.mimeType.toLowerCase();
    const lower = item.url.toLowerCase();

    if (isInteractiveHtml(item)) {
      const panel = document.createElement("div");
      panel.className = "interactive-media-card";

      const label = document.createElement("span");
      label.className = "interactive-media-label";
      label.textContent = "INTERACTIVE HTML";

      const copy = document.createElement("div");
      copy.className = "interactive-media-copy";
      const heading = document.createElement("strong");
      heading.textContent = "Open the interactive submission";
      const note = document.createElement("span");
      note.textContent = "It opens in a separate tab because submitted HTML can run untrusted code.";
      copy.append(heading, note);

      const actions = document.createElement("div");
      actions.className = "media-action-row";
      actions.append(
        externalLink(item.url, "Open interactive work ↗", "media-action-link primary-media-link")
      );

      const fallback = arrayValue(item?.fallbackUrls)[0];
      if (fallback && fallback !== item.url) {
        actions.append(
          externalLink(fallback, "Alternate gateway ↗", "media-action-link")
        );
      }

      panel.append(label, copy, actions);
      container.append(panel);
      continue;
    }

    if (
      mime.startsWith("image/") ||
      /\.(png|jpe?g|gif|webp|avif)(\?|$)/.test(lower)
    ) {
      const image = document.createElement("img");
      image.alt = "Media attached to this post";
      image.loading = "lazy";
      setMediaWithFallback(image, item);
      container.append(image);
      continue;
    }

    if (
      mime.startsWith("video/") ||
      /\.(mp4|webm|mov)(\?|$)/.test(lower)
    ) {
      const video = document.createElement("video");
      video.controls = true;
      video.preload = "metadata";
      setMediaWithFallback(video, item);
      container.append(video);
      continue;
    }

    container.append(
      externalLink(item.url, "Open attached media ↗", "media-action-link")
    );
  }

  if (submissionUrl) {
    const actions = document.createElement("div");
    actions.className = "submission-actions";
    actions.append(
      externalLink(
        submissionUrl,
        "Open submission on 6529 ↗",
        "media-action-link submission-link"
      )
    );
    container.append(actions);
  }
}

function createPostCard(drop) {
  const card = postTemplate.content.firstElementChild.cloneNode(true);
  const display = authorRecord(drop);
  const name = authorName(drop);
  const imageUrl = authorImage(drop);
  const text = extractText(drop);
  const title = stringValue(drop?.title);
  const rank =
    activeView === "mainstage"
      ? leaderboardRank(drop)
      : Number(display?.rank) || 0;
  const level = Number(display?.level) || 0;
  const score = leaderboardScore(drop);

  const rankBadge = card.querySelector(".rank-badge");
  if (
    (activeView === "top" || activeView === "mainstage") &&
    rank
  ) {
    rankBadge.textContent = `#${rank}`;
    rankBadge.classList.remove("hidden");
  }

  if (activeView === "mainstage") {
    card.classList.add("main-stage-card");

    if (rank > 0 && rank <= 3) {
      card.classList.add(`podium-${rank}`);
    }
  }

  const avatar = card.querySelector(".avatar");
  if (imageUrl) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    setImageWithFallback(image, imageUrl, () => {
      avatar.replaceChildren(initial(name));
    });
    avatar.append(image);
  } else {
    avatar.textContent = initial(name);
  }

  card.querySelector(".author").textContent = name;

  const memberMeta = card.querySelector(".member-meta");
  if (activeView === "top" && level) {
    memberMeta.textContent = `Level ${level}`;
  } else if (activeView === "mainstage") {
    memberMeta.textContent =
      score === null
        ? "Main Stage submission"
        : `Voting TDH ${formatLeaderboardScore(score)}`;
  } else if (activeView === "punk") {
    memberMeta.textContent = "@punk6529";
  } else {
    memberMeta.textContent = "";
  }

  const time = card.querySelector(".time");
  const timeValue = createdAt(drop);

  if (activeView === "punk" && timeValue) {
    time.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(timeValue));
  } else {
    time.textContent = formatDate(timeValue);
  }

  if (timeValue) {
    time.dateTime = new Date(timeValue).toISOString();
  }

  const destinationUrl = build6529PostUrl(drop);
  const waveLine = card.querySelector(".wave-line");
  waveLine.textContent = `Wave: ${waveName(drop)} ↗`;

  if (destinationUrl) {
    card.classList.add("clickable");
    card.tabIndex = 0;
    card.setAttribute("role", "link");
    card.setAttribute(
      "aria-label",
      `Open this post in the ${waveName(drop)} Wave on 6529.io`
    );

    waveLine.classList.add("clickable-wave");
    waveLine.setAttribute("role", "link");

    waveLine.addEventListener("click", (event) => {
      event.stopPropagation();
      open6529Post(destinationUrl);
    });

    card.addEventListener("click", (event) => {
      if (
        event.target.closest(
          "a, button, input, textarea, select, video, audio"
        )
      ) {
        return;
      }

      open6529Post(destinationUrl);
    });

    card.addEventListener("keydown", (event) => {
      if (
        event.target === card &&
        (event.key === "Enter" || event.key === " ")
      ) {
        event.preventDefault();
        open6529Post(destinationUrl);
      }
    });
  }

  const titleElement = card.querySelector(".title");
  if (title) {
    titleElement.textContent = title;
    titleElement.classList.remove("hidden");
  }

  const message = card.querySelector(".message");
  message.textContent = text || "[Media attachment or empty post]";

  if (!text) {
    message.classList.add("empty");
  }

  const mediaContainer = card.querySelector(".media");

  if (activeView === "punk" && Number(drop?._media_count || 0) > 0) {
    const mediaNotice = document.createElement("span");
    mediaNotice.className = "punk-media-notice";
    mediaNotice.textContent =
      `${drop._media_count} media attachment${
        Number(drop._media_count) === 1 ? "" : "s"
      } · open original post to view ↗`;
    mediaContainer.append(mediaNotice);
  } else {
    renderMedia(
      mediaContainer,
      extractMedia(drop),
      activeView === "mainstage" ? destinationUrl : ""
    );
  }

  card.querySelector(".serial").textContent = serialLabel(drop);
  card.querySelector(".type-badge").textContent =
    activeView === "mainstage"
      ? "ENTRY"
      : stringValue(drop?.drop_type, drop?.type) ||
        (activeView === "chats" ? "CHAT" : "POST");

  return card;
}

function localDayKey(drop) {
  const milliseconds = createdAt(drop);
  if (!milliseconds) return "unknown";

  return new Date(milliseconds).toISOString().slice(0, 10);
}

function dayHeading(dayKey) {
  if (dayKey === "unknown") return "Unknown date";

  const date = new Date(`${dayKey}T12:00:00Z`);

  return `${new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date)} · UTC`;
}

function renderPunkDaily(visible) {
  const grouped = new Map();

  for (const drop of visible) {
    const key = localDayKey(drop);

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push(drop);
  }

  const dayKeys = [...grouped.keys()].sort((a, b) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return b.localeCompare(a);
  });

  const fragment = document.createDocumentFragment();

  for (const key of dayKeys) {
    const posts = grouped.get(key).sort(
      (a, b) => (createdAt(a) || 0) - (createdAt(b) || 0)
    );

    const currentLimit = Math.min(
      punkDayVisibleCounts.get(key) || PUNK_POSTS_INITIAL_VISIBLE,
      posts.length
    );

    const section = document.createElement("section");
    section.className = "punk-day";

    const heading = document.createElement("header");
    heading.className = "punk-day-heading";

    const title = document.createElement("h2");
    title.className = "punk-day-title";
    title.textContent = dayHeading(key);

    const count = document.createElement("span");
    count.className = "punk-day-count";
    count.textContent =
      currentLimit < posts.length
        ? `${currentLimit} of ${posts.length} posts · oldest → newest`
        : `${posts.length} ${
            posts.length === 1 ? "post" : "posts"
          } · oldest → newest`;

    const list = document.createElement("div");
    list.className = "punk-day-posts";

    for (const drop of posts.slice(0, currentLimit)) {
      list.append(createPostCard(drop));
    }

    section.append(heading, list);

    if (currentLimit < posts.length) {
      const revealButton = document.createElement("button");
      revealButton.type = "button";
      revealButton.className = "button secondary punk-reveal-button";
      revealButton.textContent =
        `Show ${Math.min(
          PUNK_POSTS_VISIBLE_STEP,
          posts.length - currentLimit
        )} more posts from this day`;

      revealButton.addEventListener("click", () => {
        punkDayVisibleCounts.set(
          key,
          Math.min(currentLimit + PUNK_POSTS_VISIBLE_STEP, posts.length)
        );
        renderFeed();
      });

      section.append(revealButton);
    }

    fragment.append(section);
  }

  feedView.append(fragment);
}

function renderFeed() {
  const state = feedState[activeView];
  const query = searchInput.value.trim().toLowerCase();

  const visible = query
    ? state.items.filter((drop) => {
        const member = authorRecord(drop);

        return [
          authorName(drop),
          waveName(drop),
          stringValue(drop?.title),
          extractText(drop),
          member?.rank,
          member?.level,
          leaderboardRank(drop),
          leaderboardScore(drop),
          drop?.drop_type,
          formatDate(createdAt(drop)),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query);
      })
    : state.items;

  feedView.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";

    if (state.items.length) {
      empty.textContent = "No loaded posts match that filter.";
    } else if (activeView === "chats") {
      empty.textContent = "No public chats were returned.";
    } else if (activeView === "punk") {
      empty.textContent =
        "No recent public Punk6529 posts were found.";
    } else if (activeView === "mainstage") {
      empty.textContent =
        "No Main Stage leaderboard entries were returned.";
    } else {
      empty.textContent =
        "No matching Top 100 posts were found in the scanned pages.";
    }

    feedView.append(empty);
  } else if (activeView === "punk") {
    renderPunkDaily(visible);
  } else {
    const fragment = document.createDocumentFragment();

    for (const drop of visible) {
      fragment.append(createPostCard(drop));
    }

    feedView.append(fragment);
  }

  resultCount.textContent =
    query && visible.length !== state.items.length
      ? `${visible.length} of ${state.items.length} ${state.noun}s`
      : `${state.items.length} ${
          state.items.length === 1 ? state.noun : `${state.noun}s`
        }`;
}

function memberDisplayName(member) {
  return (
    stringValue(member?.handle) ||
    shortenAddress(stringValue(member?.primary_address)) ||
    "Unknown member"
  );
}

function buildBrainBuzzProfileUrl(member) {
  const identity = stringValue(
    member?.handle,
    member?.primary_address,
    member?.consolidation_key
  );

  if (!identity) return "";

  return `/member/${encodeURIComponent(identity)}`;
}

function openBrainBuzzProfile(url) {
  if (!url) return;
  window.location.assign(url);
}


function identitySortValue(member, sort) {
  if (sort === "tdh") {
    const value = Number(member?.tdh);
    return Number.isFinite(value) ? value : -1;
  }

  const value = Number(member?.level);
  return Number.isFinite(value) ? value : -1;
}

function sortedIdentities(values) {
  return [...values].sort((left, right) => {
    const difference =
      identitySortValue(right, identitySort) -
      identitySortValue(left, identitySort);

    if (difference !== 0) return difference;

    const levelDifference =
      identitySortValue(right, "level") -
      identitySortValue(left, "level");

    if (levelDifference !== 0) return levelDifference;

    return (Number(left?.rank) || 9999) - (Number(right?.rank) || 9999);
  });
}

function updateIdentitySortControls() {
  identitySortButtons.forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.identitySort === identitySort
    );
  });
}

function renderMembers() {
  const query = searchInput.value.trim().toLowerCase();

  const filtered = query
    ? members.filter((member) =>
        [
          memberDisplayName(member),
          member?.rank,
          member?.level,
          member?.tdh,
          member?.x_username,
          member?.primary_address,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)
      )
    : members;

  const visible = sortedIdentities(filtered);
  updateIdentitySortControls();
  membersView.replaceChildren();

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = membersLoaded
      ? "No identities match that filter."
      : "The identity ranking has not loaded.";
    membersView.append(empty);
  } else {
    const fragment = document.createDocumentFragment();

    visible.forEach((member, visibleIndex) => {
      const card = memberTemplate.content.firstElementChild.cloneNode(true);
      const name = memberDisplayName(member);
      const topRank = Number(member?.rank) || visibleIndex + 1;
      const displayedRank =
        identitySort === "level" ? topRank : visibleIndex + 1;

      card.querySelector(".member-rank").textContent = `#${displayedRank}`;

      const avatar = card.querySelector(".member-avatar");
      if (member.pfp) {
        const image = document.createElement("img");
        image.alt = "";
        image.loading = "lazy";
        setImageWithFallback(image, member.pfp, () => {
          avatar.replaceChildren(initial(name));
        });
        avatar.append(image);
      } else {
        avatar.textContent = initial(name);
      }

      card.querySelector(".member-name").textContent = `${name} →`;

      const levelLine = card.querySelector(".member-level");

      if (identitySort === "tdh") {
        levelLine.textContent =
          `TDH ${optionalDisplayNumber(member?.tdh)} · ` +
          `Level ${optionalDisplayNumber(member?.level)} · ` +
          `Top rank #${topRank}`;
      } else {
        levelLine.textContent =
          member?.tdh === null ||
          member?.tdh === undefined ||
          member?.tdh === ""
            ? `Level ${optionalDisplayNumber(member?.level)}`
            : `Level ${optionalDisplayNumber(member?.level)} · ` +
              `TDH ${optionalDisplayNumber(member?.tdh)}`;
      }

      const social = card.querySelector(".member-social");
      const xUsername = stringValue(member?.x_username);

      if (xUsername) {
        social.classList.remove("hidden");
        social.textContent = `@${xUsername}`;
      }

      card.querySelector(".member-address").textContent =
        shortenAddress(member.primary_address) || "No public address shown";

      const profileUrl = buildBrainBuzzProfileUrl(member);

      if (profileUrl) {
        card.classList.add("clickable-member");
        card.tabIndex = 0;
        card.setAttribute("role", "link");
        card.setAttribute(
          "aria-label",
          `Open ${name}'s Brain Buzz profile`
        );

        card.addEventListener("click", () => {
          openBrainBuzzProfile(profileUrl);
        });

        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openBrainBuzzProfile(profileUrl);
          }
        });
      }

      fragment.append(card);
    });

    membersView.append(fragment);
  }

  const sortLabel = identitySort === "tdh" ? "TDH" : "Level";

  resultCount.textContent =
    query && visible.length !== members.length
      ? `${visible.length} of ${members.length} identities · ${sortLabel}`
      : `${members.length} identities · ${sortLabel}`;
}


function formatSignedNumber(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return "0";

  const formatted = new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 0,
  }).format(Math.abs(parsed));

  return `${parsed > 0 ? "+" : "−"}${formatted}`;
}

function formatDuration(milliseconds) {
  const value = Math.max(0, Number(milliseconds) || 0);
  const minutes = Math.floor(value / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function createMetricCard(
  label,
  value,
  detail = "",
  { onClick = null, action = "" } = {}
) {
  const card = document.createElement(onClick ? "button" : "article");
  card.className = "metric-card";

  if (onClick) {
    card.type = "button";
    card.classList.add("clickable-metric");
    card.addEventListener("click", onClick);
    card.setAttribute("aria-label", `${label}: ${value}. View identities.`);
  }

  const labelElement = document.createElement("span");
  labelElement.className = "metric-label";
  labelElement.textContent = label;

  const valueElement = document.createElement("strong");
  valueElement.textContent = value;

  card.append(labelElement, valueElement);

  if (detail) {
    const detailElement = document.createElement("p");
    detailElement.textContent = detail;
    card.append(detailElement);
  }

  if (onClick) {
    const actionElement = document.createElement("span");
    actionElement.className = "metric-card-action";
    actionElement.textContent = action || "View identities →";
    card.append(actionElement);
  }

  return card;
}

function moverDestination(entry) {
  const waveIdValue = stringValue(entry?.wave_id);
  if (!waveIdValue) return "";

  const url = new URL(
    `https://6529.io/waves/${encodeURIComponent(waveIdValue)}`
  );

  const dropIdValue = stringValue(entry?.drop_id, entry?.id);
  if (dropIdValue) url.searchParams.set("drop", dropIdValue);

  return url.toString();
}

function renderMovers() {
  const payload = customState.movers.data || {};
  const sourceItems = arrayValue(payload.movers);
  const query = searchInput.value.trim().toLowerCase();

  const visible = query
    ? sourceItems.filter((entry) =>
        [
          entry?.author,
          entry?.title,
          entry?.rank,
          entry?.rank_change,
          entry?.voting_tdh,
          entry?.voting_tdh_change,
          entry?.status,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)
      )
    : sourceItems;

  moversView.replaceChildren();

  if (!sourceItems.length) {
    toolbarElement.classList.add("hidden");

    const baseline = document.createElement("section");
    baseline.className = "movers-baseline";

    const title = document.createElement("h2");
    title.textContent = payload.has_comparison
      ? "No Main Stage movement yet"
      : "Baseline created";

    const message = document.createElement("p");
    message.textContent = payload.has_comparison
      ? `Tracking ${formatLeaderboardScore(
          Number(payload.entries_tracked) || 0
        )} entries. No ranks or Voting TDH values have changed since the baseline.`
      : `Tracking ${formatLeaderboardScore(
          Number(payload.entries_tracked) || 0
        )} Main Stage entries. Check back after voting changes.`;

    const detail = document.createElement("span");
    detail.textContent = payload.baseline_at
      ? `Baseline ${new Date(payload.baseline_at).toLocaleString()}`
      : "Tracking begins with the first visit.";

    baseline.append(title, message, detail);
    moversView.append(baseline);

    resultCount.textContent = "";
    return;
  }

  toolbarElement.classList.remove("hidden");
  searchContainer.classList.remove("hidden");
  statusGroup.classList.remove("hidden");

  const metrics = document.createElement("section");
  metrics.className = "metrics-grid movers-metrics";
  metrics.append(
    createMetricCard(
      "Rank movers",
      formatLeaderboardScore(Number(payload.rank_movers_count) || 0)
    ),
    createMetricCard(
      "TDH gainers",
      formatLeaderboardScore(Number(payload.tdh_gainers_count) || 0)
    ),
    createMetricCard(
      "Tracking age",
      formatDuration(Number(payload.tracking_age_ms) || 0)
    )
  );
  moversView.append(metrics);

  const context = document.createElement("div");
  context.className = "custom-notice";
  context.textContent =
    `Changes since ${new Date(payload.baseline_at).toLocaleString()}.`;
  moversView.append(context);

  const list = document.createElement("section");
  list.className = "movers-list";

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No movers match that filter.";
    list.append(empty);
  } else {
    const fragment = document.createDocumentFragment();

    visible.forEach((entry) => {
      const card = document.createElement("article");
      card.className = "mover-card";

      const destination = moverDestination(entry);
      if (destination) {
        card.classList.add("clickable");
        card.tabIndex = 0;
        card.setAttribute("role", "link");
        card.addEventListener("click", () => {
          window.open(destination, "_blank", "noopener,noreferrer");
        });
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            window.open(destination, "_blank", "noopener,noreferrer");
          }
        });
      }

      const rank = document.createElement("div");
      rank.className = "mover-rank";
      rank.textContent = entry?.rank ? `#${entry.rank}` : "—";

      const copy = document.createElement("div");
      copy.className = "mover-copy";

      const author = document.createElement("p");
      author.className = "mover-author";
      author.textContent = stringValue(entry?.author) || "Unknown artist";

      const title = document.createElement("h2");
      title.textContent =
        stringValue(entry?.title) || "Untitled Main Stage entry";

      const stats = document.createElement("div");
      stats.className = "mover-stats";

      const rankChange = Number(entry?.rank_change) || 0;
      const rankPill = document.createElement("span");
      rankPill.className =
        rankChange > 0
          ? "delta up"
          : rankChange < 0
            ? "delta down"
            : "delta flat";
      rankPill.textContent =
        entry?.status === "new"
          ? "NEW ENTRY"
          : rankChange > 0
            ? `▲ ${rankChange} rank`
            : rankChange < 0
              ? `▼ ${Math.abs(rankChange)} rank`
              : "TDH movement";

      const tdh = document.createElement("span");
      tdh.textContent =
        `Voting TDH ${optionalDisplayNumber(entry?.voting_tdh)}`;

      const tdhChange = document.createElement("span");
      const rawTdhDelta = entry?.voting_tdh_change;
      const tdhDelta =
        rawTdhDelta === null ||
        rawTdhDelta === undefined ||
        rawTdhDelta === ""
          ? null
          : Number(rawTdhDelta);

      tdhChange.className =
        tdhDelta !== null && tdhDelta > 0
          ? "tdh-change positive"
          : tdhDelta !== null && tdhDelta < 0
            ? "tdh-change negative"
            : "tdh-change";
      tdhChange.textContent =
        tdhDelta === null || !Number.isFinite(tdhDelta)
          ? "TDH change —"
          : `${formatSignedNumber(tdhDelta)} TDH`;

      stats.append(rankPill, tdh, tdhChange);
      copy.append(author, title, stats);
      card.append(rank, copy);
      fragment.append(card);
    });

    list.append(fragment);
  }

  moversView.append(list);

  resultCount.textContent =
    query && visible.length !== sourceItems.length
      ? `${visible.length} of ${sourceItems.length} movers`
      : `${sourceItems.length} movers`;
}

function waveUrl(id) {
  return id
    ? `https://6529.io/waves/${encodeURIComponent(id)}`
    : "https://6529.io/";
}

function renderWaveRadar(container, payload) {
  const query = searchInput.value.trim().toLowerCase();
  const waves = arrayValue(payload.hot_waves);
  const visible = query
    ? waves.filter((wave) =>
        [
          wave?.name,
          wave?.creator_handle,
          wave?.subscribers_count,
          wave?.total_drops_count,
        ]
          .join(" ")
          .toLowerCase()
          .includes(query)
      )
    : waves;

  const header = document.createElement("div");
  header.className = "subview-heading";
  header.innerHTML =
    "<div><p>WAVE RADAR</p><h2>Active public Waves</h2></div>" +
    "<span>Ranked by the 6529 hot-Waves view.</span>";
  container.append(header);

  const grid = document.createElement("section");
  grid.className = "radar-grid";

  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = query
      ? "No hot Waves match that filter."
      : "No hot Waves were returned.";
    grid.append(empty);
  } else {
    visible.forEach((wave, index) => {
      const card = document.createElement("a");
      card.className = "radar-card";
      card.href = waveUrl(wave?.id);
      card.target = "_blank";
      card.rel = "noopener noreferrer";

      const rank = document.createElement("span");
      rank.className = "radar-rank";
      rank.textContent = `#${index + 1}`;

      const avatar = document.createElement("div");
      avatar.className = "radar-avatar";

      if (wave?.pfp) {
        const image = document.createElement("img");
        image.alt = "";
        image.loading = "lazy";
        setImageWithFallback(image, wave.pfp, () => {
          avatar.replaceChildren(initial(wave?.name));
        });
        avatar.append(image);
      } else {
        avatar.textContent = initial(wave?.name);
      }

      const copy = document.createElement("div");
      copy.className = "radar-copy";

      const title = document.createElement("h3");
      title.textContent = stringValue(wave?.name) || "Unnamed Wave";

      const meta = document.createElement("p");
      meta.textContent =
        `${formatLeaderboardScore(
          Number(wave?.subscribers_count) || 0
        )} subscribers · ${formatLeaderboardScore(
          Number(wave?.total_drops_count) || 0
        )} drops`;

      const activity = document.createElement("span");
      activity.textContent = wave?.last_drop_time
        ? `Last activity ${formatDate(
            timestampMilliseconds(wave.last_drop_time)
          )}`
        : "Open Wave ↗";

      copy.append(title, meta, activity);
      card.append(rank, avatar, copy);
      grid.append(card);
    });
  }

  container.append(grid);
  resultCount.textContent =
    query && visible.length !== waves.length
      ? `${visible.length} of ${waves.length} hot Waves`
      : `${waves.length} hot Waves`;
}

function dailyBuzzIdentityName(identity) {
  return (
    stringValue(identity?.handle) ||
    shortenAddress(stringValue(identity?.primary_address)) ||
    shortenAddress(stringValue(identity?.consolidation_key)) ||
    "Unknown identity"
  );
}

function dailyBuzzIdentitySearchText(identity) {
  return [
    identity?.handle,
    identity?.primary_address,
    identity?.consolidation_key,
    identity?.level,
    identity?.tdh,
    identity?.rep,
  ]
    .map((value) => stringValue(value).toLowerCase())
    .join(" ");
}

function createDailyBuzzIdentityRow(identity, index) {
  const profileUrl = buildBrainBuzzProfileUrl(identity);
  const row = document.createElement(profileUrl ? "a" : "article");
  row.className = "metric-identity-row";

  if (profileUrl) {
    row.href = profileUrl;
    row.setAttribute(
      "aria-label",
      `Open ${dailyBuzzIdentityName(identity)}'s Brain Buzz profile`
    );
  }

  const rank = document.createElement("span");
  rank.className = "metric-identity-rank";
  rank.textContent = `#${index + 1}`;

  const avatar = document.createElement("div");
  avatar.className = "metric-identity-avatar";

  if (identity?.pfp) {
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    setImageWithFallback(image, identity.pfp, () => {
      avatar.replaceChildren(initial(dailyBuzzIdentityName(identity)));
    });
    avatar.append(image);
  } else {
    avatar.textContent = initial(dailyBuzzIdentityName(identity));
  }

  const copy = document.createElement("div");
  copy.className = "metric-identity-copy";

  const name = document.createElement("strong");
  name.textContent = dailyBuzzIdentityName(identity);

  const address = document.createElement("span");
  address.textContent =
    shortenAddress(
      stringValue(identity?.primary_address, identity?.consolidation_key)
    ) || "No public wallet shown";

  const stats = document.createElement("div");
  stats.className = "metric-identity-stats";

  const level = Number(identity?.level);
  if (Number.isFinite(level)) {
    const item = document.createElement("span");
    item.textContent = `Level ${formatLeaderboardScore(level)}`;
    stats.append(item);
  }

  const tdh = Number(identity?.tdh);
  if (Number.isFinite(tdh)) {
    const item = document.createElement("span");
    item.textContent = `${formatLeaderboardScore(tdh)} TDH`;
    stats.append(item);
  }

  const rep = Number(identity?.rep);
  if (identity?.rep !== null && identity?.rep !== undefined && Number.isFinite(rep)) {
    const item = document.createElement("span");
    item.textContent = `${formatLeaderboardScore(rep)} holder REP`;
    stats.append(item);
  }

  copy.append(name, address);
  if (stats.childElementCount) copy.append(stats);
  row.append(rank, avatar, copy);
  return row;
}

function resetDailyBuzzIdentityState(metric = "") {
  dailyBuzzIdentityState.activeMetric = metric;
  dailyBuzzIdentityState.items = [];
  dailyBuzzIdentityState.page = 0;
  dailyBuzzIdentityState.total = null;
  dailyBuzzIdentityState.hasMore = false;
  dailyBuzzIdentityState.loading = false;
  dailyBuzzIdentityState.error = "";
  dailyBuzzIdentityState.query = "";
}

async function loadDailyBuzzIdentities(metric, { replace = false } = {}) {
  if (dailyBuzzIdentityState.loading) return;

  if (replace || dailyBuzzIdentityState.activeMetric !== metric) {
    resetDailyBuzzIdentityState(metric);
  }

  dailyBuzzIdentityState.loading = true;
  dailyBuzzIdentityState.error = "";
  renderExplore();

  try {
    const nextPage = replace ? 1 : dailyBuzzIdentityState.page + 1;
    const url = new URL("/api/daily-buzz-identities", window.location.origin);
    url.searchParams.set("metric", metric);
    url.searchParams.set("page", String(nextPage));
    url.searchParams.set("page_size", "50");

    const response = await fetch(url, { cache: "no-store" });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload?.error || "Unable to load identities.");
    }

    const incoming = arrayValue(payload?.identities);
    const merged = new Map(
      dailyBuzzIdentityState.items.map((identity) => [
        stringValue(
          identity?.key,
          identity?.consolidation_key,
          identity?.primary_address,
          identity?.handle
        ).toLowerCase(),
        identity,
      ])
    );

    for (const identity of incoming) {
      const key = stringValue(
        identity?.key,
        identity?.consolidation_key,
        identity?.primary_address,
        identity?.handle,
        `row-${merged.size}`
      ).toLowerCase();
      merged.set(key, identity);
    }

    dailyBuzzIdentityState.items = [...merged.values()];
    dailyBuzzIdentityState.page = Number(payload?.page) || nextPage;
    dailyBuzzIdentityState.total = Number.isFinite(Number(payload?.total))
      ? Number(payload.total)
      : null;
    dailyBuzzIdentityState.hasMore = Boolean(payload?.has_more);
  } catch (error) {
    dailyBuzzIdentityState.error =
      error instanceof Error ? error.message : String(error);
  } finally {
    dailyBuzzIdentityState.loading = false;
    renderExplore();
  }
}

function openDailyBuzzMetric(metric) {
  const isSameMetric = dailyBuzzIdentityState.activeMetric === metric;

  if (isSameMetric && dailyBuzzIdentityState.items.length) {
    document
      .querySelector("#daily-buzz-identity-panel")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  resetDailyBuzzIdentityState(metric);
  renderExplore();
  void loadDailyBuzzIdentities(metric, { replace: true });
}

function renderDailyBuzzIdentityPanel(container) {
  const metric = dailyBuzzIdentityState.activeMetric;
  const copy = DAILY_BUZZ_METRIC_COPY[metric];
  if (!metric || !copy) return;

  const panel = document.createElement("section");
  panel.id = "daily-buzz-identity-panel";
  panel.className = "metric-identities-panel";

  const heading = document.createElement("div");
  heading.className = "metric-identities-heading";

  const headingCopy = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.textContent = "IDENTITIES IN THIS METRIC";
  const title = document.createElement("h3");
  title.textContent = copy.label;
  const count = document.createElement("p");
  const total = dailyBuzzIdentityState.total;
  count.textContent = Number.isFinite(total)
    ? `${dailyBuzzIdentityState.items.length} loaded of ${formatLeaderboardScore(total)}`
    : `${dailyBuzzIdentityState.items.length} loaded`;
  headingCopy.append(eyebrow, title, count);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "metric-panel-close";
  close.textContent = "Close";
  close.addEventListener("click", () => {
    resetDailyBuzzIdentityState();
    renderExplore();
  });

  heading.append(headingCopy, close);
  panel.append(heading);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "metric-identity-search";
  search.placeholder = "Search loaded identities";
  search.value = dailyBuzzIdentityState.query;
  search.setAttribute("aria-label", `Search ${copy.label}`);

  const list = document.createElement("div");
  list.className = "metric-identity-list";

  const renderRows = () => {
    const query = dailyBuzzIdentityState.query.trim().toLowerCase();
    const visible = query
      ? dailyBuzzIdentityState.items.filter((identity) =>
          dailyBuzzIdentitySearchText(identity).includes(query)
        )
      : dailyBuzzIdentityState.items;

    list.replaceChildren();

    if (!visible.length && !dailyBuzzIdentityState.loading) {
      const empty = document.createElement("div");
      empty.className = "metric-panel-message";
      empty.textContent = query
        ? "No loaded identities match that search."
        : "No identities were returned for this metric.";
      list.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    visible.forEach((identity) => {
      const absoluteIndex = dailyBuzzIdentityState.items.indexOf(identity);
      fragment.append(createDailyBuzzIdentityRow(identity, absoluteIndex));
    });
    list.append(fragment);
  };

  search.addEventListener("input", () => {
    dailyBuzzIdentityState.query = search.value;
    renderRows();
  });

  panel.append(search);

  if (dailyBuzzIdentityState.error) {
    const error = document.createElement("div");
    error.className = "metric-panel-error";
    error.textContent = dailyBuzzIdentityState.error;
    panel.append(error);
  }

  renderRows();
  panel.append(list);

  const footer = document.createElement("div");
  footer.className = "metric-identities-footer";

  const hint = document.createElement("span");
  hint.textContent = dailyBuzzIdentityState.hasMore
    ? "Search covers loaded identities. Load more to expand the list."
    : "End of this metric’s identity list.";
  footer.append(hint);

  if (dailyBuzzIdentityState.loading) {
    const loading = document.createElement("span");
    loading.className = "metric-panel-loading";
    loading.textContent = "Loading identities…";
    footer.append(loading);
  } else if (dailyBuzzIdentityState.hasMore) {
    const loadMore = document.createElement("button");
    loadMore.type = "button";
    loadMore.className = "button secondary metric-load-more";
    loadMore.textContent = "Load 50 more";
    loadMore.addEventListener("click", () => {
      void loadDailyBuzzIdentities(metric);
    });
    footer.append(loadMore);
  } else if (dailyBuzzIdentityState.error) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button secondary metric-load-more";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void loadDailyBuzzIdentities(metric, {
        replace: dailyBuzzIdentityState.items.length === 0,
      });
    });
    footer.append(retry);
  }

  panel.append(footer);
  container.append(panel);
}

function renderDailyBuzz(container, payload) {
  const daily = payload.daily_buzz || {};

  const header = document.createElement("div");
  header.className = "subview-heading";
  header.innerHTML =
    "<div><p>DAILY BUZZ</p><h2>6529 network snapshot</h2></div>" +
    "<span>Current totals from public 6529 network data.</span>";
  container.append(header);

  const metrics = document.createElement("section");
  metrics.className = "metrics-grid explore-metrics";

  for (const [metric, copy] of Object.entries(DAILY_BUZZ_METRIC_COPY)) {
    metrics.append(
      createMetricCard(
        copy.label,
        optionalDisplayNumber(daily[metric]),
        copy.detail,
        {
          onClick: () => openDailyBuzzMetric(metric),
          action:
            dailyBuzzIdentityState.activeMetric === metric
              ? "Identity list open ↓"
              : "View identities →",
        }
      )
    );
  }

  container.append(metrics);
  renderDailyBuzzIdentityPanel(container);

  const note = document.createElement("div");
  note.className = "custom-notice";
  note.textContent =
    "These are current public totals. They may change whenever the 6529 network data updates.";
  container.append(note);

  resultCount.textContent = "Current network totals";
}

function renderHotWaves() {
  const payload = customState.explore.data || {};
  exploreView.replaceChildren();
  renderWaveRadar(exploreView, payload);
}

function renderExplore() {
  const payload = customState.explore.data || {};
  exploreView.replaceChildren();
  renderDailyBuzz(exploreView, payload);
}

function renderActiveView() {
  if (activeView === "members") renderMembers();
  else if (activeView === "movers") renderMovers();
  else if (activeView === "radar") renderHotWaves();
  else if (activeView === "explore") renderExplore();
  else renderFeed();
}


function setLoading(value, loadingOlder = false) {
  isLoading = value;
  refreshButton.disabled = value;
  loadMoreButton.disabled = value;
  refreshButton.textContent = value && !loadingOlder ? "Refreshing…" : "Refresh";
  loadMoreButton.textContent =
    value && loadingOlder
      ? "Loading…"
      : activeView === "punk"
        ? "Load previous day"
        : activeView === "mainstage"
          ? "Load more entries"
          : "Load older posts";

  const activeItems =
    activeView === "members"
      ? members
      : activeView === "movers" || activeView === "explore"
        ? customState[activeView]?.data
          ? [customState[activeView].data]
          : []
        : feedState[activeView]?.items || [];

  if (value && activeItems.length === 0) {
    loadingElement.textContent =
      activeView === "top"
        ? "Scanning recent Drops for Top 100 member posts…"
        : activeView === "mainstage"
          ? "Loading the Main Stage leaderboard…"
          : activeView === "movers"
            ? "Comparing Main Stage snapshots…"
            : activeView === "explore"
              ? "Loading discovery views…"
              : activeView === "punk"
                ? "Loading Punk6529’s posts directly by author…"
                : activeView === "members"
                  ? "Loading the identity directory…"
                  : "Loading public chats…";
  }

  loadingElement.classList.toggle(
    "hidden",
    !(value && activeItems.length === 0)
  );
}

function clearMessages() {
  errorElement.textContent = "";
  errorElement.classList.add("hidden");
  warningElement.textContent = "";
  warningElement.classList.add("hidden");
}

function showError(error) {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";

  errorElement.textContent =
    `${message}\n\nThe site will automatically retry rate-limited API requests. Try Refresh again after a short wait if needed.`;
  errorElement.classList.remove("hidden");
}

function showWarnings(warnings) {
  const values = arrayValue(warnings).filter((value) => {
    const text = String(value || "").toLowerCase();
    return (
      text &&
      !text.includes("stored in server memory") &&
      !text.includes("resets after a restart") &&
      !text.includes("resets after a redeploy")
    );
  });

  if (!values.length) return;

  warningElement.textContent =
    "Some source data did not load, so this page may be incomplete.";
  warningElement.title = values.join(" | ");
  warningElement.classList.remove("hidden");
}

async function loadDetailedMembersInBackground() {
  if (memberDetailsLoading || memberDetailsLoaded) return;

  memberDetailsLoading = true;

  try {
    const response = await fetch("/api/top-members?details=1", {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) return;

    members = arrayValue(payload.data);
    memberDetailsLoaded = true;

    if (activeView === "members") {
      lastUpdated.textContent =
        `Identity names updated ${new Date().toLocaleTimeString()}`;
      renderMembers();
    }
  } catch (error) {
    console.error("Detailed member loading failed:", error);
  } finally {
    memberDetailsLoading = false;
  }
}

async function loadMembers({ force = false } = {}) {
  if (membersLoaded && !force) {
    void loadDetailedMembersInBackground();
    return;
  }

  const response = await fetch(
    force ? "/api/top-members?refresh=1" : "/api/top-members",
    { cache: "no-store" }
  );
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      payload.error || `Identity request failed with HTTP ${response.status}.`
    );
  }

  members = arrayValue(payload.data);
  membersLoaded = true;

  if (force) {
    memberDetailsLoaded = false;
  }

  void loadDetailedMembersInBackground();
}

async function fetchFeedPage(
  view,
  page,
  { replace = false, loadingOlder = false } = {}
) {
  const state = feedState[view];
  if (state.loading) return;

  state.loading = true;

  if (activeView === view) {
    setLoading(true, loadingOlder);
    clearMessages();
  }

  try {
    const response = await fetch(`${state.endpoint}?page=${page}`, {
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        payload.error || `Feed request failed with HTTP ${response.status}.`
      );
    }

    state.items = sortFeedItemsForView(
      view,
      mergeItems(state.items, arrayValue(payload.data), replace)
    );
    state.page = page;
    state.hasMore = Boolean(payload.has_more);
    state.loaded = true;

    showWarnings(payload.warnings);

    if (
      view === "punk" &&
      Number(payload.complete_day_count || 0) > 0
    ) {
      lastUpdated.textContent =
        `${payload.complete_day_count} complete days · ` +
        `updated ${new Date().toLocaleTimeString()}`;
    } else {
      lastUpdated.textContent =
        `Updated ${new Date().toLocaleTimeString()}`;
    }

    if (activeView === view) {
      loadMoreButton.classList.toggle("hidden", !state.hasMore);
      renderFeed();
    }

  } catch (error) {
    if (activeView === view) {
      showError(error);
    }
  } finally {
    state.loading = false;

    if (activeView === view) {
      setLoading(false, loadingOlder);
    }
  }
}

async function loadCustomView(view, { force = false } = {}) {
  const state = view === "radar" ? customState.explore : customState[view];
  if (!state || state.loading) return;

  if (state.loaded && !force) {
    renderActiveView();
    return;
  }

  state.loading = true;
  setLoading(true);
  clearMessages();

  try {
    const separator = state.endpoint.includes("?") ? "&" : "?";
    const response = await fetch(
      `${state.endpoint}${force ? `${separator}refresh=1` : ""}`,
      { cache: "no-store" }
    );
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        payload.error ||
        `View request failed with HTTP ${response.status}.`
      );
    }

    state.data = payload;
    state.loaded = true;

    if (view === "movers") {
      lastUpdated.textContent =
        `Tracking updated ${new Date().toLocaleTimeString()}`;
    } else if (view === "radar") {
      lastUpdated.textContent =
        `Hot Waves updated ${new Date().toLocaleTimeString()}`;
    } else {
      lastUpdated.textContent =
        `Daily Buzz updated ${new Date().toLocaleTimeString()}`;
    }

    showWarnings(payload.warnings);
    renderActiveView();
  } catch (error) {
    showError(error);
  } finally {
    state.loading = false;
    setLoading(false);
  }
}

async function loadActiveView({ force = false } = {}) {
  clearMessages();

  if (
    activeView === "movers" ||
    activeView === "radar" ||
    activeView === "explore"
  ) {
    await loadCustomView(activeView, { force });
    return;
  }

  if (activeView === "members") {
    if (!membersLoaded || force) {
      setLoading(true);

      try {
        await loadMembers({ force });
        lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
      } catch (error) {
        showError(error);
      } finally {
        setLoading(false);
      }
    }

    renderMembers();
    return;
  }

  const state = feedState[activeView];

  if (!state.loaded || force) {
    await fetchFeedPage(activeView, 1, { replace: force });
  } else {
    renderFeed();
  }
}

async function switchView(view) {
  const previousView = activeView;
  activeView = view;
  searchInput.value = "";
  clearMessages();

  const group = viewGroup(view);

  tabButtons.forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.group === group
    );
  });

  subtabButtons.forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.view === view
    );
  });

  mainstageSubtabs.classList.toggle(
    "hidden",
    group !== "mainstage"
  );
  wavesSubtabs.classList.toggle(
    "hidden",
    group !== "waves"
  );

  const copy = viewCopy[view];
  viewDescription.textContent = copy.description;
  notice.innerHTML = copy.notice;
  searchInput.placeholder = copy.placeholder;

  toolbarElement.classList.remove("hidden");
  searchContainer.classList.toggle("hidden", view === "explore");
  statusGroup.classList.remove("hidden");

  const isFeedView =
    view !== "members" &&
    view !== "movers" &&
    view !== "radar" &&
    view !== "explore";

  feedView.classList.toggle("hidden", !isFeedView);
  moversView.classList.toggle("hidden", view !== "movers");
  exploreView.classList.toggle(
    "hidden",
    view !== "radar" && view !== "explore"
  );
  membersView.classList.toggle("hidden", view !== "members");
  identityControls.classList.toggle("hidden", view !== "members");
  loadMoreWrap.classList.toggle("hidden", !isFeedView);

  if (view === "members") {
    if (previousView !== view && !membersLoaded) {
      membersView.replaceChildren();
      resultCount.textContent = "Loading Top 100 identities…";
      loadingElement.textContent = "Loading Top 100 identities…";
      loadingElement.classList.remove("hidden");
    }
  } else if (
    view === "movers" ||
    view === "radar" ||
    view === "explore"
  ) {
    const state =
      view === "radar" ? customState.explore : customState[view];
    loadMoreButton.classList.add("hidden");

    if (previousView !== view) {
      const container = view === "movers" ? moversView : exploreView;
      container.replaceChildren();

      if (state.loaded) {
        renderActiveView();
      } else {
        const loadingMessage = document.createElement("div");
        loadingMessage.className = "loading";
        loadingMessage.textContent =
          view === "movers"
            ? "Comparing Main Stage snapshots…"
            : view === "radar"
              ? "Loading Hot Waves…"
              : "Loading Daily Buzz metrics…";
        container.append(loadingMessage);
        resultCount.textContent = "Loading…";
      }
    }
  } else {
    const state = feedState[view];
    loadMoreButton.classList.toggle(
      "hidden",
      !state.hasMore || !state.loaded
    );
    loadMoreButton.textContent =
      view === "mainstage"
        ? "Load more entries"
        : "Load older posts";

    if (previousView !== view) {
      feedView.replaceChildren();

      if (state.loaded) {
        renderFeed();
      } else {
        const loadingMessage = document.createElement("div");
        loadingMessage.className = "loading";

        if (view === "mainstage") {
          loadingMessage.textContent =
            "Loading the Main Stage leaderboard…";
        } else if (view === "top") {
          loadingMessage.textContent =
            "Scanning recent Drops for Top 100 identity posts…";
        } else if (view === "punk") {
          loadingMessage.textContent =
            "Loading Punk6529’s posts directly by author…";
        } else {
          loadingMessage.textContent = "Loading Wave chats…";
        }

        feedView.append(loadingMessage);
        resultCount.textContent = "Loading…";
      }
    }
  }

  await loadActiveView();
}

tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    void switchView(button.dataset.view);
  });
});

subtabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    void switchView(button.dataset.view);
  });
});

identitySortButtons.forEach((button) => {
  button.addEventListener("click", () => {
    identitySort = button.dataset.identitySort || "level";
    updateIdentitySortControls();
    renderMembers();
  });
});

refreshButton.addEventListener("click", () => {
  void loadActiveView({ force: true });
});

loadMoreButton.addEventListener("click", () => {
  if (
    activeView === "members" ||
    activeView === "movers" ||
    activeView === "radar" ||
    activeView === "explore"
  ) return;

  const state = feedState[activeView];
  void fetchFeedPage(activeView, state.page + 1, {
    loadingOlder: true,
  });
});

searchInput.addEventListener("input", renderActiveView);

void loadActiveView();

refreshTimer = window.setInterval(() => {
  if (document.hidden || isLoading) return;

  if (activeView === "movers") {
    void loadCustomView("movers", { force: true });
  } else if (
    activeView !== "members" &&
    activeView !== "radar" &&
    activeView !== "explore"
  ) {
    void fetchFeedPage(activeView, 1);
  }
}, REFRESH_INTERVAL_MS);

window.addEventListener("beforeunload", () => {
  if (refreshTimer) window.clearInterval(refreshTimer);
});
