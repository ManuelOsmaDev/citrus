// Plugin de Tangerine: lo que el lenguaje no trae (IPC con promesas, Monaco, SVG, atajos).
(function () {
  const Tng = globalThis.Tangerine;
  const SVG = "http://www.w3.org/2000/svg";

  // Trazos de 24x24, con el mismo grosor en toda la app.
  const ICONS = {
    send: "M5 12h14M13 6l6 6-6 6",
    plus: "M12 5v14M5 12h14",
    close: "M6 6l12 12M18 6L6 18",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
    folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    folderPlus: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v5M9.5 13.5h5",
    chevron: "M9 6l6 6-6 6",
    down: "M6 9l6 6 6-6",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    moon: "M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z",
    download: "M12 4v11M7 11l5 5 5-5M5 20h14",
    upload: "M12 20V9M7 13l5-5 5 5M5 4h14",
    lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
    key: "M15 4a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 12l-7 7v2h3l1-2h2v-2h2l1-1",
    settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
    history: "M4 12a8 8 0 1 0 2.5-5.8L4 8.5M4 4v4.5h4.5M12 8v4.5l3 2",
    layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
    bolt: "M13 3L5 14h6l-1 7 8-11h-6z",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    alert: "M12 4l9 16H3zM12 10v4M12 17v.5",
    stop: "M7 7h10v10H7z",
    swap: "M4 8h13M13 4l4 4-4 4M20 16H7M11 12l-4 4 4 4",
    file: "M7 3h7l5 5v13H7zM14 3v5h5",
    play: "M8 5l11 7-11 7z",
    code: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
    columns: "M4 5h16v14H4zM12 5v14",
    rows: "M4 5h16v14H4zM4 12h16",
  };

  const MONO_FONT = '"Geist Mono", "Cascadia Code", Consolas, ui-monospace, monospace';
  function sliceSvg(size) {
    const holder = document.createElement("span");
    holder.innerHTML = `<svg aria-hidden="true" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14.7" fill="none" stroke="currentColor" stroke-width="2"/><g fill="currentColor" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M16 15.3 L13.3 5.6 A10.6 10.6 0 0 1 18.7 5.6 Z" transform="rotate(0 16 16)"/><path d="M16 15.3 L13.3 5.6 A10.6 10.6 0 0 1 18.7 5.6 Z" transform="rotate(45 16 16)"/><path d="M16 15.3 L13.3 5.6 A10.6 10.6 0 0 1 18.7 5.6 Z" transform="rotate(90 16 16)"/><path d="M16 15.3 L13.3 5.6 A10.6 10.6 0 0 1 18.7 5.6 Z" transform="rotate(135 16 16)"/><path d="M16 15.3 L13.3 5.6 A10.6 10.6 0 0 1 18.7 5.6 Z" transform="rotate(180 16 16)"/><path d="M16 15.3 L13.3 5.6 A10.6 10.6 0 0 1 18.7 5.6 Z" transform="rotate(225 16 16)"/><path d="M16 15.3 L13.3 5.6 A10.6 10.6 0 0 1 18.7 5.6 Z" transform="rotate(270 16 16)"/><path d="M16 15.3 L13.3 5.6 A10.6 10.6 0 0 1 18.7 5.6 Z" transform="rotate(315 16 16)"/></g></svg>`;
    const svg = holder.firstChild;
    if (size) {
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
    }
    return svg;
  }

  const reducedTheme = () => document.documentElement.dataset.theme || "dark";

  // ---------- Monaco ----------
  let monacoApi = null;
  const waiting = [];

  function defineThemes(m) {
    m.editor.defineTheme("citrus-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "string.key.json", foreground: "F5B971" },
        { token: "string.value.json", foreground: "B7DD7C" },
        { token: "number", foreground: "8CC5FF" },
        { token: "keyword.json", foreground: "D6A9F5" },
      ],
      colors: {
        "editor.background": "#181715",
        "editorGutter.background": "#181715",
        "editorLineNumber.foreground": "#4f4b45",
        "editorLineNumber.activeForeground": "#8f8a81",
        "editor.selectionBackground": "#f0973a38",
        "editorCursor.foreground": "#f0973a",
        "editorIndentGuide.background1": "#2b2926",
        "scrollbarSlider.background": "#ffffff14",
        "scrollbarSlider.hoverBackground": "#ffffff24",
      },
    });
    m.editor.defineTheme("citrus-light", {
      base: "vs",
      inherit: true,
      rules: [
        { token: "string.key.json", foreground: "A9560B" },
        { token: "string.value.json", foreground: "4D7A12" },
        { token: "number", foreground: "1F66B8" },
        { token: "keyword.json", foreground: "8A3FBF" },
      ],
      colors: {
        "editor.background": "#fbfaf7",
        "editorGutter.background": "#fbfaf7",
        "editorLineNumber.foreground": "#b5b3ad",
        "editorLineNumber.activeForeground": "#6c6a65",
        "editor.selectionBackground": "#f28c2833",
        "editorCursor.foreground": "#d9770a",
      },
    });
  }

  function whenMonaco(callback) {
    if (monacoApi) callback(monacoApi);
    else waiting.push(callback);
  }

  function loadMonaco() {
    if (typeof window.require !== "function") return;
    // Sin esto Monaco crea el worker desde un blob:, que el CSP de la app no permite.
    window.MonacoEnvironment = { getWorker: () => new Worker("monaco/vs/base/worker/workerMain.js") };
    window.require.config({ paths: { vs: "monaco/vs" } });
    window.require(["vs/editor/editor.main"], () => {
      monacoApi = window.monaco;
      defineThemes(monacoApi);
      // Un body con {{var}} sin comillas no es JSON válido y no debe verse como error.
      monacoApi.languages.json.jsonDefaults.setDiagnosticsOptions({ validate: false });
      monacoApi.editor.setTheme(`citrus-${reducedTheme()}`);
      // Monaco mide los caracteres al crear el editor: hay que avisarle cuando llega la fuente.
      document.fonts.ready.then(() => monacoApi.editor.remeasureFonts());
      waiting.splice(0).forEach((f) => f(monacoApi));
    });
  }

  Tng.registerPlugin({
    name: "citrus",
    install(tng) {
      const invoke = (f, args) => tng.invoke(f, args);

      tng.defineAll({
        ipc_call(method, args, ok, fail) {
          window.citrusBridge.call(method, Tng.toJS(args ?? null)).then(
            (res) => {
              if (res.ok) {
                if (ok) invoke(ok, [Tng.fromJS(res.value)]);
              } else if (fail) invoke(fail, [Tng.fromJS(res.error)]);
            },
            (err) => {
              if (fail) invoke(fail, [Tng.fromJS({ code: "IPC", message: String(err?.message ?? err) })]);
            },
          );
          return null;
        },
        on_window_focus(f) {
          window.citrusBridge.onFocus(() => invoke(f));
          return null;
        },

        icon(name, size) {
          const svg = document.createElementNS(SVG, "svg");
          const px = String(size ?? 16);
          svg.setAttribute("viewBox", "0 0 24 24");
          svg.setAttribute("width", px);
          svg.setAttribute("height", px);
          svg.setAttribute("fill", "none");
          svg.setAttribute("stroke", "currentColor");
          svg.setAttribute("stroke-width", "1.8");
          svg.setAttribute("stroke-linecap", "round");
          svg.setAttribute("stroke-linejoin", "round");
          svg.setAttribute("aria-hidden", "true");
          const path = document.createElementNS(SVG, "path");
          path.setAttribute("d", ICONS[name] ?? "");
          svg.appendChild(path);
          return svg;
        },

        // La rodaja de Citrus, en el color del texto que la rodea.
        logo(size) {
          return sliceSvg(size ?? 22);
        },
        // El nombre con la rodaja como punto de la i.
        wordmark() {
          const word = document.createElement("span");
          word.className = "wordmark";
          word.setAttribute("aria-label", "Citrus");
          const i = document.createElement("span");
          i.className = "wm-i";
          i.textContent = "ı";
          const dot = sliceSvg(null);
          dot.classList.add("wm-dot");
          i.appendChild(dot);
          word.append("c", i, "trus");
          return word;
        },

        on_stop(e, event, f) {
          e.addEventListener(event, (ev) => {
            ev.stopPropagation();
            invoke(f);
          });
          return e;
        },
        // En captura, para ganarle a Monaco en Ctrl+Enter y Ctrl+S.
        on_keys(f) {
          window.addEventListener(
            "keydown",
            (ev) => {
              const info = Object.create(null);
              info.key = ev.key;
              info.ctrl = ev.ctrlKey || ev.metaKey;
              info.shift = ev.shiftKey;
              if (tng.call(f, [info]) === true) {
                ev.preventDefault();
                ev.stopPropagation();
              }
            },
            true,
          );
          return null;
        },
        checked: (e) => e.checked === true,
        set_checked(e, on) {
          e.checked = tng.truthy(on);
          return e;
        },
        focus(e) {
          requestAnimationFrame(() => e?.focus());
          return e;
        },
        select_text(e) {
          requestAnimationFrame(() => {
            e?.focus();
            e?.select();
          });
          return e;
        },
        sync_scroll(input, mirror) {
          const sync = () => {
            mirror.scrollLeft = input.scrollLeft;
          };
          for (const name of ["scroll", "input", "keyup", "click", "select"]) input.addEventListener(name, sync);
          requestAnimationFrame(sync);
          return input;
        },

        url_enc: (s) =>
          String(s ?? "")
            .split(/(\{\{[^}]*\}\})/)
            .map((part) => (part.startsWith("{{") ? part : encodeURIComponent(part)))
            .join(""),
        url_dec(s) {
          try {
            return decodeURIComponent(String(s ?? ""));
          } catch {
            return String(s ?? "");
          }
        },
        // Trozos de un texto con {{var}}: [{ text, name }], name es nil fuera de una variable.
        var_tokens(text) {
          const out = [];
          let last = 0;
          const source = String(text ?? "");
          for (const m of source.matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)) {
            if (m.index > last) out.push(Tng.fromJS({ text: source.slice(last, m.index), name: null }));
            out.push(Tng.fromJS({ text: m[0], name: m[1] }));
            last = m.index + m[0].length;
          }
          if (last < source.length) out.push(Tng.fromJS({ text: source.slice(last), name: null }));
          return out;
        },

        time_ago(iso) {
          const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
          if (seconds < 60) return "ahora";
          if (seconds < 3600) return `hace ${Math.floor(seconds / 60)} min`;
          if (seconds < 86400) return `hace ${Math.floor(seconds / 3600)} h`;
          return new Date(iso).toLocaleDateString("es", { day: "numeric", month: "short" });
        },

        apply_theme(theme) {
          document.documentElement.dataset.theme = theme;
          whenMonaco((m) => m.editor.setTheme(`citrus-${theme}`));
          return null;
        },

        // Arrastra un divisor y guarda la posición en una variable CSS, en porcentaje.
        drag_split(handle, area, variable, axis, min, max) {
          handle.addEventListener("pointerdown", (start) => {
            start.preventDefault();
            handle.setPointerCapture(start.pointerId);
            document.body.classList.add("dragging");
            const move = (ev) => {
              const box = area.getBoundingClientRect();
              const pct = axis === "x" ? ((ev.clientX - box.left) / box.width) * 100 : ((ev.clientY - box.top) / box.height) * 100;
              area.style.setProperty(variable, `${Math.min(max, Math.max(min, pct)).toFixed(2)}%`);
            };
            const end = () => {
              handle.removeEventListener("pointermove", move);
              handle.removeEventListener("pointerup", end);
              document.body.classList.remove("dragging");
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", end);
          });
          return handle;
        },

        editor_create(container, options, onChange) {
          const opts = Tng.toJS(options ?? {});
          const handle = Object.create(null);
          handle.editor = null;
          handle.value = opts.value ?? "";
          handle.disposed = false;
          container.classList.add("editor-loading");
          whenMonaco((m) => {
            if (handle.disposed) return;
            container.classList.remove("editor-loading");
            const editor = m.editor.create(container, {
              value: handle.value,
              language: opts.language ?? "plaintext",
              readOnly: opts.readOnly === true,
              domReadOnly: opts.readOnly === true,
              theme: `citrus-${reducedTheme()}`,
              automaticLayout: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontFamily: MONO_FONT,
              fontSize: 12.5,
              lineHeight: 20,
              padding: { top: 10, bottom: 10 },
              lineNumbersMinChars: 3,
              glyphMargin: false,
              folding: true,
              renderLineHighlight: opts.readOnly === true ? "none" : "line",
              overviewRulerLanes: 0,
              overviewRulerBorder: false,
              hideCursorInOverviewRuler: true,
              wordWrap: opts.wrap === false ? "off" : "on",
              tabSize: 2,
              stickyScroll: { enabled: false },
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
              contextmenu: true,
              fixedOverflowWidgets: true,
            });
            handle.editor = editor;
            if (onChange) {
              editor.onDidChangeModelContent(() => {
                handle.value = editor.getValue();
                invoke(onChange, [handle.value]);
              });
            }
          });
          return handle;
        },
        diff_create(container, before, after, language) {
          const handle = Object.create(null);
          handle.disposed = false;
          whenMonaco((m) => {
            if (handle.disposed) return;
            const original = m.editor.createModel(String(before ?? ""), language ?? "plaintext");
            const modified = m.editor.createModel(String(after ?? ""), language ?? "plaintext");
            const editor = m.editor.createDiffEditor(container, {
              readOnly: true,
              renderSideBySide: false,
              automaticLayout: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontFamily: MONO_FONT,
              fontSize: 12.5,
              lineHeight: 20,
              renderOverviewRuler: false,
              stickyScroll: { enabled: false },
            });
            editor.setModel({ original, modified });
            handle.cleanup = () => {
              editor.dispose();
              original.dispose();
              modified.dispose();
            };
          });
          return handle;
        },
        fmt_time(ts) {
          const d = new Date(ts);
          const pad = (n, size = 2) => String(n).padStart(size, "0");
          return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
        },
        editor_set(handle, text) {
          handle.value = String(text ?? "");
          if (handle.editor && handle.editor.getValue() !== handle.value) handle.editor.setValue(handle.value);
          return null;
        },
        editor_get: (handle) => handle.value,
        editor_dispose(handle) {
          if (!handle) return null;
          handle.disposed = true;
          handle.cleanup?.();
          handle.editor?.getModel()?.dispose();
          handle.editor?.dispose();
          return null;
        },
      });
    },
  });

  window.addEventListener("DOMContentLoaded", loadMonaco);
})();
