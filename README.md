# PSW Status Monitor

Monitora uma lista de endpoints HTTP, grava os resultados em arquivos `.txt` diários e expõe uma página de status.

- Sem dependências externas (apenas módulos nativos do Node).
- Alvo: **Node 18.16** (`.nvmrc`), executado com **pm2**.

## Execução

```bash
# configuração (o config.json não é versionado)
cp config/config.json.example config/config.json

# desenvolvimento
npm start

# produção com pm2
pm2 start ecosystem.config.js
pm2 save            # persiste a lista de processos
pm2 startup         # (opcional) inicia o pm2 no boot
```

A página de status fica em `http://<host>:<port>/` (padrão `http://localhost:4300`).

> Rode sempre **uma única instância** (já configurado no `ecosystem.config.js`). Mais instâncias duplicariam as verificações.

Variáveis de ambiente opcionais:

| Variável      | Descrição                                                        |
| ------------- | ---------------------------------------------------------------- |
| `CONFIG_PATH` | Caminho do arquivo de configuração (padrão `config/config.json`) |
| `PORT`        | Sobrescreve `server.port`                                        |

## Configuração (`config/config.json`)

```json
{
  "title": "Status dos Serviços",
  "server": { "host": "0.0.0.0", "port": 4300 },
  "logs": { "dir": "./logs", "retentionDays": 5 },
  "maxStartDelay": 30,
  "historyHours": 24,
  "barsMinHours": 4,
  "defaults": { "timeout": 10, "retries": 3, "retryDelay": 5 },
  "endpoints": [
    {
      "id": "api",
      "name": "API Principal",
      "url": "https://api.exemplo.com/health",
      "interval": 60
    }
  ]
}
```

### Globais

| Campo                | Padrão                  | Descrição                                                                                                                                        |
| -------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`              | `"Status dos Serviços"` | Título da página.                                                                                                                                |
| `server.host/port`   | `0.0.0.0` / `4300`      | Onde a página de status escuta.                                                                                                                  |
| `logs.dir`           | `./logs`                | Pasta dos logs (relativa à raiz do projeto).                                                                                                     |
| `logs.retentionDays` | `5`                     | Dias de log mantidos (hoje + 4 anteriores). Arquivos mais antigos são apagados na inicialização e a cada hora.                                   |
| `maxStartDelay`      | `30`                    | Cada endpoint faz a 1ª chamada após um atraso aleatório entre 0 e `min(interval, maxStartDelay)` segundos, para não chamar todos ao mesmo tempo. |
| `historyHours`       | `24`                    | Janela usada para uptime e média de resposta. Ao iniciar, é recarregada a partir dos arquivos de log.                                            |
| `barsMinHours`       | `4`                     | Período mínimo coberto pelas barras de histórico da página (deve ser ≤ `historyHours`). Veja [Barras de histórico](#barras-de-histórico).        |
| `defaults`           | —                       | Valores padrão aplicados a todos os endpoints (qualquer campo abaixo).                                                                           |

### Por endpoint

| Campo                  | Padrão         | Descrição                                                                                                            |
| ---------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`                   | slug do `name` | Identificador único (usado nos logs).                                                                                |
| `name`                 | host da URL    | Nome exibido na página.                                                                                              |
| `url`                  | obrigatório    | URL http/https.                                                                                                      |
| `interval`             | obrigatório    | Intervalo entre verificações, em **segundos**.                                                                       |
| `method`               | `GET`          | Método HTTP (`GET`, `HEAD`, ...).                                                                                    |
| `headers`              | `{}`           | Cabeçalhos extras.                                                                                                   |
| `timeout`              | `10`           | Tempo máximo de cada tentativa, em segundos.                                                                         |
| `retries`              | `3`            | Novas tentativas após a primeira falha (total = `retries + 1`).                                                      |
| `retryDelay`           | `5`            | Espera entre tentativas, em segundos.                                                                                |
| `expectedStatus`       | `null`         | Código(s) HTTP aceitos, ex.: `[200, 204]`. `null` = qualquer 2xx/3xx.                                                |
| `slowThresholdMs`      | `null`         | Se a resposta passar desse tempo (ms), o status fica **Degradado**.                                                  |
| `failuresBeforeOutage` | `1`            | Ciclos consecutivos com todas as tentativas falhando até virar **Fora de Serviço**. Antes disso, fica **Degradado**. |

## Regras de status

A cada ciclo o endpoint é chamado; se falhar (erro de rede, timeout ou HTTP inesperado), é chamado novamente até `retries` vezes, esperando `retryDelay` entre as tentativas.

| Status              | Quando                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operacional**     | Sucesso na 1ª tentativa (e abaixo de `slowThresholdMs`, se configurado).                                                                                                     |
| **Degradado**       | Sucesso só após novas tentativas; **ou** resposta acima de `slowThresholdMs`; **ou** todas as tentativas falharam, mas ainda não por `failuresBeforeOutage` ciclos seguidos. |
| **Fora de Serviço** | Todas as tentativas falharam por `failuresBeforeOutage` ciclos consecutivos (com o padrão `1`, já no primeiro ciclo).                                                        |

O próximo ciclo é agendado `interval` segundos após o **início** do ciclo anterior; se as tentativas demorarem mais que isso, o próximo ciclo começa logo em seguida (nunca há ciclos sobrepostos).

## Logs

Um arquivo por dia (horário local): `logs/status-AAAA-MM-DD.txt`, uma linha por ciclo:

```
2026-10-05 09:25:45.390 | ok | OPERACIONAL     | HTTP 200 | 3 ms | tentativas 1/3 | GET https://...
2026-10-05 09:25:47.598 | flaky | DEGRADADO       | HTTP 200 | 2 ms | tentativas 3/3 | GET https://... | falhas: HTTP 503; HTTP 503
2026-10-05 09:25:46.500 | refused | FORA DE SERVIÇO | ECONNREFUSED | 1 ms | tentativas 3/3 | GET https://... | falhas: ECONNREFUSED; ECONNREFUSED; ECONNREFUSED
```

Campos: data/hora · id · status · resultado (HTTP ou erro) · tempo de resposta da última tentativa · tentativas usadas · método e URL · falhas das tentativas anteriores.

A saída do console (vista em `pm2 logs`) registra apenas a inicialização e as **mudanças** de status. Para limitar o tamanho dos logs do próprio pm2, use o [`pm2-logrotate`](https://github.com/keymetrics/pm2-logrotate).

## Página de status e API

- `GET /` — página de status (atualiza a cada 10 s): banner geral, status de cada serviço, barras com as últimas verificações, uptime e tempo médio de resposta.
- `GET /api/status?bars=60` — os mesmos dados em JSON; `bars` (10 a 120, padrão 60) define em quantas barras o histórico é agrupado.

### Barras de histórico

A página exibe 60 barras por serviço no desktop e 30 no celular. Cada barra agrupa checagens consecutivas, de forma que o conjunto cubra no mínimo `barsMinHours` (ou 1 checagem por barra, se isso já cobrir o período):

| `interval` | Desktop (60 barras)          | Celular (30 barras)          |
| ---------- | ---------------------------- | ---------------------------- |
| 60 s       | 4 checagens/barra → 4 h      | 8 checagens/barra → 4 h      |
| 120 s      | 2 checagens/barra → 4 h      | 4 checagens/barra → 4 h      |
| 300 s      | 1 checagem/barra → 5 h       | 2 checagens/barra → 5 h      |

A cor da barra é o **pior** status do grupo (uma falha isolada não é escondida). O tooltip mostra o período, a quantidade de checagens, o detalhamento por status e a resposta média. Abaixo das barras, "1 barra = N min" indica quanto tempo cada barra representa.

O histórico exibido fica em memória e, ao iniciar, é reconstruído a partir dos arquivos de log das últimas `historyHours` horas (limitado à retenção dos logs). Assim, reiniciar o processo não zera as barras, o uptime nem o último status. O histórico é associado pelo `id` do endpoint: se o `id` mudar, o histórico anterior deixa de aparecer; linhas de endpoints removidos da configuração são ignoradas. O formato das linhas de log é usado nessa leitura, então mantenha-o se for alterá-lo (`formatLogLine` / `parseLogLine` em `src/monitor.js`).
