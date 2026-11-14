// Lo que Tangerine no trae para la encuesta: idioma, nombres de países, el diálogo y el envío al Google Form.
(function () {
  const FORM = "https://docs.google.com/forms/d/e/1FAIpQLSc699XK079jxG2nBA_fT56NXke0D6R0lyFCfInWv4aWpdbo5w/formResponse";
  const FIELDS = { country: "entry.481215757", area: "entry.2072212038", use: "entry.726089331" };

  // ISO 3166-1 alfa-2. Los nombres salen de Intl en el idioma de la página.
  const CODES = (
    "AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ " +
    "DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HK HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KW KG " +
    "LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG KP MK NO OM PK PW PS PA PG PY " +
    "PE PH PL PT PR QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA KR SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN TR TM " +
    "TV UG UA AE GB US UY UZ VU VA VE VN YE ZM ZW"
  ).split(" ");

  const lang = () => ((navigator.language || "es").toLowerCase().startsWith("es") ? "es" : "en");
  const names = (l) => {
    try { return new Intl.DisplayNames([l], { type: "region" }); } catch { return { of: (c) => c }; }
  };
  const region = () => {
    for (const tag of navigator.languages || [navigator.language || ""]) {
      const m = /-([A-Za-z]{2})$/.exec(tag);
      if (m) return m[1].toUpperCase();
    }
    return null;
  };

  globalThis.Tangerine.registerPlugin({
    name: "survey",
    install(tng) {
      tng.defineAll({
        ui_lang: () => lang(),

        // Lista de [nombre en el idioma de la página, nombre en español], ordenada.
        countries() {
          const shown = names(lang());
          const es = names("es");
          const list = CODES.map((c) => [shown.of(c), es.of(c)]);
          list.sort((a, b) => a[0].localeCompare(b[0], lang()));
          return list;
        },

        // País que sugiere el navegador (por ejemplo es-CO), en el idioma de la página, o nil.
        guess_country() {
          const r = region();
          return r && CODES.includes(r) ? names(lang()).of(r) : null;
        },

        open_modal(d) {
          if (typeof d.showModal === "function") d.showModal();
          else d.setAttribute("open", "");
          return null;
        },
        close_modal(d) {
          if (typeof d.close === "function") d.close();
          else d.removeAttribute("open");
          return null;
        },

        // Cuenta un clic como evento en GoatCounter, sin cookies. Si un bloqueador lo impide, no pasa nada.
        count_event(name) {
          try { globalThis.goatcounter?.count?.({ path: String(name), title: String(name), event: true }); } catch { /* bloqueado */ }
          return null;
        },

        // Envía las respuestas. Google no deja leer la respuesta (no-cors), así que basta con que salga.
        send_survey(country, area, use) {
          const body = new URLSearchParams();
          if (country) body.append(FIELDS.country, String(country));
          if (area) body.append(FIELDS.area, String(area));
          if (use) body.append(FIELDS.use, String(use));
          try { fetch(FORM, { method: "POST", mode: "no-cors", body }).catch(() => {}); } catch { /* sin red */ }
          return null;
        },
      });
    },
  });
})();
