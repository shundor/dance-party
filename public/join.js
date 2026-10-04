const $ = (id) => document.getElementById(id);
const code = $("code");
const name = $("name");
const pin = $("pin");
const play = $("play");
const error = $("error");

const NAME_MAX = 12;
// /admin is a direct admin link: no room code, just name + PIN. "#pin=1234" pre-fills the PIN
// (the fragment never reaches the server or its logs).
const adminMode = location.pathname.replace(/\/$/, "") === "/admin";
const hashPin = new URLSearchParams(location.hash.slice(1)).get("pin");

// Already joined and still valid? Go straight to the remote (on /admin, only if already an admin).
const saved = localStorage.getItem("dp_token");
if (saved) {
  fetch("/api/me", { headers: { Authorization: `Bearer ${saved}` } }).then(async (r) => {
    if (!r.ok) return localStorage.removeItem("dp_token");
    const me = await r.json();
    if (!adminMode || me.role === "admin") location.replace("/remote");
  });
}

if (adminMode) {
  document.title = "Dance Party! — Admin";
  $("code-wrap").classList.add("hidden");
  $("pin-wrap").classList.remove("hidden");
  $("host").parentElement.classList.add("hidden");
  pin.placeholder = "Enter admin PIN";
  if (hashPin) {
    pin.value = hashPin;
    history.replaceState(null, "", location.pathname);
  }
}

const params = new URLSearchParams(location.search);
if (params.get("code")) code.value = params.get("code").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
name.value = localStorage.getItem("dp_name") || "";

function update() {
  code.value = code.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  $("count").textContent = String(NAME_MAX - name.value.length);
  const ready = adminMode ? pin.value.trim().length > 0 : code.value.length === 4;
  play.disabled = !ready || name.value.trim().length === 0;
}
for (const el of [code, name, pin]) el.addEventListener("input", update);
update();
if (adminMode) (name.value ? pin : name).focus();
else (code.value.length === 4 ? name : code).focus();

$("host").addEventListener("click", () => {
  $("pin-wrap").classList.toggle("hidden");
  if (!$("pin-wrap").classList.contains("hidden")) pin.focus();
});

$("join").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (play.disabled) return;
  error.textContent = "";
  play.disabled = true;
  try {
    const body = adminMode
      ? { admin: true, name: name.value, pin: pin.value }
      : { code: code.value, name: name.value, pin: pin.value };
    const res = await fetch("/api/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not join.");
    localStorage.setItem("dp_token", data.token);
    localStorage.setItem("dp_name", data.name);
    location.replace("/remote");
  } catch (err) {
    error.textContent = err.message;
    update();
  }
});
