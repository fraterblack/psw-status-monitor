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
  var expandedCharts = {}; // serviços com o gráfico de tempo de resposta aberto (sobrevive às atualizações)

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

  // ---- Gráfico de tempo de resposta (aberto ao clicar em "Última resposta" ou "Média") ----
  // O SVG usa coordenadas fixas esticadas na largura das barras; textos ficam em HTML para não distorcer.
  var CHART_W = 1000;
  var CHART_H = 100;

  function niceCeil(value) {
    if (value <= 0) return 1;
    var exp = Math.pow(10, Math.floor(Math.log10(value)));
    var f = value / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  }

  // A escala tem ao menos 10% de folga acima do maior valor, então a linha não encosta no topo.
  function chartY(ms, yMax) {
    return ((1 - ms / yMax) * CHART_H).toFixed(1);
  }

  // Média de cada barra, alinhada às barras de cima; barras sem resposta com sucesso interrompem a linha.
  function chartPaths(svc, slots, yMax) {
    var offset = slots - svc.bars.length;
    var line = '';
    var area = '';
    var segment = [];
    function flush() {
      if (!segment.length) return;
      var points = segment.join('L');
      line += 'M' + points + (segment.length === 1 ? 'l0.1,0' : '');
      area += 'M' + segment[0].split(',')[0] + ',' + CHART_H + 'L' + points +
        'L' + segment[segment.length - 1].split(',')[0] + ',' + CHART_H + 'Z';
      segment = [];
    }
    svc.bars.forEach(function (bar, i) {
      if (bar.avgResponseTime == null) return flush();
      segment.push(((offset + i + 0.5) / slots * CHART_W).toFixed(1) + ',' + chartY(bar.avgResponseTime, yMax));
    });
    flush();
    return { line: line, area: area };
  }

  function renderChart(svc, data) {
    var values = svc.bars.map(function (b) { return b.avgResponseTime; }).filter(function (v) { return v != null; });
    if (!values.length) {
      return '<div class="chart"><p class="chart__empty">Sem respostas com sucesso no período.</p></div>';
    }

    // Escala pelos dados; os limites entram na escala só quando estão próximos (senão achatariam a linha).
    var dataMax = Math.max.apply(null, values);
    var limits = [
      { ms: svc.slowThresholdMs, cls: 'degraded', label: 'limite de lentidão' },
      { ms: svc.severeThresholdMs, cls: 'severe', label: 'grave' },
    ].filter(function (l) { return l.ms != null; });
    var scaleMax = dataMax;
    limits.forEach(function (l) { if (l.ms <= dataMax * 1.5) scaleMax = Math.max(scaleMax, l.ms); });
    var yMax = niceCeil(scaleMax * 1.1);

    var paths = chartPaths(svc, data.barSlots, yMax);
    var grid = [0, 0.5, 1].map(function (f) {
      var y = chartY(yMax * f, yMax);
      return '<line class="chart__grid" x1="0" x2="' + CHART_W + '" y1="' + y + '" y2="' + y + '" vector-effect="non-scaling-stroke"/>';
    }).join('');
    var limitLines = limits.filter(function (l) { return l.ms <= yMax; }).map(function (l) {
      var y = chartY(l.ms, yMax);
      return '<line class="chart__limit chart__limit--' + l.cls + '" x1="0" x2="' + CHART_W + '" y1="' + y + '" y2="' + y +
        '" vector-effect="non-scaling-stroke"/>';
    }).join('');
    var legend = ['<span class="chart__key chart__key--avg">Resposta média por barra</span>'].concat(limits.map(function (l) {
      return '<span class="chart__key chart__key--' + l.cls + '">' + capitalize(l.label) + ' ' + fmtMs(l.ms) +
        (l.ms > yMax ? ' (fora da escala)' : '') + '</span>';
    })).join('');

    return (
      '<div class="chart">' +
      '<div class="chart__plot" data-service="' + esc(svc.id) + '">' +
      '<svg viewBox="0 0 ' + CHART_W + ' ' + CHART_H + '" preserveAspectRatio="none" aria-hidden="true">' +
      grid + limitLines +
      '<path class="chart__area" d="' + paths.area + '"/>' +
      '<path class="chart__line" d="' + paths.line + '" vector-effect="non-scaling-stroke"/>' +
      '<line class="chart__guide" x1="0" x2="0" y1="0" y2="' + CHART_H + '" visibility="hidden" vector-effect="non-scaling-stroke"/>' +
      '</svg>' +
      '<div class="chart__y"><span>' + fmtMs(yMax) + '</span><span>' + fmtMs(Math.round(yMax / 2)) + '</span><span>0</span></div>' +
      '</div>' +
      '<div class="chart__legend">' + legend + '</div>' +
      '</div>'
    );
  }

  function chartToggle(svc, kind, label, value) {
    var open = Boolean(expandedCharts[svc.id]);
    return '<button type="button" class="meta-toggle" data-chart-toggle="' + esc(svc.id) + '" data-kind="' + kind + '"' +
      ' aria-expanded="' + open + '" title="' + (open ? 'Ocultar' : 'Mostrar') + ' gráfico de tempo de resposta">' +
      label + ' <b>' + value + '</b></button>';
  }

  function renderService(svc, data) {
    var historyHours = data.historyHours;
    var oldest = svc.bars.length ? svc.bars[0].from : null;
    var showMessage = svc.message && svc.status !== 'operational';
    var frequency = 'A cada ' + svc.interval + ' s' +
      (svc.checksPerBar > 1 ? ' · 1 barra = ' + fmtDuration(svc.checksPerBar * svc.interval) : '');

    var meta = svc.lastCheck
      ? chartToggle(svc, 'last', 'Última resposta', fmtMs(svc.responseTime)) +
      chartToggle(svc, 'avg', 'Média ' + historyHours + 'h', fmtMs(svc.avgResponseTime)) +
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
      (svc.lastCheck && expandedCharts[svc.id] ? renderChart(svc, data) : '') +
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

  // Abre/fecha o gráfico só do serviço clicado; o estado sobrevive às atualizações automáticas.
  $('services').addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-chart-toggle]');
    if (!toggle || !lastData) return;
    var id = toggle.getAttribute('data-chart-toggle');
    var kind = toggle.getAttribute('data-kind');
    if (expandedCharts[id]) delete expandedCharts[id];
    else expandedCharts[id] = true;
    hideTooltip();
    render(lastData);
    // A lista é recriada: devolve o foco ao botão clicado (navegação por teclado).
    var selector = '[data-chart-toggle="' + id.replace(/["\\]/g, '\\$&') + '"][data-kind="' + kind + '"]';
    var again = $('services').querySelector(selector);
    if (again) again.focus();
  });

  // Tooltip das barras e do gráfico
  var tooltip = $('tooltip');

  function hideGuide() {
    var guide = $('services').querySelector('.chart__guide[visibility="visible"]');
    if (guide) guide.setAttribute('visibility', 'hidden');
  }

  function hideTooltip() {
    tooltip.hidden = true;
    hideGuide();
  }

  function showTooltip(text, anchorX, anchorTop) {
    tooltip.textContent = text;
    tooltip.hidden = false;
    var width = tooltip.offsetWidth;
    var left = Math.max(8, Math.min(anchorX - width / 2, document.documentElement.clientWidth - width - 8));
    tooltip.style.left = left + window.scrollX + 'px';
    tooltip.style.top = anchorTop + window.scrollY - tooltip.offsetHeight - 8 + 'px';
  }

  // No gráfico, a posição do mouse corresponde à barra de mesma posição horizontal.
  function showChartTooltip(plot, event) {
    var id = plot.getAttribute('data-service');
    var svc = lastData && lastData.services.filter(function (s) { return s.id === id; })[0];
    if (!svc) return hideTooltip();
    var slots = lastData.barSlots;
    var rect = plot.getBoundingClientRect();
    var slot = Math.min(slots - 1, Math.max(0, Math.floor((event.clientX - rect.left) / rect.width * slots)));
    var bar = svc.bars[slot - (slots - svc.bars.length)];
    if (!bar) return hideTooltip();

    var guide = plot.querySelector('.chart__guide');
    var x = ((slot + 0.5) / slots * CHART_W).toFixed(1);
    guide.setAttribute('x1', x);
    guide.setAttribute('x2', x);
    guide.setAttribute('visibility', 'visible');
    showTooltip(barTooltip(bar), rect.left + (slot + 0.5) / slots * rect.width, rect.top);
  }

  function onPointer(event) {
    var plot = event.target.closest('.chart__plot');
    if (plot) return showChartTooltip(plot, event);
    hideGuide();
    var bar = event.target.closest('.bar');
    if (!bar) return hideTooltip();
    var rect = bar.getBoundingClientRect();
    showTooltip(bar.getAttribute('data-tip'), rect.left + rect.width / 2, rect.top);
  }

  $('services').addEventListener('mouseover', onPointer);
  $('services').addEventListener('mousemove', onPointer);
  $('services').addEventListener('mouseleave', hideTooltip);

  refresh();
})();
