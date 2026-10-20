// Connections page: Plaid Link and the remove confirmation. (External file: the CSP allows no inline script.)
(function () {
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function openLink(tokenUrl, body, onDone) {
    post(tokenUrl, body).then(function (res) {
      var handler = Plaid.create({
        token: res.link_token,
        onSuccess: function (public_token, metadata) {
          var inst = metadata && metadata.institution ? metadata.institution.name : null;
          post('/connections/exchange', { public_token: public_token, institution_name: inst, item_id: body.item_id || null, add: body.add || null })
            .then(function () { window.location.reload(); })
            .catch(function (e) { alert('Could not save the connection: ' + e.message); });
        },
        onExit: function (err) { if (err) alert('Plaid: ' + (err.display_message || err.error_message || 'link cancelled')); },
      });
      handler.open();
    }).catch(function (e) { alert('Could not start Plaid Link: ' + e.message); });
  }
  var btn = document.getElementById('link-btn');
  if (btn) btn.addEventListener('click', function () { openLink('/connections/link-token', {}); });
  document.querySelectorAll('.js-fix').forEach(function (b) {
    b.addEventListener('click', function () { openLink('/connections/link-token', { item_id: b.getAttribute('data-id') }); });
  });
  document.querySelectorAll('.js-statements').forEach(function (b) {
    b.addEventListener('click', function () {
      openLink('/connections/link-token', { item_id: b.getAttribute('data-id'), add: 'liabilities' });
    });
  });
  document.querySelectorAll('form.js-confirm').forEach(function (f) {
    f.addEventListener('submit', function (e) { if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
  });
}());
