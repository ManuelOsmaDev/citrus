// Lo que Tangerine no trae para animar: saber qué está en pantalla y respetar las preferencias.
(function () {
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  globalThis.Tangerine.registerPlugin({
    name: "motion",
    install(tng) {
      const invoke = (f, args) => tng.invoke(f, args);
      tng.defineAll({
        reduced_motion: () => reduced(),

        // Avisa al entrar y salir de pantalla, y también al cambiar de pestaña.
        on_view(el, enter, leave) {
          let onScreen = false;
          let active = false;
          const sync = () => {
            const next = onScreen && document.visibilityState === "visible";
            if (next === active) return;
            active = next;
            invoke(next ? enter : leave);
          };
          new IntersectionObserver(
            (entries) => {
              onScreen = entries.some((e) => e.isIntersecting);
              sync();
            },
            { threshold: 0.15 },
          ).observe(el);
          document.addEventListener("visibilitychange", sync);
          return null;
        },

        // Revela cada .reveal una sola vez, al entrar en pantalla.
        reveal_all() {
          const observer = new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                entry.target.classList.add("in");
                observer.unobserve(entry.target);
              }
            },
            { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
          );
          for (const el of document.querySelectorAll(".reveal")) observer.observe(el);
          return null;
        },

        // Entrada corta para un texto que acaba de cambiar.
        enter_anim(el) {
          if (reduced()) return el;
          el.animate(
            [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "translateY(0)" }],
            { duration: 240, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
          );
          return el;
        },
      });
    },
  });
})();
