(function () {
  try {
    var stored = localStorage.getItem("accord_theme") || localStorage.getItem("theme");
    var isDark = false;
    if (stored === "dark") {
      isDark = true;
    } else if (stored === "light") {
      isDark = false;
    } else {
      isDark = Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    }
    if (isDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  } catch {
    // Ignore storage or matchMedia access errors
  }
})();
