(function () {
  'use strict';

  var REFRESH_MS = 10000;

  var LABELS = {
    operational: 'Operacional',
    degraded: 'Degradado',
    severe: 'Degradado grave',
    outage: 'Fora de Serviço',
    pending: 'Aguardando',
  };

  var BANNERS = {
    operational: { icon: '✓', title: 'Todos os sistemas operacionais' },
    degraded: { icon: '!', title: 'Alguns serviços apresentam instabilidade' },
    severe: { icon: '!', title: 'Há serviços com degradação grave' },
    outage: { icon: '✕', title: 'Há serviços fora do ar' },
    pending: { icon: '…', title: 'Aguardando as primeiras verificações' },
    error: { icon: '?', title: 'Não foi possível obter o status do monitor' },
  };

  var FAVICON_COLORS = {
    operational: '#16a34a',
    degraded: '#e09100',
    severe: '#ea580c',
    outage: '#dc2626',
    pending: '#98a2b3',
    error: '#98a2b3',
  };

  var HOURS_STORAGE_KEY = 'psw-status-hours';

  var narrowScreen = window.matchMedia('(max-width: 640px)');
  var lastData = null;
  var refreshTimer = null;
  var requestSeq = 0;
  var clockOffset = 0; // diferença entre o relógio do servidor e o do navegador
  var selectedHours = loadSelectedHours(); // período das barras escolhido no botão (null = padrão do servidor)

  // Quantidade de barras por serviço; o servidor agrupa as checagens para caber nelas.
  function barSlots() { return narrowScreen.matches ? 60 : 120; }

  // A escolha do período é só uma preferência deste navegador: sem armazenamento, vale apenas nesta visita.
  function loadSelectedHours() {
    try {
      var hours = Number(window.localStorage.getItem(HOURS_STORAGE_KEY));
      return hours > 0 ? hours : null;
    } catch (e) {
      return null;
    }
  }

  function saveSelectedHours(hours) {
    try { window.localStorage.setItem(HOURS_STORAGE_KEY, String(hours)); } catch (e) { /* ignora */ }
  }

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
    var h = Math.round(m / 60);
    if (h < 48) return 'há ' + h + ' h';
    return 'há ' + Math.round(h / 24) + ' d';
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

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDuration(seconds) {
    if (seconds < 60) return seconds + ' s';
    if (seconds < 3600) return (seconds / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' min';
    return (seconds / 3600).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' h';
  }

  function since(ts) {
    return '<span data-since="' + ts + '">' + relative(ts) + '</span>';
  }

  function barTooltip(bar) {
    if (bar.checks === 1) {
      return fmtDateTime(bar.from) + '\n' + LABELS[bar.status] +
        (bar.avgResponseTime != null ? ' · ' + fmtMs(bar.avgResponseTime) : '');
    }
    var lines = [
      fmtDateTime(bar.from) + ' – ' + fmtTime(bar.to),
      LABELS[bar.status] + ' · ' + bar.checks + ' verificações',
    ];
    var breakdown = ['operational', 'degraded', 'severe', 'outage']
      .filter(function (s) { return bar.counts[s] > 0; })
      .map(function (s) { return bar.counts[s] + ' ' + LABELS[s].toLowerCase(); });
    if (breakdown.length > 1) lines.push(breakdown.join(' · '));
    if (bar.avgResponseTime != null) lines.push('Resposta média ' + fmtMs(bar.avgResponseTime));
    return lines.join('\n');
  }

  function renderBars(bars, slots) {
    var html = '';
    for (var i = bars.length; i < slots; i++) {
      html += '<span class="bar bar--empty" data-tip="Sem dados"></span>';
    }
    bars.forEach(function (bar) {
      html += '<span class="bar bar--' + bar.status + '" data-tip="' + esc(barTooltip(bar)) + '"></span>';
    });
    return html;
  }

  function renderService(svc, data) {
    var historyHours = data.historyHours;
    var oldest = svc.bars.length ? svc.bars[0].from : null;
    var showMessage = svc.message && svc.status !== 'operational';
    var frequency = 'A cada ' + svc.interval + ' s' +
      (svc.checksPerBar > 1 ? ' · 1 barra = ' + fmtDuration(svc.checksPerBar * svc.interval) : '');

    var meta = svc.lastCheck
      ? '<span>Última resposta <b>' + fmtMs(svc.responseTime) + '</b></span>' +
      '<span>Média ' + historyHours + 'h <b>' + fmtMs(svc.avgResponseTime) + '</b></span>' +
      '<span>Verificado ' + since(svc.lastCheck) + '</span>' +
      '<span>' + frequency + '</span>'
      : '<span>Aguardando a primeira verificação (a cada ' + svc.interval + ' s)</span>';

    return (
      '<li class="service">' +
      '<div class="service__head">' +
      '<span class="service__name">' + esc(svc.name) + '</span>' +
      '<span class="pill pill--' + svc.status + '"><span class="dot"></span>' + LABELS[svc.status] + '</span>' +
      '</div>' +
      '<div class="bars">' + renderBars(svc.bars, data.barSlots) + '</div>' +
      '<div class="bars__axis">' +
      '<span>' + (oldest ? since(oldest) : '') + '</span>' +
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
    var counts = { operational: 0, degraded: 0, severe: 0, outage: 0, pending: 0 };
    services.forEach(function (s) { counts[s.status]++; });
    var parts = [];
    if (counts.operational) parts.push(counts.operational + ' operaciona' + (counts.operational > 1 ? 'is' : 'l'));
    if (counts.degraded) parts.push(counts.degraded + ' degradado' + (counts.degraded > 1 ? 's' : ''));
    if (counts.severe) parts.push(counts.severe + (counts.severe > 1 ? ' degradados graves' : ' degradado grave'));
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

  // Botão "4h | 24h": período padrão das barras (barsMinHours) ou o histórico completo (historyHours).
  function renderRange(data) {
    var range = $('range');
    var options = [data.barsMinHours, data.historyHours];
    if (options[0] === options[1]) {
      range.hidden = true;
      return;
    }
    range.innerHTML =
      '<span class="range__label">Histórico</span>' +
      '<div class="range__options" role="group" aria-label="Período do histórico">' +
      options.map(function (hours) {
        return '<button type="button" data-hours="' + hours + '" aria-pressed="' + (hours === data.barsHours) + '">' +
          hours + 'h</button>';
      }).join('') +
      '</div>';
    range.hidden = false;
  }

  function render(data) {
    document.title = data.title;
    $('title').textContent = data.title;
    $('updated').innerHTML = since(data.generatedAt);
    setBanner(data.overall, esc(bannerSubtitle(data.services)));
    renderRange(data);

    $('services').innerHTML = data.services.length
      ? data.services.map(function (svc) { return renderService(svc, data); }).join('')
      : '<li class="empty-state">Nenhum serviço configurado.</li>';
  }

  function refresh() {
    clearTimeout(refreshTimer);
    // Só a busca mais recente é exibida (ex.: a resposta antiga não desfaz uma troca de período).
    var seq = ++requestSeq;
    var query = 'bars=' + barSlots() + (selectedHours ? '&hours=' + selectedHours : '');
    fetch('api/status?' + query, { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (seq !== requestSeq) return;
        clockOffset = data.generatedAt - Date.now();
        lastData = data;
        hideTooltip();
        render(data);
      })
      .catch(function (err) {
        if (seq !== requestSeq) return;
        var subtitle = esc(err.message);
        if (lastData) subtitle += ' · exibindo dados de ' + since(lastData.generatedAt);
        setBanner('error', subtitle);
      })
      .then(function () {
        if (seq !== requestSeq) return; // a busca mais recente agenda a próxima
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, REFRESH_MS);
      });
  }

  // Atualiza os tempos relativos ("há 12 s") a cada segundo.
  setInterval(function () {
    document.querySelectorAll('[data-since]').forEach(function (el) {
      el.textContent = relative(Number(el.getAttribute('data-since')));
    });
  }, 1000);

  // A quantidade de barras depende da largura da tela: busca de novo ao mudar.
  narrowScreen.addEventListener('change', refresh);

  $('range').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-hours]');
    if (!button || button.getAttribute('aria-pressed') === 'true') return;
    selectedHours = Number(button.getAttribute('data-hours'));
    saveSelectedHours(selectedHours);
    $('range').querySelectorAll('button').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b === button));
    });
    refresh();
  });

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
