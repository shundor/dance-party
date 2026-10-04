// Read-only list of every song ever played, newest first, grouped by day.
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function dayLabel(ts) {
  if (!ts) return "Earlier";
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return dayFmt.format(d);
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), bad ? 6000 : 3000);
}

// Joined guests/admins can re-queue songs from here; everyone else just browses.
const token = localStorage.getItem("dp_token");
let socket = null;
let inQueue = new Set(); // video ids queued or playing right now

function addButton(item) {
  const b = el("button", { className: "icon-btn add-btn", type: "button" });
  b.dataset.videoId = item.videoId;
  b.addEventListener("click", () => {
    if (!socket?.connected) return toast("Not connected. Try again in a moment.", true);
    b.disabled = true;
    socket.timeout(15000).emit("queue:add", { videoId: item.videoId }, (err, res) => {
      if (err) res = { ok: false, error: "No response from the server." };
      if (res.ok) toast(`Added: ${res.title}`);
      else toast(res.error, true);
      updateButtons();
    });
  });
  return b;
}

function updateButtons() {
  for (const b of document.querySelectorAll(".add-btn")) {
    const queued = inQueue.has(b.dataset.videoId);
    b.textContent = queued ? "✓" : "+";
    b.disabled = queued;
    b.title = queued ? "Already in the queue" : "Add to the queue";
    b.setAttribute("aria-label", b.title);
  }
}

function row(item) {
  const sub = [item.playedAt ? timeFmt.format(item.playedAt) : null, item.addedBy ? `Added by ${item.addedBy}` : item.channel];
  const link = el("a", {
    className: "song-link",
    href: `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`,
    target: "_blank",
    rel: "noopener",
  });
  link.append(
    el("img", { src: item.thumbnail, alt: "", loading: "lazy" }),
    el(
      "div",
      { className: "meta" },
      el("div", { className: "title", textContent: item.title }),
      el("div", { className: "sub", textContent: sub.filter(Boolean).join(" · ") }),
    ),
  );
  return el("div", { className: "song" }, link, socket ? addButton(item) : null);
}

let next = null;
let lastDay = null;
let request = 0;

async function load({ reset = false } = {}) {
  const id = ++request;
  const params = new URLSearchParams({ limit: "50" });
  const q = $("search").value.trim();
  if (q) params.set("q", q);
  if (!reset && next) params.set("before", next);
  $("more").disabled = true;
  let data;
  try {
    const res = await fetch(`/api/history?${params}`);
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    if (id === request) $("list").replaceChildren(el("div", { className: "empty", textContent: "Couldn't load the history." }));
    return;
  }
  if (id !== request) return; // a newer search replaced this one

  const list = $("list");
  if (reset) {
    list.replaceChildren();
    lastDay = null;
  }
  for (const item of data.items) {
    const day = dayLabel(item.playedAt);
    if (day !== lastDay) {
      list.append(el("h3", { className: "day", textContent: day }));
      lastDay = day;
    }
    list.append(row(item));
  }
  if (!list.children.length) {
    list.append(el("div", { className: "empty", textContent: q ? "No played songs match." : "No songs played yet." }));
  }
  updateButtons();
  $("total").textContent = data.total ? `${data.total} ${data.total === 1 ? "song" : "songs"}` : "";
  next = data.next;
  $("more").classList.toggle("hidden", !next);
  $("more").disabled = false;
}

let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load({ reset: true }), 250);
});
$("more").addEventListener("click", () => load());

async function connect() {
  if (!token) return false;
  const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!res?.ok) return false;
  const me = await res.json();
  socket = io({ auth: { token } });
  socket.on("state", (s) => {
    inQueue = new Set([s.current, ...s.queue].filter(Boolean).map((q) => q.videoId));
    updateButtons();
  });
  socket.on("connect_error", (err) => {
    if (err.message === "unauthorized") toast("Your session ended. Join again to add songs.", true);
  });
  $("back").href = "/remote";
  $("back").textContent = "‹ Back";
  $("join").textContent = me.role === "admin" ? `${me.name} ★` : me.name;
  $("join").removeAttribute("href");
  return true;
}

(async () => {
  const joined = await connect();
  $("join-hint").classList.toggle("hidden", joined);
  load({ reset: true });
})();
