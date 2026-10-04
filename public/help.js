// Shared "How it works" modal for the join and remote pages.
const HELP_HTML = `
  <form method="dialog" class="help-head">
    <h2 id="help-title">How Dance Party! works</h2>
    <button class="help-close" aria-label="Close help">✕</button>
  </form>
  <div class="help-body">
    <section>
      <h3>🎟️ Join</h3>
      <p>Enter the <b>4-letter room code</b> shown on the TV and your name, then tap <b>PLAY</b>. You can also scan the QR code on the TV.</p>
    </section>
    <section>
      <h3>🎵 Add a song</h3>
      <p>In the YouTube app, tap <b>Share → Copy link</b> on a video, then paste it into <b>Add a song</b>. Any YouTube video link works: youtu.be, Shorts, YouTube Music, or a whole shared message.</p>
      <p>Playlists and channel pages can't be added. If search is turned on, you can type a song name instead.</p>
    </section>
    <section>
      <h3>📋 The queue</h3>
      <p><b>Now playing</b> shows the current song; <b>Up next</b> is the queue. It updates live for everyone. Songs play in order, and the first song added to an empty queue starts right away.</p>
      <p>Guests can have a few songs waiting at once (your count, like <b>1/3 queued</b>, is shown next to <b>Add a song</b>). Once one of your songs starts playing, you can add another.</p>
      <p>Open <a href="/queue"><b>/queue</b></a> for a read-only board with <b>Recently played</b>, <b>Now playing</b> and <b>Up next</b>. It needs no code, so it works well on a second screen. <a href="/history"><b>/history</b></a> lists every song ever played. Once you've joined, tap <b>+</b> there to queue a song again.</p>
    </section>
    <section>
      <h3>⭐ Admins</h3>
      <p>Admins join with the admin PIN (tap <b>I'm a host</b>, or open <b>/admin</b> to skip the room code). Their name shows a ★.</p>
      <ul>
        <li><b>⤒ Play next</b>: move a song to the top of the queue</li>
        <li><b>✕ Remove</b>: take a song out of the queue</li>
        <li><b>⏯ Play/pause</b> and <b>⏭ Skip</b> the current song</li>
      </ul>
    </section>
    <section>
      <h3>📺 Something wrong?</h3>
      <ul>
        <li><b>A song was skipped:</b> some videos can't be played outside YouTube. The pop-up says why. Try a different upload of the same song.</li>
        <li><b>The TV shows a "Click for sound" button:</b> click it once on the computer running the TV page.</li>
        <li><b>Sent back to the join screen:</b> the room code changed. Join again with the new code from the TV.</li>
      </ul>
    </section>
  </div>
`;

const dialog = document.createElement("dialog");
dialog.className = "help-dialog";
dialog.setAttribute("aria-labelledby", "help-title");
dialog.innerHTML = HELP_HTML;
document.body.append(dialog);

// Close when tapping the dimmed backdrop (outside the dialog box).
dialog.addEventListener("click", (e) => {
  const r = dialog.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) dialog.close();
});

const btn = document.createElement("button");
btn.type = "button";
btn.className = "help-btn";
btn.textContent = "?";
btn.setAttribute("aria-label", "Help");
btn.setAttribute("aria-haspopup", "dialog");
btn.addEventListener("click", () => dialog.showModal());
document.querySelector(".topbar")?.append(btn);

if (location.hash === "#help") dialog.showModal();
