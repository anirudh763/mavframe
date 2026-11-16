// Applies a remembered app theme before first paint. Sand/amber is the Mavframe
// default; the user's earlier app-specific light/dark choice is migrated once.
(function () {
  document.documentElement.setAttribute("data-theme", "light");
  try {
    const store = window.localStorage;
    let theme = store.getItem("mavframe_theme_v1") || store.getItem("mavframe:pwa:guest-theme:v1");
    if (theme !== "dark" && theme !== "light") {
      const legacy = store.getItem("mavframe-theme");
      if (legacy === "dark" || legacy === "light") theme = legacy;
    }
    if (theme === "dark" || theme === "light") {
      document.documentElement.setAttribute("data-theme", theme);
      if (!store.getItem("mavframe_theme_v1")) { try { store.setItem("mavframe_theme_v1", theme); } catch { /* Theme still applies when storage is full. */ } }
    }
  } catch (e) { /* Storage blocked: keep the light default. */ }
}());
