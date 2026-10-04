const $ = (id) => document.getElementById(id);
const token = localStorage.getItem("dp_token");
if (!token) location.replace("/");

let me = null;
let state = null;
let toastTimer;

function leave() {
  localStorage.removeItem("dp_token");
  location.replace("/");
}

function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("bad", bad);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), bad ? 6000 : 3000);
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function songRow(item, { index, actions } = {}) {
  const sub = el("div", { className: "sub" });
  if (item.owner && me && item.owner === me.owner) sub.append(el("span", { className: "mine", textContent: "You" }));
  else if (item.addedBy) sub.append(`Added by ${item.addedBy}`);
  else sub.append(item.channel || "");
  return el(
    "div",
    { className: "song" },
    index != null ? el("span", { className: "num", textContent: String(index) }) : null,
    el("img", { src: item.thumbnail, alt: "", loading: "lazy" }),
    el("div", { className: "meta" }, el("div", { className: "title", textContent: item.title }), sub),
    ...(actions ?? []),
  );
}

function iconBtn(label, title, onClick, danger = false) {
  const b = el("button", { className: `icon-btn${danger ? " danger" : ""}`, type: "button", textContent: label, title });
  b.setAttribute("aria-label", title);
  b.addEventListener("click", onClick);
  return b;
}

const socket = io({ auth: { token }, autoConnect: false });

function send(event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(15000).emit(event, payload, (err, res) => {
      if (err) res = { ok: false, error: "No response from the server." };
      if (!res.ok) toast(res.error, true);
      resolve(res);
    });
  });
}

function render() {
  if (!state || !me) return;
  const isAdmin = me.role === "admin";

  const now = $("now");
  now.replaceChildren(
    state.current
      ? Object.assign(songRow(state.current), { className: "song now" })
      : el("div", { className: "empty", textContent: "Nothing playing. Add a song!" }),
  );
  $("paused").classList.toggle("hidden", !state.paused || !state.current);
  $("admin-controls").classList.toggle("hidden", !isAdmin);

  const mine = state.queue.filter((q) => q.owner === me.owner).length;
  $("limit").textContent = isAdmin ? "" : `${mine}/${state.guestLimit} queued`;
  $("queue-count").textContent = state.queue.length ? String(state.queue.length) : "";

  const queue = $("queue");
  if (!state.queue.length) {
    queue.replaceChildren(el("div", { className: "empty", textContent: "The queue is empty." }));
    return;
  }
  queue.replaceChildren(
    ...state.queue.map((item, i) =>
      songRow(item, {
        index: i + 1,
        actions: isAdmin
          ? [
              i > 0 ? iconBtn("⤒", "Play next", () => send("queue:promote", { id: item.id })) : null,
              iconBtn("✕", "Remove", () => {
                if (confirm(`Remove "${item.title}"?`)) send("queue:remove", { id: item.id });
              }, true),
            ].filter(Boolean)
          : [],
      }),
    ),
  );
}

async function add(payload) {
  const res = await send("queue:add", payload);
  if (res.ok) {
    toast(`Added: ${res.title}`);
    $("add-input").value = "";
    $("results").replaceChildren();
  }
  return res;
}

function looksLikeLink(s) {
  return /youtu\.?be|^[A-Za-z0-9_-]{11}$/.test(s.trim());
}

$("add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = $("add-input").value.trim();
  if (!value) return;
  const btn = $("add-btn");
  btn.disabled = true;
  try {
    if (looksLikeLink(value) || !me.searchEnabled) {
      await add({ input: value });
    } else {
      await search(value);
    }
  } finally {
    btn.disabled = false;
  }
});

async function search(q) {
  const results = $("results");
  results.replaceChildren(el("div", { className: "empty", textContent: "Searching…" }));
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) return leave();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (!data.results.length) {
      results.replaceChildren(el("div", { className: "empty", textContent: "No results." }));
      return;
    }
    results.replaceChildren(
      ...data.results.map((r) =>
        songRow(r, {
          actions: [
            iconBtn("＋", "Add to queue", async (e) => {
              e.currentTarget.disabled = true;
              await add({ videoId: r.videoId });
            }),
          ],
        }),
      ),
    );
  } catch (err) {
    results.replaceChildren(el("div", { className: "empty", textContent: err.message || "Search failed." }));
  }
}

$("toggle").addEventListener("click", () => send("player:toggle"));
$("skip").addEventListener("click", () => send("player:skip"));
$("leave").addEventListener("click", () => {
  if (confirm("Leave the room?")) leave();
});

socket.on("state", (s) => {
  state = s;
  render();
});
socket.on("session:invalid", leave);
socket.on("notice", (n) => toast(n.message, true));
socket.on("connect_error", (err) => {
  if (err.message === "unauthorized") leave();
});

(async () => {
  const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return leave();
  me = await res.json();
  $("who").textContent = me.role === "admin" ? `${me.name} ★` : me.name;
  $("add-input").placeholder = me.searchEnabled ? "Search or paste a YouTube link" : "Paste a YouTube link";
  socket.connect();
  render();
})();
