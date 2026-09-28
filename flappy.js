// flappy.js -- a tiny, dependency-free flappy-bird clone for the "waiting
// on a transcription" panel. mountFlappyGame() draws into the given canvas
// and returns a stop() function; nothing here touches the transcription
// code, and nothing here ever runs unless a user opens the panel.
export function mountFlappyGame(canvas) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const GRAVITY = 0.35;
  const FLAP = -6;
  const PIPE_GAP = 110;
  const PIPE_W = 46;
  const PIPE_SPEED = 2.2;
  const PIPE_EVERY = 90;

  let bird, pipes, frame, score, over, running, raf;

  function reset() {
    bird = { x: W * 0.3, y: H / 2, vy: 0, r: 10 };
    pipes = [];
    frame = 0;
    score = 0;
    over = false;
  }

  function addPipe() {
    const gapY = 30 + Math.random() * (H - 60 - PIPE_GAP);
    pipes.push({ x: W, gapY, passed: false });
  }

  function flap() {
    if (over) {
      reset();
      return;
    }
    bird.vy = FLAP;
  }

  function collides() {
    if (bird.y - bird.r < 0 || bird.y + bird.r > H) return true;
    return pipes.some(
      (p) =>
        bird.x + bird.r > p.x &&
        bird.x - bird.r < p.x + PIPE_W &&
        (bird.y - bird.r < p.gapY || bird.y + bird.r > p.gapY + PIPE_GAP)
    );
  }

  function step() {
    frame++;
    bird.vy += GRAVITY;
    bird.y += bird.vy;
    if (frame % PIPE_EVERY === 0) addPipe();
    for (const p of pipes) {
      p.x -= PIPE_SPEED;
      if (!p.passed && p.x + PIPE_W < bird.x) {
        p.passed = true;
        score++;
      }
    }
    pipes = pipes.filter((p) => p.x > -PIPE_W);
    if (collides()) over = true;
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#8fd0f0";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#2f8f3f";
    for (const p of pipes) {
      ctx.fillRect(p.x, 0, PIPE_W, p.gapY);
      ctx.fillRect(p.x, p.gapY + PIPE_GAP, PIPE_W, H - p.gapY - PIPE_GAP);
    }
    ctx.fillStyle = "#e0b020";
    ctx.beginPath();
    ctx.arc(bird.x, bird.y, bird.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#123";
    ctx.font = "16px system-ui, sans-serif";
    ctx.fillText(`Score: ${score}`, 8, 20);
    if (over) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, H / 2 - 30, W, 60);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText("Game over — click or space to retry", W / 2, H / 2 + 5);
      ctx.textAlign = "left";
    }
  }

  function loop() {
    if (!running) return;
    step();
    draw();
    raf = requestAnimationFrame(loop);
  }

  const onClick = () => flap();
  // Space also scrolls the page and types into text inputs; only treat it
  // as a flap when the game itself, not a form field, would receive it.
  const onKey = (e) => {
    if (e.code !== "Space") return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    flap();
  };

  reset();
  draw();
  running = true;
  raf = requestAnimationFrame(loop);
  canvas.addEventListener("click", onClick);
  window.addEventListener("keydown", onKey);

  return function stop() {
    running = false;
    cancelAnimationFrame(raf);
    canvas.removeEventListener("click", onClick);
    window.removeEventListener("keydown", onKey);
  };
}
