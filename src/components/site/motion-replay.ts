import { splitWords } from "@/lib/cms/words";
import type { ReplayMode } from "@/lib/visual-editor/protocol";

/**
 * Replay, on the canvas (Batch 15b): one node's motion, played once, then the
 * node put back exactly as it was.
 *
 * Imported by the editor bridge and by nothing else, so a visitor's page never
 * downloads it. It plays the page's *own* motion — the same stylesheet rules,
 * variables and keyframes a visitor gets — by nudging the state those rules
 * key on, never by drawing a second animation that merely looks similar:
 *
 *   · **Entrance** — the element's lifecycle is sent back to waiting and forward
 *     to shown (`data-shown`), which is what starts the entrance in the first
 *     place; a row of a staggering list has its own animation restarted, so the
 *     row replays rather than the whole list. A legacy `.reveal` replays its
 *     legacy transition the same way.
 *   · **Words** — the canvas renders text whole so that it can be typed into.
 *     For the length of a Replay its text nodes are swapped for the same word
 *     spans the public page renders (the same `splitWords`), the element is
 *     marked `data-m-words`, and afterwards the *original* text nodes are put
 *     back — the very same node objects, so nothing that was holding them
 *     notices.
 *   · **Parallax** — live parallax is paused in the editor, so this plays a
 *     bounded sweep instead: `--m-py` animated from rest to each extreme of
 *     the element's own drift distance and back to rest, then released. No
 *     scroll listener, no registration, nothing left running.
 *   · **Hover** — no pointer is faked: an attribute the stylesheet treats as
 *     hover (`data-eod-replay-hover`) is set for a moment, so the very same
 *     hover variables move through the very same transition.
 *
 * Everything is ephemeral: nothing is sent anywhere but the result, and
 * `cancel()` — which the bridge calls on a newer Replay, a selection change, a
 * direct edit beginning or the canvas going away — restores whatever the
 * Replay had changed, at whatever point it had reached.
 */

type Phase = "entrance" | "parallax" | "hover";

/** The bounds of a Replay, so it can never outlive its purpose. */
export const REPLAY_LIMITS = {
  /** An entrance with the longest delay, stagger and duration is over well inside this. */
  entranceMs: 4800,
  /** One parallax sweep: rest → one extreme → the other → rest. */
  sweepMs: 1800,
  /** How long a hover is held before it is let go. */
  hoverHoldMs: 900,
  /** How long a released hover takes to settle back. */
  hoverSettleMs: 450,
} as const;

export type ReplayRun = {
  /** The longest this Replay can take, for the bridge's outline to follow it. */
  budgetMs: number;
  /** Stops it now and restores the node. Safe to call twice. */
  cancel: () => void;
};

const number = (style: CSSStyleDeclaration, name: string): number => {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : 0;
};

/** Forces a style flush, so a state switched off and on again is two states, not none. */
const flush = (element: Element) => void element.getBoundingClientRect();

const hasLifecycle = (element: Element): boolean =>
  element.hasAttribute("data-m-reveal") ||
  element.hasAttribute("data-m-group") ||
  element.hasAttribute("data-m-member") ||
  element.classList.contains("reveal");

/** The element's own text, as the direct text nodes that carry any. */
const textNodes = (element: Element): Text[] =>
  Array.from(element.childNodes).filter(
    (node): node is Text => node.nodeType === Node.TEXT_NODE && !!node.textContent?.trim(),
  );

/** Whether the element's words arrive in turn at the canvas's current width. */
const wordsHere = (element: Element, style: CSSStyleDeclaration): boolean =>
  element.hasAttribute("data-m-reveal") &&
  style.getPropertyValue("--m-wr").trim() === "1" &&
  textNodes(element).length > 0;

/** Whether the hover variables at this width move anything at all. */
const hoverMoves = (style: CSSStyleDeclaration): boolean =>
  number(style, "--m-hvx") !== 0 ||
  number(style, "--m-hvy") !== 0 ||
  (style.getPropertyValue("--m-hvs").trim() !== "" && number(style, "--m-hvs") !== 1) ||
  (style.getPropertyValue("--m-hvz").trim() !== "" && number(style, "--m-hvz") !== 1);

/** Which phases this node has, at this width, for this mode — in the order they play. */
export function replayPhases(element: HTMLElement, mode: ReplayMode): Phase[] {
  const style = window.getComputedStyle(element);
  const phases: Phase[] = [];
  if ((mode === "all" || mode === "entrance") && (hasLifecycle(element) || wordsHere(element, style))) {
    phases.push("entrance");
  }
  if ((mode === "all" || mode === "parallax") && element.hasAttribute("data-m-px") && number(style, "--m-pd") > 0) {
    phases.push("parallax");
  }
  if ((mode === "all" || mode === "hover") && element.hasAttribute("data-m-hv") && hoverMoves(style)) {
    phases.push("hover");
  }
  return phases;
}

/**
 * Starts a Replay of `element`, or returns null when it has nothing to play in
 * this mode at this width. `onFinished` runs once, only if it ran to the end.
 */
export function startReplay(
  element: HTMLElement,
  mode: ReplayMode,
  hooks: { onPhase: () => void; onFinished: () => void },
): ReplayRun | null {
  const phases = replayPhases(element, mode);
  if (!phases.length) return null;

  let cancelled = false;
  const timers = new Set<number>();
  const undo: (() => void)[] = [];
  let sweep: Animation | null = null;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        resolve();
      }, ms);
      timers.add(id);
    });

  /** Restores everything this Replay changed, newest first. */
  const restore = () => {
    for (const id of timers) window.clearTimeout(id);
    timers.clear();
    sweep?.cancel();
    sweep = null;
    while (undo.length) undo.pop()!();
  };

  /* ---- Entrance, with its words --------------------------------------- */
  const entrance = async () => {
    const style = window.getComputedStyle(element);
    const member = element.hasAttribute("data-m-member");
    const group = member ? element.parentElement : null;

    // The words, split exactly as the public page splits them.
    if (wordsHere(element, style)) {
      const swapped: [Text, HTMLSpanElement][] = [];
      for (const node of textNodes(element)) {
        const words = document.createElement("span");
        words.setAttribute("data-m-wv", "");
        for (const part of splitWords(node.data)) {
          if ("word" in part) {
            const word = document.createElement("span");
            word.setAttribute("data-m-w", "");
            word.textContent = part.word;
            words.append(word);
          } else {
            words.append(document.createTextNode(part.space));
          }
        }
        node.replaceWith(words);
        swapped.push([node, words]);
      }
      element.setAttribute("data-m-words", "");
      undo.push(() => {
        element.removeAttribute("data-m-words");
        // The original nodes go back, not copies of their text.
        for (const [node, words] of swapped) if (words.isConnected) words.replaceWith(node);
      });
    }

    if (member) {
      // The list owns a row's arrival, so the row's own animation is restarted
      // rather than the list's lifecycle — Replay is for the selected row.
      if (group && group.getAttribute("data-shown") !== "true") group.setAttribute("data-shown", "true");
      element.style.setProperty("animation-name", "none");
      flush(element);
      element.style.removeProperty("animation-name");
    } else {
      element.setAttribute("data-shown", "false");
      flush(element);
      element.setAttribute("data-shown", "true");
      // Shown is the element's normal state from here on, whatever it was
      // before: it has been seen.
      undo.push(() => element.setAttribute("data-shown", "true"));
    }

    // Wait for what this started — the element's own entrance, its rows', its
    // words' — and nothing else: an unrelated animation that never ends (the
    // hero's orbit, a marquee) must not hold a Replay open.
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    const targets: Element[] = [element];
    if (element.hasAttribute("data-m-group")) targets.push(...Array.from(element.children));
    targets.push(...Array.from(element.querySelectorAll("[data-m-w]")));
    const running = targets
      .flatMap((target) => target.getAnimations())
      .filter((animation) => {
        const end = animation.effect?.getComputedTiming().endTime;
        return typeof end === "number" && Number.isFinite(end);
      });
    await Promise.race([
      Promise.allSettled(running.map((animation) => animation.finished)),
      wait(REPLAY_LIMITS.entranceMs),
    ]);
  };

  /* ---- Parallax -------------------------------------------------------- */
  const parallax = async () => {
    const distance = number(window.getComputedStyle(element), "--m-pd");
    sweep = element.animate(
      [
        { "--m-py": "0px" },
        { "--m-py": `${-distance}px`, offset: 0.3 },
        { "--m-py": `${distance}px`, offset: 0.75 },
        { "--m-py": "0px" },
      ],
      { duration: REPLAY_LIMITS.sweepMs, easing: "ease-in-out" },
    );
    await Promise.race([sweep.finished.catch(() => undefined), wait(REPLAY_LIMITS.sweepMs + 200)]);
    sweep?.cancel();
    sweep = null;
  };

  /* ---- Hover ----------------------------------------------------------- */
  const hover = async () => {
    element.setAttribute("data-eod-replay-hover", "");
    const release = () => element.removeAttribute("data-eod-replay-hover");
    undo.push(release);
    await wait(REPLAY_LIMITS.hoverHoldMs);
    release();
    await wait(REPLAY_LIMITS.hoverSettleMs);
  };

  const play = { entrance, parallax, hover } as const;
  void (async () => {
    for (const phase of phases) {
      if (cancelled) return;
      hooks.onPhase();
      await play[phase]();
    }
    if (cancelled) return;
    restore();
    hooks.onFinished();
  })();

  const budgetMs =
    (phases.includes("entrance") ? REPLAY_LIMITS.entranceMs : 0) +
    (phases.includes("parallax") ? REPLAY_LIMITS.sweepMs + 200 : 0) +
    (phases.includes("hover") ? REPLAY_LIMITS.hoverHoldMs + REPLAY_LIMITS.hoverSettleMs : 0);

  return {
    budgetMs,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      restore();
    },
  };
}
