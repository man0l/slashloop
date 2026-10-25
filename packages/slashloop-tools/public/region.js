(function () {
  var $ = function (id) { return document.getElementById(id); };
  function set(id, text) { $(id).textContent = text; }

  function flag(code) {
    if (!/^[A-Z]{2}$/.test(code)) return "";
    return String.fromCodePoint.apply(null, code.split("").map(function (c) { return 127397 + c.charCodeAt(0); })) + " ";
  }
  function countryName(code) {
    try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code; } catch (e) { return code; }
  }

  fetch("/tools/api/geo", { cache: "no-store" })
    .then(function (res) { if (!res.ok) throw new Error("bad status"); return res.json(); })
    .then(function (g) {
      if (g.country) {
        var name = countryName(g.country);
        set("r-country", flag(g.country) + name + " (" + g.country + ")");
        set("r-infers", "From your IP alone, TikTok would most likely place you in " + name + ". It also uses your SIM country and app language, so this is the IP part only.");
      } else {
        set("r-country", "Unknown");
        set("r-infers", "We could not work out a country for this connection.");
      }
      set("r-region", g.region || "Unknown");
      set("r-city", g.city || "Unknown");
      set("r-isp", g.asOrganization ? g.asOrganization + (g.asn ? " (AS" + g.asn + ")" : "") : "Unknown");
      set("r-type", g.likelyDatacenter
        ? "Datacenter likely. This network belongs to a hosting provider, which platforms often treat with more suspicion."
        : "Residential or mobile likely. This is a heuristic, not a guarantee.");
      set("r-ip", g.ip || "Unknown");
    })
    .catch(function () {
      set("r-country", "Unavailable");
      var err = $("r-error");
      err.textContent = "The check failed. Please reload the page and try again.";
      err.hidden = false;
    });
})();
