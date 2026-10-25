(function () {
  var $ = function (id) { return document.getElementById(id); };
  var LABELS = { listed: "Listed", clean: "Clean", unknown: "Unknown" };

  function showError(msg) {
    var el = $("bl-error");
    el.textContent = msg || "";
    el.hidden = !msg;
  }

  function resetRows() {
    var cells = document.querySelectorAll("#bl-rows .status");
    for (var i = 0; i < cells.length; i++) cells[i].textContent = "—";
  }

  function check(ip) {
    showError("");
    $("bl-summary").textContent = "Checking…";
    resetRows();
    return fetch("/tools/api/dnsbl?ip=" + encodeURIComponent(ip), { cache: "no-store" })
      .then(function (res) {
        return res.json().then(function (data) { return { res: res, data: data }; });
      })
      .then(function (r) {
        if (!r.res.ok) {
          $("bl-summary").textContent = "";
          showError(r.data && r.data.error ? r.data.error : "The check failed. Please try again.");
          return;
        }
        r.data.results.forEach(function (item) {
          var row = document.querySelector('#bl-rows tr[data-zone="' + item.zone + '"] .status');
          if (row) row.textContent = LABELS[item.status] || "Unknown";
        });
        var listed = r.data.listedCount;
        $("bl-summary").textContent = r.data.ip + " is listed on " + listed + " of " + r.data.results.length + " blocklists.";
      })
      .catch(function () {
        $("bl-summary").textContent = "";
        showError("The check failed. Please try again.");
      });
  }

  $("bl-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var ip = $("bl-ip").value.trim();
    if (!ip) { showError("Enter an IPv4 address."); return; }
    check(ip);
  });

  fetch("/tools/api/geo", { cache: "no-store" })
    .then(function (res) { return res.json(); })
    .then(function (g) {
      if (g.ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(g.ip) && !$("bl-ip").value) {
        $("bl-ip").value = g.ip;
        check(g.ip);
      } else if (g.ip && !$("bl-ip").value) {
        showError("Your connection uses IPv6, which this tool does not support yet. Enter an IPv4 address to check.");
      }
    })
    .catch(function () {});
})();
