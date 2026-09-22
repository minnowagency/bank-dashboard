/* Progressive enhancement. Every control below is a real link, form or select
   that works on its own; this script just avoids full page reloads. */
(function () {
  'use strict';
  var overview = document.getElementById('overview');

  function swap(url, push) {
    if (!overview) { window.location = url; return; }
    var target = url + (url.indexOf('?') === -1 ? '?' : '&') + 'partial=1';
    overview.classList.add('loading');
    fetch(target, { headers: { 'X-Partial': '1' }, credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
      .then(function (html) {
        overview.innerHTML = html;
        overview.classList.remove('loading');
        if (push !== false) history.replaceState(null, '', url);
      })
      .catch(function () { window.location = url; }); // fall back to a real navigation
  }

  function formUrl() {
    var form = document.querySelector('.js-filters');
    if (!form) return '/';
    var data = new FormData(form);
    var params = new URLSearchParams();
    data.forEach(function (v, k) { if (String(v) !== '') params.set(k, v); });
    // keep the account filter, which lives in the tile links rather than the form
    var current = new URLSearchParams(window.location.search);
    if (current.get('account')) params.set('account', current.get('account'));
    if (!params.get('period') && current.get('period')) params.set('period', current.get('period'));
    var s = params.toString();
    return s ? '/?' + s : '/';
  }

  var timer;
  function scheduleFilter() {
    clearTimeout(timer);
    timer = setTimeout(function () { swap(formUrl()); }, 250);
  }

  document.addEventListener('input', function (e) {
    if (e.target.closest && e.target.closest('.js-filters')) scheduleFilter();
  });
  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('js-cat')) { saveCategory(t); return; }
    if (t.closest && t.closest('.js-filters')) scheduleFilter();
  });

  // Tiles, date chips and any other overview link: swap instead of navigating.
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('#overview a.tile, #overview a.chip');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    swap(a.getAttribute('href'));
  });

  document.addEventListener('submit', function (e) {
    if (e.target.classList && e.target.classList.contains('js-filters')) {
      e.preventDefault();
      swap(formUrl());
    }
  });

  function saveCategory(select) {
    var uid = select.getAttribute('data-uid');
    var body = new URLSearchParams();
    body.set('category_id', select.value);
    select.disabled = true;
    fetch('/txns/' + encodeURIComponent(uid) + '/category', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function () {
        select.disabled = false;
        select.classList.toggle('none', !select.value);
        var row = select.closest('.row');
        var badge = row && row.querySelector('.ai-badge');
        if (badge) badge.remove(); // a human decided; the AI marker no longer applies
        flash(select);
      })
      .catch(function () { select.disabled = false; window.location.reload(); });
  }

  function flash(el) {
    var tick = document.createElement('span');
    tick.className = 'saved';
    tick.textContent = '✓';
    el.parentNode.appendChild(tick);
    setTimeout(function () { tick.remove(); }, 1200);
  }

  /* Review page: checkbox selection + the bulk bar. */
  var bulkForm = document.getElementById('bulkform');
  if (bulkForm) {
    var bar = document.getElementById('bulkbar');
    var count = document.getElementById('bulkcount');
    var all = document.getElementById('selectall');

    function boxes() { return Array.prototype.slice.call(bulkForm.querySelectorAll('input[name="uids"]')); }
    function refresh() {
      var n = boxes().filter(function (b) { return b.checked; }).length;
      bar.hidden = n === 0;
      if (count) count.textContent = n + (n === 1 ? ' selected' : ' selected');
      boxes().forEach(function (b) { b.closest('tr').classList.toggle('sel', b.checked); });
    }
    bulkForm.addEventListener('change', function (e) {
      if (e.target === all) boxes().forEach(function (b) { b.checked = all.checked; });
      if (e.target.name === 'uids' || e.target === all) refresh();
    });
    refresh();
  }
}());
