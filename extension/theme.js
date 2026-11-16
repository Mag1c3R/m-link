// Ставит выбранную тему до первой отрисовки, чтобы popup не мигал чужой темой.
// Выбор хранится в localStorage: 'auto' (как в системе), 'light' или 'dark'. Остальное — в popup.js.
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('theme') || '"auto"');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) { /* нет доступа к хранилищу — остаётся системная тема */ }
})();
