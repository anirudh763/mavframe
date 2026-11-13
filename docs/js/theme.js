// Applies a remembered explicit dark-theme choice before first paint. Light is
// the default whatever the OS prefers; dark only after the user turns it on.
(function () {
  try {
    if (window.localStorage.getItem("mavframe-theme") === "dark") document.documentElement.setAttribute("data-theme", "dark");
  } catch (e) { /* storage blocked: stay light */ }
}());
