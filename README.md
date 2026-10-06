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
| `ignoreStatus`         | `[429]`        | Códigos HTTP que **descartam o ciclo** (ex.: rate limit): sem retry, sem contar como OK ou falha. `[]` desativa.     |
| `statusWindow`         | `5`            | Quantidade de checagens recentes usadas para calcular o status (ver [Regras de status](#regras-de-status)).          |
| `degradedFailures`     | `2`            | Falhas dentro da janela para o status ficar **Degradado**.                                                           |
| `outageFailures`       | `3`            | Falhas dentro da janela para o status ficar **Fora de Serviço**.                                                     |
| `slowThresholdMs`      | `null`         | Limite (ms) da mediana de resposta: acima dele, **Degradado**. `null` desativa a regra de latência.                  |
| `severeMultiplier`     | `2`            | Mediana acima de `slowThresholdMs × severeMultiplier` → **Degradado grave**. Deve ser maior que 1.                   |

Validação: `1 ≤ degradedFailures ≤ outageFailures ≤ statusWindow`. Garanta também que `slowThresholdMs × severeMultiplier` fique abaixo de `timeout`; caso contrário a checagem estoura o timeout (vira falha) antes de chegar ao "grave".

## Regras de status

A cada ciclo o endpoint é chamado; se falhar (erro de rede, timeout ou HTTP inesperado), é chamado novamente até `retries` vezes, esperando `retryDelay` entre as tentativas. O ciclo gera uma **checagem**: **OK** se qualquer tentativa teve sucesso (falhas passageiras resolvidas pelo retry não contam), ou **falha** se todas falharam.

Se alguma tentativa responder um código de `ignoreStatus` (padrão: `429`), o ciclo é **descartado** na hora: não há novas tentativas e ele não entra no status, nas barras nem no uptime (fica registrado no log como `IGNORADO`). Se um serviço só responder 429, ele continua com o último status conhecido e o "Verificado há" da página mostra há quanto tempo não há checagem válida.

O status do serviço é calculado sobre as últimas `statusWindow` checagens e vale o **pior** entre disponibilidade e latência:

| Status              | Disponibilidade (falhas na janela) | Latência (mediana das checagens OK na janela) |
| ------------------- | ---------------------------------- | --------------------------------------------- |
| **Operacional**     | abaixo de `degradedFailures`       | até `slowThresholdMs`                         |
| **Degradado**       | a partir de `degradedFailures`     | acima de `slowThresholdMs`                    |
| **Degradado grave** | —                                  | acima de `slowThresholdMs × severeMultiplier` |
| **Fora de Serviço** | a partir de `outageFailures`       | —                                             |

Com os padrões (janela 5, 2 e 3 falhas), uma falha isolada ou um pico de latência isolado **não alteram o status**. Para um serviço de 60 s: uma queda real fica **Degradado** na 2ª falha seguida e **Fora de Serviço** na 3ª; ao voltar, retorna a **Operacional** na 4ª checagem OK.

O próximo ciclo é agendado `interval` segundos após o **início** do ciclo anterior; se as tentativas demorarem mais que isso, o próximo ciclo começa logo em seguida (nunca há ciclos sobrepostos).

## Logs

Um arquivo por dia (horário local): `logs/status-AAAA-MM-DD.txt`, uma linha por ciclo:

```
2026-10-05 09:25:45.390 | api | OPERACIONAL     | HTTP 200 | 3 ms | tentativas 1/3 | GET https://...
2026-10-05 09:25:47.598 | api | OPERACIONAL     | HTTP 200 | 2 ms | tentativas 2/3 | GET https://... | falhas: HTTP 503
2026-10-05 09:26:46.500 | api | OPERACIONAL     | ECONNREFUSED | 1 ms | tentativas 3/3 | GET https://... | falhas: ECONNREFUSED; ECONNREFUSED; ECONNREFUSED
2026-10-05 09:27:46.480 | api | DEGRADADO       | ECONNREFUSED | 1 ms | tentativas 3/3 | GET https://... | falhas: ECONNREFUSED; ECONNREFUSED; ECONNREFUSED
2026-10-05 09:28:46.112 | api | IGNORADO        | HTTP 429 | 35 ms | tentativas 1/3 | GET https://...
```

Campos: data/hora · id · status do serviço · resultado da checagem (HTTP ou erro) · tempo de resposta da última tentativa · tentativas usadas · método e URL · falhas das tentativas.

O status gravado é o do serviço (já considerando a janela), por isso uma checagem com falha pode aparecer como `OPERACIONAL` (3ª linha: falha isolada). Uma checagem falhou quando todas as tentativas falharam (`tentativas 3/3` com 3 falhas).

A saída do console (vista em `pm2 logs`) registra apenas a inicialização e as **mudanças** de status. Para limitar o tamanho dos logs do próprio pm2, use o [`pm2-logrotate`](https://github.com/keymetrics/pm2-logrotate).

## Página de status e API

- `GET /` — página de status (atualiza a cada 10 s): banner geral, status de cada serviço, barras com as últimas verificações, uptime e tempo médio de resposta. Clicar em "Última resposta" ou "Média" abre, só para aquele serviço, um gráfico do tempo de resposta médio de cada barra (acompanha o período 4h/24h), com as linhas de `slowThresholdMs` e do "grave" quando estão na escala do gráfico.
- `GET /api/status?bars=60&hours=4` — os mesmos dados em JSON; `bars` (10 a 120, padrão 60) define em quantas barras o histórico é agrupado e `hours` o período coberto por elas (padrão `barsMinHours`, máximo `historyHours`).

### Barras de histórico

A página exibe 120 barras por serviço no desktop e 60 no celular (definido em `barSlots()`, `public/app.js`). Cada barra agrupa checagens consecutivas, de forma que o conjunto cubra no mínimo `barsMinHours` (ou 1 checagem por barra, se isso já cobrir o período):

| `interval` | Desktop (120 barras)              | Celular (60 barras)               |
| ---------- | --------------------------------- | --------------------------------- |
| 60 s       | 2 checagens/barra (2 min) → 4 h   | 4 checagens/barra (4 min) → 4 h   |
| 120 s      | 1 checagem/barra (2 min) → 4 h    | 2 checagens/barra (4 min) → 4 h   |
| 300 s      | 1 checagem/barra (5 min) → 10 h   | 1 checagem/barra (5 min) → 5 h    |

O botão **Histórico** acima da lista alterna o período das barras entre `barsMinHours` (padrão 4 h) e `historyHours` (padrão 24 h), para todos os serviços. A escolha fica salva no navegador de cada pessoa. Na visão de 24 h, com intervalo de 60 s, cada barra vale 12 min no desktop e 24 min no celular. Se os dois valores forem iguais, o botão não aparece.

A cor da barra é o **pior status do serviço** no período, ou seja, o status já calculado pela janela: falhas e picos isolados não colorem as barras. O uptime (%) e a média de resposta, por outro lado, usam as checagens reais, então uma falha isolada reduz levemente o uptime. O tooltip mostra o período, a quantidade de checagens, o detalhamento por status e a resposta média. Abaixo das barras, "1 barra = N min" indica quanto tempo cada barra representa.

O histórico exibido fica em memória e, ao iniciar, é reconstruído a partir dos arquivos de log das últimas `historyHours` horas (limitado à retenção dos logs). Os status são **recalculados** a partir do resultado de cada checagem gravado no log, com as regras e a configuração atuais. Assim, reiniciar o processo não zera as barras, o uptime nem o último status. O histórico é associado pelo `id` do endpoint: se o `id` mudar, o histórico anterior deixa de aparecer; linhas de endpoints removidos da configuração são ignoradas. O formato das linhas de log é usado nessa leitura, então mantenha-o se for alterá-lo (`formatLogLine` / `parseLogLine` em `src/monitor.js`).
