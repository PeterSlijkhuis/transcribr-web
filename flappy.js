// flappy.js -- a tiny, dependency-free flappy-bird clone for the "waiting
// on a transcription" panel. mountFlappyGame() draws into the given canvas
// and returns a stop() function; nothing here touches the transcription
// code, and nothing here ever runs unless a user opens the panel.
export function mountFlappyGame(canvas) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  // Tuned to be forgiving: gentle gravity, capped fall speed, a wide gap,
  // and a hitbox smaller than the drawn bird.
  const GRAVITY = 0.3;
  const FLAP = -5.6;
  const MAX_FALL = 7;
  const PIPE_GAP = 135;
  const PIPE_W = 46;
  const PIPE_SPEED = 2;
  const PIPE_EVERY = 100;
  const HITBOX = 0.65;
  // Physics runs in fixed 60 Hz steps, so a 120 or 144 Hz screen plays at
  // the same speed instead of twice as fast.
  const STEP_MS = 1000 / 60;
  // After a crash, ignore input briefly so a frantic tap doesn't restart.
  const RETRY_DELAY_MS = 500;

  let bird, pipes, frame, score, state, overAt, running, raf, last, acc, newBest;
  let best = 0;
  try { best = Number(localStorage.getItem("flappyBest")) || 0; } catch (e) {}

  function reset() {
    bird = { x: W * 0.3, y: H / 2, vy: 0, r: 11 };
    pipes = [];
    frame = 0;
    score = 0;
    state = "ready"; // ready -> playing -> over
    newBest = false;
  }

  function addPipe() {
    const gapY = 40 + Math.random() * (H - 80 - PIPE_GAP);
    pipes.push({ x: W, gapY, passed: false });
  }

  function flap() {
    if (state === "over") {
      if (performance.now() - overAt > RETRY_DELAY_MS) reset();
      return;
    }
    state = "playing";
    bird.vy = FLAP;
  }

  function collides() {
    if (bird.y + bird.r > H) return true;
    const r = bird.r * HITBOX;
    return pipes.some(
      (p) => bird.x + r > p.x && bird.x - r < p.x + PIPE_W && (bird.y - r < p.gapY || bird.y + r > p.gapY + PIPE_GAP)
    );
  }

  function gameOver() {
    state = "over";
    overAt = performance.now();
    if (score > best) {
      best = score;
      newBest = true;
      try { localStorage.setItem("flappyBest", String(best)); } catch (e) {}
    }
  }

  function step() {
    frame++;
    if (state === "ready") {
      bird.y = H / 2 + Math.sin(frame / 10) * 6; // hover until the first flap
      return;
    }
    if (state === "over") return;
    bird.vy = Math.min(MAX_FALL, bird.vy + GRAVITY);
    bird.y = Math.max(bird.r, bird.y + bird.vy); // the ceiling stops you, it doesn't kill
    if (frame % PIPE_EVERY === 0) addPipe();
    for (const p of pipes) {
      p.x -= PIPE_SPEED;
      if (!p.passed && p.x + PIPE_W < bird.x) {
        p.passed = true;
        score++;
      }
    }
    pipes = pipes.filter((p) => p.x > -PIPE_W);
    if (collides()) gameOver();
  }

  function banner(lines, y = H / 2) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, y - 14 - lines.length * 11, W, 18 + lines.length * 22);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    lines.forEach((t, i) => ctx.fillText(t, W / 2, y - lines.length * 11 + 8 + i * 22));
    ctx.textAlign = "left";
  }

  function draw() {
    ctx.fillStyle = "#8fd0f0";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#2f8f3f";
    for (const p of pipes) {
      ctx.fillRect(p.x, 0, PIPE_W, p.gapY);
      ctx.fillRect(p.x, p.gapY + PIPE_GAP, PIPE_W, H - p.gapY - PIPE_GAP);
    }
    // Tilt the bird with its speed so a flap reads at a glance.
    ctx.save();
    ctx.translate(bird.x, bird.y);
    ctx.rotate(Math.max(-0.5, Math.min(0.9, bird.vy / 10)));
    ctx.fillStyle = "#e0b020";
    ctx.beginPath();
    ctx.arc(0, 0, bird.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#123";
    ctx.beginPath();
    ctx.arc(4, -3, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f07020";
    ctx.fillRect(bird.r - 2, -2, 7, 4);
    ctx.restore();
    ctx.fillStyle = "#123";
    ctx.font = "bold 16px system-ui, sans-serif";
    ctx.fillText(`Score: ${score}`, 8, 22);
    ctx.textAlign = "right";
    ctx.fillText(`Best: ${best}`, W - 8, 22);
    ctx.textAlign = "left";
    if (state === "ready") banner(["Tap, click or press space to flap"], H * 0.75);
    if (state === "over") banner([newBest ? `New best: ${score}!` : `Game over: ${score}`, "Tap or press space to retry"]);
  }

  function loop(now) {
    if (!running) return;
    acc += Math.min(250, now - last); // don't fast-forward after a hidden tab
    last = now;
    while (acc >= STEP_MS) {
      step();
      acc -= STEP_MS;
    }
    draw();
    raf = requestAnimationFrame(loop);
  }

  // pointerdown fires on touch and press, not release: no tap delay.
  const onPointer = (e) => {
    e.preventDefault();
    flap();
  };
  // Space also scrolls the page and types into text inputs; only treat it
  // as a flap when the game itself, not a form field, would receive it.
  const onKey = (e) => {
    if (e.code !== "Space" && e.code !== "ArrowUp") return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    if (!e.repeat) flap();
  };

  reset();
  draw();
  running = true;
  last = performance.now();
  acc = 0;
  raf = requestAnimationFrame(loop);
  canvas.style.touchAction = "none";
  canvas.addEventListener("pointerdown", onPointer);
  window.addEventListener("keydown", onKey);

  return function stop() {
    running = false;
    cancelAnimationFrame(raf);
    canvas.removeEventListener("pointerdown", onPointer);
    window.removeEventListener("keydown", onKey);
  };
}
