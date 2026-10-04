/* global io, YT */
(() => {
  const $ = (id) => document.getElementById(id);
  const key = new URLSearchParams(location.search).get("key") || "";

  let player = null;
  let playerReady = false;
  let hasPlayed = false; // whether the loaded item actually started (ignore autoplay-blocked pauses)
  let autoplayTimer;
  let soundBlocked = false;
  let state = null;
  let loadedId = null; // queue item id currently loaded in the player
  let l3Timer;
  // YouTube refuses some embeds (error 150) when the page is opened by IP address; hostnames are fine.
  const isIpOrigin = /^[\d.]+$|^\[/.test(location.hostname) && !["127.0.0.1", "[::1]"].includes(location.hostname);
  let tvHost = null;

  function fatal(msg) {
    $("fatal").textContent = msg;
    $("fatal").classList.remove("hidden");
  }

  async function loadInfo() {
    const res = await fetch(`/api/tv?key=${encodeURIComponent(key)}`);
    if (!res.ok) return fatal("This TV link is missing or has the wrong key. Use the TV URL printed when the server started.");
    const info = await res.json();
    tvHost = info.tvHost;
    const shortUrl = info.baseUrl.replace(/^https?:\/\//, "");
    for (const id of ["idle-qr", "badge-qr"]) {
      const img = Object.assign(document.createElement("img"), { src: info.qr, alt: "Scan to join" });
      $(id).replaceChildren(img);
    }
    for (const id of ["idle-url", "badge-url"]) $(id).textContent = shortUrl;
    for (const id of ["idle-code", "badge-code"]) $(id).textContent = info.roomCode;
  }

  const socket = io({ auth: { tvKey: key }, autoConnect: false });
  socket.on("connect_error", (err) => {
    if (err.message === "unauthorized") fatal("TV key rejected.");
  });
  socket.on("state", (s) => {
    state = s;
    if ($("badge-code").textContent !== s.roomCode) loadInfo();
    sync();
  });

  function showLowerThird() {
    const cur = state?.current;
    if (!cur) return;
    $("l3-title").textContent = cur.title;
    $("l3-sub").textContent = `Added by ${cur.addedBy}`;
    const next = state.queue[0];
    $("l3-next").textContent = next ? `Up next: ${next.title}` : "";
    $("l3").classList.remove("off");
    clearTimeout(l3Timer);
    l3Timer = setTimeout(() => $("l3").classList.add("off"), 10000);
  }

  function sync() {
    if (!state) return;
    const cur = state.current;
    $("idle").classList.toggle("hidden", !!cur);
    $("badge").classList.toggle("hidden", !cur);
    if (!playerReady) return;

    if (!cur) {
      if (loadedId !== null) player.stopVideo();
      loadedId = null;
      clearTimeout(autoplayTimer);
      $("l3").classList.add("off");
      return;
    }
    if (cur.id !== loadedId) {
      loadedId = cur.id;
      hasPlayed = false;
      player.loadVideoById(cur.videoId);
      showLowerThird();
      watchAutoplay();
      return;
    }
    const ps = player.getPlayerState();
    if (state.paused && ps === YT.PlayerState.PLAYING) player.pauseVideo();
    if (!state.paused && (ps === YT.PlayerState.PAUSED || ps === YT.PlayerState.CUED)) player.playVideo();
  }

  // Browsers may block autoplay with sound until someone clicks the page. If the video hasn't
  // started shortly after loading, play it muted and ask for one click to turn the sound on.
  function watchAutoplay() {
    clearTimeout(autoplayTimer);
    autoplayTimer = setTimeout(() => {
      if (hasPlayed || loadedId === null || state?.paused) return;
      soundBlocked = true;
      player.mute();
      player.playVideo();
      $("start").classList.remove("hidden");
    }, 2500);
  }

  function enableSound() {
    $("start").classList.add("hidden");
    document.documentElement.requestFullscreen?.().catch(() => {});
    if (!playerReady) return;
    soundBlocked = false;
    player.unMute();
    player.setVolume(100);
    if (loadedId !== null && !state?.paused) player.playVideo();
  }

  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player("player", {
      width: "100%",
      height: "100%",
      playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3 },
      events: {
        onReady: () => {
          playerReady = true;
          sync();
        },
        onStateChange: (e) => {
          if (loadedId === null) return;
          if (e.data === YT.PlayerState.PLAYING) hasPlayed = true;
          if (!hasPlayed) return;
          if (e.data === YT.PlayerState.ENDED) socket.emit("player:ended", { id: loadedId });
          // Keep server in sync if someone pauses/plays on the device itself.
          if (e.data === YT.PlayerState.PAUSED && state && !state.paused) socket.emit("player:paused", { paused: true });
          if (e.data === YT.PlayerState.PLAYING && state && state.paused) {
            if (state.current?.id === loadedId) socket.emit("player:paused", { paused: false });
          }
        },
        onError: (e) => {
          // Video can't be embedded / was removed: skip it.
          if ((e.data === 101 || e.data === 150) && isIpOrigin) {
            const port = location.port ? `:${location.port}` : "";
            $("hint").classList.remove("hidden");
            $("hint").textContent = tvHost
              ? `Some videos only play when this page is opened by name: http://${tvHost}${port}/tv?key=…`
              : "Some videos only play when this page is opened by computer name instead of an IP address.";
          }
          if (loadedId !== null) socket.emit("player:error", { id: loadedId, code: e.data });
        },
      },
    });
  };

  $("start").addEventListener("click", enableSound);
  // Any click on the TV page counts as the user gesture browsers need for sound.
  document.addEventListener("click", () => {
    if (soundBlocked) enableSound();
  });

  loadInfo().then(() => socket.connect());
})();
