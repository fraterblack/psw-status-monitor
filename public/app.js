(function () {
  'use strict';

  var REFRESH_MS = 10000;

  var LABELS = {
    operational: 'Operacional',
    degraded: 'Degradado',
    outage: 'Fora de Serviço',
    pending: 'Aguardando',
  };

  var BANNERS = {
    operational: { icon: '✓', title: 'Todos os sistemas operacionais' },
    degraded: { icon: '!', title: 'Alguns serviços apresentam instabilidade' },
    outage: { icon: '✕', title: 'Há serviços fora do ar' },
    pending: { icon: '…', title: 'Aguardando as primeiras verificações' },
    error: { icon: '?', title: 'Não foi possível obter o status do monitor' },
  };

  var FAVICON_COLORS = {
    operational: '#16a34a',
    degraded: '#e09100',
    outage: '#dc2626',
    pending: '#98a2b3',
    error: '#98a2b3',
  };

  var narrowScreen = window.matchMedia('(max-width: 640px)');
  var lastData = null;
  var clockOffset = 0; // diferença entre o relógio do servidor e o do navegador

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function serverNow() { return Date.now() + clockOffset; }

  function relative(ts) {
    var s = Math.max(0, Math.round((serverNow() - ts) / 1000));
    if (s < 5) return 'agora';
    if (s < 60) return 'há ' + s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return 'há ' + m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return 'há ' + h + ' h';
    return 'há ' + Math.floor(h / 24) + ' d';
  }

  function fmtMs(ms) { return ms == null ? '—' : ms.toLocaleString('pt-BR') + ' ms'; }

  function fmtPct(p) {
    if (p == null) return '—';
    return p.toLocaleString('pt-BR', { minimumFractionDigits: p === 100 ? 0 : 2, maximumFractionDigits: 2 }) + '%';
  }

  function fmtDateTime(ts) {
    return new Date(ts).toLocaleString('pt-BR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function since(ts) {
    return '<span data-since="' + ts + '">' + relative(ts) + '</span>';
  }

  function renderBars(history) {
    var slots = narrowScreen.matches ? 30 : 60;
    var items = history.slice(-slots);
    var html = '';
    for (var i = items.length; i < slots; i++) {
      html += '<span class="bar bar--empty" data-tip="Sem dados"></span>';
    }
    items.forEach(function (h) {
      var tip = fmtDateTime(h.t) + ' · ' + LABELS[h.s] + (h.s === 'outage' ? '' : ' · ' + fmtMs(h.rt));
      html += '<span class="bar bar--' + h.s + '" data-tip="' + esc(tip) + '"></span>';
    });
    return { html: html, oldest: items.length ? items[0].t : null };
  }

  function renderService(svc, historyHours) {
    var bars = renderBars(svc.history);
    var showMessage = svc.message && svc.status !== 'operational';

    var meta = svc.lastCheck
      ? '<span>Última resposta <b>' + fmtMs(svc.responseTime) + '</b></span>' +
        '<span>Média ' + historyHours + 'h <b>' + fmtMs(svc.avgResponseTime) + '</b></span>' +
        '<span>Verificado ' + since(svc.lastCheck) + '</span>' +
        '<span>A cada ' + svc.interval + ' s</span>'
      : '<span>Aguardando a primeira verificação (a cada ' + svc.interval + ' s)</span>';

    return (
      '<li class="service">' +
        '<div class="service__head">' +
          '<span class="service__name">' + esc(svc.name) + '</span>' +
          '<span class="pill pill--' + svc.status + '"><span class="dot"></span>' + LABELS[svc.status] + '</span>' +
        '</div>' +
        '<div class="bars">' + bars.html + '</div>' +
        '<div class="bars__axis">' +
          '<span>' + (bars.oldest ? since(bars.oldest) : '') + '</span>' +
          '<span class="axis-line"></span>' +
          '<span class="uptime">' + fmtPct(svc.uptime) + ' uptime (' + historyHours + 'h)</span>' +
          '<span class="axis-line"></span>' +
          '<span>agora</span>' +
        '</div>' +
        '<div class="service__meta">' + meta + '</div>' +
        (showMessage
          ? '<div class="service__message pill--' + svc.status + '">' + esc(capitalize(svc.message)) + '</div>'
          : '') +
      '</li>'
    );
  }

  function capitalize(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

  function bannerSubtitle(services) {
    var counts = { operational: 0, degraded: 0, outage: 0, pending: 0 };
    services.forEach(function (s) { counts[s.status]++; });
    var parts = [];
    if (counts.operational) parts.push(counts.operational + ' operacional' + (counts.operational > 1 ? 'is' : ''));
    if (counts.degraded) parts.push(counts.degraded + ' degradado' + (counts.degraded > 1 ? 's' : ''));
    if (counts.outage) parts.push(counts.outage + ' fora de serviço');
    if (counts.pending) parts.push(counts.pending + ' aguardando');
    return services.length + ' serviço' + (services.length > 1 ? 's' : '') + ' monitorado' +
      (services.length > 1 ? 's' : '') + ' · ' + parts.join(' · ');
  }

  function setBanner(state, subtitle) {
    var banner = BANNERS[state];
    $('banner').className = 'banner banner--' + state;
    $('banner-icon').textContent = banner.icon;
    $('banner-title').textContent = banner.title;
    $('banner-subtitle').innerHTML = subtitle;
    setFavicon(FAVICON_COLORS[state]);
  }

  function setFavicon(color) {
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='7' fill='" + color + "'/></svg>";
    $('favicon').href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }

  function render(data) {
    document.title = data.title;
    $('title').textContent = data.title;
    $('updated').innerHTML = since(data.generatedAt);
    setBanner(data.overall, esc(bannerSubtitle(data.services)));

    $('services').innerHTML = data.services.length
      ? data.services.map(function (svc) { return renderService(svc, data.historyHours); }).join('')
      : '<li class="empty-state">Nenhum serviço configurado.</li>';
  }

  function refresh() {
    fetch('api/status', { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        clockOffset = data.generatedAt - Date.now();
        lastData = data;
        hideTooltip();
        render(data);
      })
      .catch(function (err) {
        var subtitle = esc(err.message);
        if (lastData) subtitle += ' · exibindo dados de ' + since(lastData.generatedAt);
        setBanner('error', subtitle);
      })
      .then(function () { setTimeout(refresh, REFRESH_MS); });
  }

  // Atualiza os tempos relativos ("há 12 s") a cada segundo.
  setInterval(function () {
    document.querySelectorAll('[data-since]').forEach(function (el) {
      el.textContent = relative(Number(el.getAttribute('data-since')));
    });
  }, 1000);

  // Re-renderiza ao mudar a largura da tela (quantidade de barras).
  narrowScreen.addEventListener('change', function () { if (lastData) render(lastData); });

  // Tooltip das barras
  var tooltip = $('tooltip');

  function hideTooltip() { tooltip.hidden = true; }

  $('services').addEventListener('mouseover', function (event) {
    var bar = event.target.closest('.bar');
    if (!bar) return hideTooltip();

    tooltip.textContent = bar.getAttribute('data-tip');
    tooltip.hidden = false;

    var rect = bar.getBoundingClientRect();
    var width = tooltip.offsetWidth;
    var left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, document.documentElement.clientWidth - width - 8));
    tooltip.style.left = left + window.scrollX + 'px';
    tooltip.style.top = rect.top + window.scrollY - tooltip.offsetHeight - 8 + 'px';
  });
  $('services').addEventListener('mouseleave', hideTooltip);

  refresh();
})();
