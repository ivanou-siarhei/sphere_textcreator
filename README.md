# AGENT-SPHERE — TextCreator

Платный агент-копирайтер на Unicity Sphere. Пользователь пишет агенту в Direct Message
запрос на текст, платит `PRICE` UCT на неймтег агента, агент генерирует текст через
OpenRouter LLM и присылает его в DM.

- `agent/` — бэкенд агента (Node.js), единственный исходник `index.js`
- `frontend/` — лендинг-визитка (Vite + React)

## Требования

- Node.js **>= 22** (требование `@unicitylabs/sphere-sdk`)
- ключ [OpenRouter](https://openrouter.ai) (формат `sk-or-v1-...`)

## Запуск агента

```bash
cd agent
npm install
cp .env.example .env        # Windows: Copy-Item .env.example .env
npm start
```

Перед запуском заполните `agent/.env`:

| Переменная | Описание |
|---|---|
| `OPENROUTER_API_KEY` | ключ OpenRouter (`sk-or-v1-...`) |
| `NETWORK` | `testnet2` (по умолчанию) |
| `PRICE` | цена за текст в UCT (по умолчанию 10) |
| `NAMETAG` | неймтег агента в Sphere (по умолчанию `textcreator`) |
| `MNEMONIC` | необязательно; при первом запуске кошелёк создаётся сам, сид пишется в `data/mnemonic.txt` |
| `DEVICE_ID` | стабильная метка устройства для wallet-api (пропускает переавторизацию) |

При первом запуске агент создаёт кошелёк и регистрирует неймтег. Сохраните сид из
`data/mnemonic.txt` в защищённое хранилище (переменная `MNEMONIC`) и удалите файл.

Оплату агент принимает переводом `PRICE` UCT на свой неймтег; пользователь должен указать
в memo код заказа (`TC-XXXXXX`), который агент выдаёт при приёме запроса.

## Тестовые UCT (testnet2)

Официального faucet нет — токены само-minтятся. Минимальный способ для тестового кошелька:

```js
import { Sphere, createBrowserProviders } from '@unicitylabs/sphere-sdk';
// или nodejs-провайдеры; затем:
await sphere.payments.mint(getCoinIdBySymbol('UCT'), 10_000_000n); // 10 UCT, 6 знаков
```

## Лендинг

```bash
cd frontend
npm install
npm run dev     # http://localhost:5173
npm run build   # dist/
npm run lint    # oxlint
```

Все тексты лендинга на английском. На странице есть подключение кошелька Unicity Sphere
через Sphere Connect Protocol (`autoConnect`, popup открывается на
`sphere.unicity.network`) и кнопка оплаты `PRICE` UCT через `send` intent — сайт не
касается ключей пользователя.

Публичные значения задаются в `frontend/.env` (без секретов):

| Переменная | Дефолт | Описание |
|---|---|---|
| `VITE_PRICE` | `10` | цена, отображаемая на лендинге |
| `VITE_NAMETAG` | `textcreator` | неймтег агента |
| `VITE_NETWORK` | `testnet2` | сеть дэпа (должна совпадать с кошельком) |
| `VITE_WALLET_URL` | `https://sphere.unicity.network` | URL кошелька для popup |

## Документация проекта

- `INSTRACTION.md` — инструкция по исправлению дефектов (аудит 2026-08-18)
- `PROJECT.md` — статус работ
- `DECISIONS.md` — журнал решений
- `KNOWLEDGE.md` — технические факты (проверены по SDK v0.14.9)
