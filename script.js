/*
the first section here concerns the multi-stop image zoom (per-panel pan) logic:
- Plays a sequence of (fx, fy, zoom) stops once per hover
- Then eases back to the natural image and waits for re-hover
- Controlled via data attribute: data-zoom-seq="x% y% z; ..."
*/

//timing vars for the sequence animation
const DWELL_MS = 1200; //how long we linger at each stop
const START_DELAY = 80; //tiny delay before starting so hover feels natural
const OUTRO_MS = 300; //extra linger at final stop before zooming back out



//find every panel image that declares a zoom pan sequence via data-zoom-seq
document.querySelectorAll("img.panel[data-zoom-seq]").forEach((img) => {
  //per-image state
  let timers = []; //scheduled setTimeout handles for this run
  let running = false; //true while the sequence is currently playing
  let armed = true; //bool to allow only one play per hover
  let steps = parseSteps(img.getAttribute("data-zoom-seq")); // [{fx,fy,z}, ...]

  //converts the data string from an image's 'data-zoom-seq' attribute (e.g. "10% 40% 3; 50% 50% 3; 80% 30% 3")
  //into an array of structured step objects like: [{ fx: "10%", fy: "40%", z: 3 }, { fx: "50%", fy: "50%", z: 3 }, ...]
  // note that fx, fy is where the zoom should focus (CSS transform-origin) and z how much to zoom in (scale factor)
  function parseSteps(s) {
    return s
      .split(";") //split the whole string by semicolons
      .map((part) => {
        //trim spaces and split by any whitespace between values
        const bits = part.trim().split(/\s+/);
        //build a clean object describing that zoom stop
        return { fx: bits[0], fy: bits[1], z: parseFloat(bits[2]) };
      });
  }

  //cancel any pending timeouts (used on mouseleave to abort the zoom pan mid-sequence)
  function clearTimers() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  //applying a single step's focal point + zoom using CSS transforms
  function applyOriginAndScale({ fx, fy, z }) {
    img.style.transformOrigin = `${fx} ${fy}`; //aim the zoom
    img.style.transform = `scale(${z})`; //zoom factor
  }

  //returning an image to its natural state (no zoom, default origin)
  function resetToNatural() {
    img.style.transformOrigin = "";
    img.style.transform = "scale(1)";
  }

  //plays a full multi-stop zoom animation sequence once when the user hovers over the image
  function playOnce() {
    // Only proceed if:
    //- The image is currently "armed" (ie it's ready to react to hover),
    //- It's not already running another zoom sequence,
    //- There is at least one valid zoom step to play
    if (!armed || running || steps.length === 0) return;

    //the animation is now running
    running = true;

    //cancel any previous timers that might still be active
    clearTimers();

    //visually reset the image to its default state (no zoom, centered) before starting the new animation sequence
    resetToNatural();

    //scheduling each step in order using setTimeouts
    // as mentioned before START_DELAY gives a small pause before the first zoom, for a smoother start
    let t = START_DELAY;

    //for each zoom stop
    steps.forEach((st) => {
      //wait t milliseconds,
      //then apply that focal point and scale (using CSS transform)
      timers.push(setTimeout(() => applyOriginAndScale(st), t));

      //after each step, increase the timer offset by DWELL_MS
      //so the next step starts after the previous one has "lingered" for a bit
      t += DWELL_MS;
    });

    //after the last step: linger briefly, then zoom all the way back out
    timers.push(
      setTimeout(() => {
        resetToNatural();
        running = false;
        armed = false; //require mouseleave before another play
      }, t + OUTRO_MS)
    );
  }

  //on mouseleave, cancel and reset; re-arm
  function stopAndReset() {
    clearTimers();
    running = false;
    armed = true; //enable it to play again next time
    resetToNatural();
  }

  //desktop hover interactions
  img.addEventListener("mouseenter", playOnce);
  img.addEventListener("mouseleave", stopAndReset);

});

/*
the second section concerns the door "mini-game" overlay
- When Panel 6 scrolls into view, doors auto-slide closed
- User clicks rapidly to push doors open; if they slow down, doors drift closed
- Once fully open, doors fade out and the underlying content pops in
- Scrolling away re-arms the section so it can be replayed
*/

const section = document.getElementById("panel6"); //the whole panel 6 section
const scene = document.getElementById("doorScene"); //full-section overlay
const doorL = document.getElementById("doorL"); //left door element
const doorR = document.getElementById("doorR"); //right door element
const hint = document.getElementById("doorHint"); //"Click fast" hint

let clicks = []; //timestamps (ms) of recent clicks within last 1000ms
let open = 0; //door openness percentage [0..100]
let door_armed = false; //true only while panel 6 is active/visible
let rafId = null; //requestAnimationFrame handle for the main loop

//difficulty tuning
const OPEN_PER_CPS_PER_FRAME = 0.2; //more = easier to open
const NATURAL_CLOSE_PER_FRAME = 0.6; //more = faster to close
const FULLY_OPEN = 100; //threshold at which we consider the doors "open"

//applying a symmetric translate to each door so they part from the center
function setDoors(pct) {
  doorL.style.transform = `translateX(${-pct}%)`;
  doorR.style.transform = `translateX(${pct}%)`;
}

//called when panel 6 becomes active (when we scroll to it): show the doors slide closed
// 1) Start with doors fully open (offscreen)
// 2) Next frame: animate to closed (center) using CSS transition
// 3) After that, switch to snappier transition for CPS-driven motion
function resetToClosedWithSlide() {
  // reveal the doors and hint
  doorL.classList.remove("is-gone");
  doorR.classList.remove("is-gone");
  hint.style.opacity = "1";
  doorL.classList.remove("anim"); // use slower ease during slide-in
  doorR.classList.remove("anim");

  setDoors(100); //start fully open (offscreen)
  requestAnimationFrame(() => {
    //next frame, slide to closed (0%)
    setDoors(0);
  });

  //after the slide has visibly reached center, enable quick response mode
  setTimeout(() => {
    doorL.classList.add("anim");
    doorR.classList.add("anim");
  }, 500);
}

//resets counters and door position
function zeroState() {
  clicks.length = 0;
  open = 0;
  setDoors(open);
}

//main animation loop: runs only while "door_armed" (panel 6 visible)
// - Computes clicks-per-second (CPS) over the last 1000ms
// - Increases "open" by CPS * gain; decreases by natural close amount
// - Updates door transforms; detects FULLY_OPEN and reveals content
function startLoop() {
  if (rafId) return; //to avoid multiple loops

  rafId = requestAnimationFrame(function tick() {
    //pf panel was disarmed mid-loop (user scrolled away), stop cleanly
    if (!door_armed) {
      rafId = null;
      return;
    }

    //measuring clicks per second, we keep only the clicks from the last 1000ms in the 'clicks' array
    const now = performance.now(); //learned about the performance property: https://developer.mozilla.org/en-US/docs/Web/API/Window/performance
    while (clicks.length && now - clicks[0] > 1000) clicks.shift(); //shift is similar to pop
    const cps = clicks.length;

    //update door openness with gains/losses and clamp to [0..100]
    open += cps * OPEN_PER_CPS_PER_FRAME - NATURAL_CLOSE_PER_FRAME;
    open = Math.max(0, Math.min(FULLY_OPEN, open));
    setDoors(open); //apply the new door position

    //if doors are fully open: fade doors, disable overlay, and reveal content underneath
    if (open >= FULLY_OPEN) {
      // Hide doors and hint
      doorL.classList.add("is-gone");
      doorR.classList.add("is-gone");
      hint.style.opacity = "0";
      scene.style.pointerEvents = "none"; //let user interact with revealed content

      //reveal underlying panel with a pop-in zoom (CSS handles the animation)
      section.classList.add("revealed");
      const content = section.querySelector(".panel6-content");
      if (content) {
        content.classList.remove("is-hidden");
      }

      door_armed = false; //stop the loop
      rafId = null;
      return;
    }

    //continue the loop next frame
    rafId = requestAnimationFrame(tick);
  });
}

//upon entering panel 6: re-arm the mechanic and play the door-closing animation
function arm() {
  door_armed = true; //enable click counting
  scene.style.pointerEvents = "auto"; //overlay should intercept clicks while closed
  zeroState(); //reset counters and door position
  resetToClosedWithSlide(); //play the auto slide-shut animation

  //allow Space key to trigger clicks when overlay has focus
  scene.tabIndex = 0;
  try {
    scene.focus({ preventScroll: true });
  } catch (_) { }

  //start the main loop to track clicks and move doors
  startLoop();
}

// Leaving panel 6: stop loop, reset state, and prepare for replay next time
function disarm() {
  door_armed = false; //stop counting clicks
  // Stop the main loop if running
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;

  //restore overlay visuals and hint for next visit
  scene.style.pointerEvents = "auto";
  doorL.classList.remove("is-gone");
  doorR.classList.remove("is-gone");
  hint.style.opacity = "1";
  zeroState();

  //set doors fully open so that when we re-enter, they visibly slide shut
  setDoors(100);

  //hide the underlying content again so the reveal can replay
  section.classList.remove("revealed");
  const content = section.querySelector(".panel6-content");
  if (content) {
    content.classList.add("is-hidden");
  }
}

//count clicks only on the door overlay (so other panels don't affect CPS)
function registerClick() {
  if (door_armed) clicks.push(performance.now());
}
scene.addEventListener("pointerdown", registerClick, { passive: true });

//spacebar also counts as a "click" while overlay is focused
scene.addEventListener("keydown", (e) => {
  if (e.code === "Space") registerClick();
});

//IntersectionObserver is used to arm/disarm based on visibility:
// - arm when >=60% of the panel 6 section is visible (user has reached the section)
// - disarm when <20% visible (user has clearly left)
const io = new IntersectionObserver( //referred to https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
  (entries) => {
    //this callback runs every time one of the observed elements crosses one of the visibility thresholds defined below
    entries.forEach((entry) => {
      //we only care about our specific section (#panel6)
      if (entry.target !== section) return;

      //when the section becomes mostly visible ( > 60% on screen ), we "arm" the door logic so it slides closed and becomes clickable
      if (entry.isIntersecting && entry.intersectionRatio > 0.6) {
        arm();
        //when the section becomes mostly invisible ( < 20% on screen ), we "disarm" the door logic so it resets and can replay next time
      } else if (entry.intersectionRatio < 0.2) {
        disarm();
      }
    });
  },
  { threshold: [0, 0.2, 0.6, 1] } //visibility thresholds at which to trigger the callback
);

//initial prep:
// - set doors "open" (offscreen) so on first arrival they slide shut
// - Begin observing the section for enter/leave transitions
setDoors(100);
io.observe(section);







// lock scrolling
function initScrollLock() {
  document.body.classList.add('scroll-locked');
  document.querySelector('.snap').classList.add('scroll-locked');

  // get the start button and second panel
  const startButton = document.getElementById('startButton');
  const secondPanel = document.querySelectorAll('section')[1]; // Get the second section

  if (startButton && secondPanel) {
    startButton.addEventListener('click', function () {
      // remove scroll lock
      document.body.classList.remove('scroll-locked');
      document.querySelector('.snap').classList.remove('scroll-locked');

      // move to second panel
      secondPanel.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });

      console.log('Scroll unlocked! Moving to panel 2...');
    });
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function () {
  initScrollLock();
});

