// Read-only queue view: no sign-in, no controls, updates live.
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function ago(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

function songRow(item, { index, className = "song", when } = {}) {
  const sub = [item.addedBy ? `Added by ${item.addedBy}` : item.channel || ""];
  if (when) sub.push(when);
  return el(
    "div",
    { className },
    index != null ? el("span", { className: "num", textContent: String(index) }) : null,
    el("img", { src: item.thumbnail, alt: "", loading: "lazy" }),
    el(
      "div",
      { className: "meta" },
      el("div", { className: "title", textContent: item.title }),
      el("div", { className: "sub", textContent: sub.filter(Boolean).join(" · ") }),
    ),
  );
}

const empty = (text) => el("div", { className: "empty", textContent: text });

let state = null;

function render() {
  if (!state) return;
  $("now").replaceChildren(state.current ? songRow(state.current, { className: "song now" }) : empty("Nothing playing right now."));
  $("paused").classList.toggle("hidden", !state.paused || !state.current);

  $("queue-count").textContent = state.queue.length ? String(state.queue.length) : "";
  $("queue").replaceChildren(
    ...(state.queue.length ? state.queue.map((item, i) => songRow(item, { index: i + 1 })) : [empty("The queue is empty.")]),
  );

  $("recent").replaceChildren(
    ...(state.recent.length
      ? state.recent.map((item) => songRow(item, { when: item.playedAt ? ago(item.playedAt) : "" }))
      : [empty("No songs played yet.")]),
  );
}

const socket = io({ auth: { viewer: true } });
socket.on("state", (s) => {
  state = s;
  render();
});
socket.on("connect", () => $("offline").classList.add("hidden"));
socket.on("disconnect", () => $("offline").classList.remove("hidden"));

// Keep the "x min ago" labels fresh.
setInterval(render, 30000);
