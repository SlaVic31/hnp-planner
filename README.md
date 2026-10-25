# HnP Planner — lokalny asystent planowania (Outline + HacknPlan)

Lokalna aplikacja webowa (TypeScript, jeden backend, SQLite), która:

- odpowiada na pytania na podstawie **dokumentów Outline** (przez oficjalny serwer **MCP** Outline, tylko odczyt) i **bieżących zadań HacknPlan** (REST API v0), z linkami do źródeł,
- pozwala modelowi językowemu **proponować** utworzenie lub edycję zadań w HacknPlan — zapis następuje **wyłącznie** po jawnym zatwierdzeniu konkretnej propozycji przechowywanej na serwerze,
- składa opisy zadań według **szablonu Markdown** ustawianego dla każdego projektu,
- działa z modelem **lokalnym** (np. Ollama, dowolny endpoint zgodny z OpenAI), z **OpenAI API** (Responses) albo z **Anthropic Claude API** (Messages),
- uruchamia się natywnie (Node.js) albo w **Dockerze** z danymi w trwałym wolumenie.

Interfejs jest po polsku. Natywnie serwer nasłuchuje **wyłącznie na `127.0.0.1`**; w Dockerze port jest publikowany tylko na `127.0.0.1` hosta.

---

## Wymagania

- **Node.js ≥ 22.12** (sprawdzone na 22.23). Zależność `better-sqlite3` wymaga Node 22+; na macOS/Linux/Windows x64/arm64 instaluje gotowe binaria.
- npm 10+.
- albo **Docker** z Compose v2 (sprawdzone: Docker Desktop 27.4, Compose 2.31, macOS arm64).
- (opcjonalnie) [Ollama](https://ollama.com) dla modelu lokalnego.

## Uruchomienie natywne

```bash
npm ci            # lub: npm install
npm run build     # kompilacja serwera i interfejsu do dist/
npm run demo      # tryb DEMO: fikcyjne dane, bez sieci i bez kluczy
# albo
npm start         # tryb normalny (konfiguracja z ~/.hnp-planner/config.json)
```

Następnie otwórz **http://127.0.0.1:4317/**.

Opcje: `node dist/server/index.js --port 4400 --data-dir /ścieżka/do/danych [--demo]`. Zmienne: `HNP_PORT`, `HNP_PLANNER_HOME`, `HNP_DEMO=1`. Natywnie adres nasłuchu to zawsze `127.0.0.1` (zmienna `HNP_BIND_HOST` jest przeznaczona wyłącznie dla kontenera — patrz niżej).

Sprawdzenia:

```bash
npm run typecheck   # tsc (serwer, interfejs, testy)
npm test            # vitest — testy z deterministycznymi atrapami usług
npm run check       # wszystko naraz: typecheck + build + testy
```

## Uruchomienie w Dockerze

```bash
docker compose up -d --build     # budowa obrazu i start
# → http://127.0.0.1:4317/
docker compose logs -f           # logi (bez sekretów)
docker compose down              # zatrzymanie i usunięcie kontenera — DANE ZOSTAJĄ w wolumenie
```

> **Nie używaj `docker compose down -v`** — `-v` usuwa wolumen, a z nim bazę, konfigurację i zapisane klucze.

Co zapewnia konfiguracja ([`Dockerfile`](Dockerfile), [`compose.yaml`](compose.yaml)):

- **Trwałe dane:** cały katalog danych `/data` (`config.json`, `secrets.json`, `data.sqlite` + `-wal`/`-shm`, historia operacji) leży w nazwanym wolumenie `hnp-planner-data`. Przetrwa `docker compose up --force-recreate`, `down` + `up`, przebudowę obrazu i restart Dockera.
- **Tylko lokalnie:** port publikowany jako `127.0.0.1:${HNP_HOST_PORT:-4317}:4317` — aplikacja nie jest dostępna z sieci LAN.
- **Nasłuch w kontenerze:** obraz domyślnie także nasłuchuje na `127.0.0.1`; `compose.yaml` **jawnie** ustawia `HNP_BIND_HOST=0.0.0.0`, bez czego opublikowany port nie działałby. Poza kontenerem tej zmiennej nie ustawiaj.
- **Ochrona Host/Origin/CSRF zachowana:** `compose.yaml` ustawia `HNP_PUBLIC_ORIGINS=http://127.0.0.1:<port hosta>,http://localhost:<port hosta>`. Aplikacja akceptuje w tej zmiennej wyłącznie adresy `http` na pętli zwrotnej z portem — próba dopuszczenia adresu LAN kończy się błędem startu.
- **Bez uprawnień:** proces działa jako użytkownik `node` (uid 1000), system plików kontenera jest tylko do odczytu (`read_only`, zapis wyłącznie do `/data` i `tmpfs /tmp`), `cap_drop: ALL`, `no-new-privileges`.
- **Czysty kontekst budowania:** [`.dockerignore`](.dockerignore) dopuszcza tylko `src/`, `scripts/`, `package*.json` i `tsconfig*.json` — do obrazu nie trafiają sekrety, dane, `node_modules`, `dist`, testy ani artefakty.

Zmienne (ustaw w powłoce przed `docker compose …`):

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `HNP_HOST_PORT` | `4317` | port na hoście (zawsze na `127.0.0.1`) |
| `HNP_VOLUME_NAME` | `hnp-planner-data` | nazwa wolumenu danych |
| `HNP_COMPOSE_PROJECT` | `hnp-planner` | nazwa projektu Compose (osobne środowiska) |
| `HNP_DEMO` | `0` | `1` = tryb demo w kontenerze |

Przykład odizolowanego środowiska testowego (demo, osobny wolumen i port):

```bash
HNP_COMPOSE_PROJECT=hnp-planner-test HNP_VOLUME_NAME=hnp-planner-test-data HNP_HOST_PORT=4327 HNP_DEMO=1 \
  docker compose up -d
```

Klucze API w kontenerze najlepiej wpisać w **Ustawieniach** (trafiają do `/data/secrets.json` w wolumenie, `0600`). Zmienne `HNP_*_API_KEY` w `compose.yaml` też zadziałają, ale są widoczne w `docker inspect` — nie zalecamy.

### Kopia zapasowa, przywracanie, usuwanie danych

```bash
# kopia (zatrzymaj aplikację, aby baza SQLite była spójna)
docker compose stop
docker run --rm -v hnp-planner-data:/data:ro -v "$PWD":/backup busybox tar czf /backup/hnp-planner-backup.tgz -C /data .
docker compose start

# przywrócenie do pustego wolumenu
docker compose down
docker run --rm -v hnp-planner-data:/data -v "$PWD":/backup busybox sh -c 'tar xzf /backup/hnp-planner-backup.tgz -C /data && chown -R 1000:1000 /data && chmod 700 /data'
docker compose up -d

# CAŁKOWITE usunięcie danych (nieodwracalne)
docker compose down && docker volume rm hnp-planner-data
```

Archiwum kopii zawiera **klucze API jawnym tekstem** — przechowuj je jak hasła. Wolumen nie jest szyfrowany (Docker Desktop przechowuje go w maszynie wirtualnej Dockera).

### Model na hoście (Ollama) z kontenera

W Ustawieniach wybierz „Model lokalny / własny endpoint” i adres **`http://host.docker.internal:11434/v1`**. Aplikacja traktuje ten adres jako **lokalny** (host, na którym działa kontener).

- **Docker Desktop (macOS/Windows):** nazwa `host.docker.internal` działa od razu i dociera także do usług nasłuchujących tylko na `127.0.0.1` hosta — sprawdzone na Docker Desktop 27.4 (macOS). Ollamy nie trzeba przestawiać.
- **Linux (Docker Engine):** `compose.yaml` mapuje `host.docker.internal` na bramę mostka (`host-gateway`, zwykle `172.17.0.1`). Ollama domyślnie nasłuchuje tylko na `127.0.0.1`, więc z kontenera **nie będzie osiągalna**. Aplikacja **nie zmienia** ustawień Ollamy. Jeśli chcesz, uruchom Ollamę z adresem mostka, np. `OLLAMA_HOST=172.17.0.1:11434 ollama serve` (tylko interfejs Dockera, nie LAN). **Nie** ustawiaj `0.0.0.0` bez zapory — wystawisz model w sieci. (Zachowanie Linuksa opisane wg dokumentacji Dockera; nie było testowane w tym repozytorium.)

## Tryb demo a tryb połączony

| | Tryb demo (`npm run demo` / `HNP_DEMO=1`) | Tryb połączony |
|---|---|---|
| Outline | fikcyjne dokumenty w kodzie (`src/server/outline/demo.ts`) | prawdziwy serwer MCP Outline |
| HacknPlan | fikcyjne zadania w lokalnej bazie `demo.sqlite` | prawdziwe API `api.hacknplan.com/v0` |
| Model | reguły deterministyczne, **bez AI** | wybrany dostawca |
| Linki | `*.invalid` (celowo nieklikalne w sieci) | prawdziwe adresy Outline/HacknPlan |

Tryb jest zawsze widoczny w nagłówku (znaczniki **DEMO** / **POŁĄCZONO** dla każdej integracji) oraz w banerze. Każdą integrację można przełączać osobno. Uruchomienie z `--demo` blokuje przełączenie na prawdziwe usługi i używa osobnych plików (`config.demo.json`, `demo.sqlite`).

W demo zakładka „Zadania” ma przycisk **„Symuluj zmianę”**, który pokazuje wykrywanie nieaktualnych propozycji edycji.

Przy pierwszym `npm start` tworzony jest `config.json` z ustawieniami demo — prawdziwe usługi włączasz w zakładce **Ustawienia** (lub edytując plik).

## Konfiguracja

Pliki w katalogu danych (natywnie `~/.hnp-planner`, zmiana: `HNP_PLANNER_HOME` lub `--data-dir`; w Dockerze `/data` w wolumenie):

| Plik | Zawartość | Uprawnienia |
|---|---|---|
| `config.json` | ustawienia bez sekretów (w tym szablony opisów) | `0600` |
| `secrets.json` | klucze API (jawny tekst!) | `0600` |
| `data.sqlite` (+ `-wal`, `-shm`) | rozmowy, propozycje, historia operacji | `0600` |
| `config.demo.json`, `demo.sqlite` | odpowiedniki dla trybu demo | `0600` |

Katalog ma uprawnienia `0700`; przy starcie zbyt szerokie uprawnienia są zaostrzane. Przykładowa konfiguracja (bez sekretów): [`config.example.json`](config.example.json).

**Zgodność wsteczna:** konfiguracje z wcześniejszych wersji (bez szablonów i bez nowych dostawców) wczytują się bez zmian znaczenia — brakujące pola dostają wartości domyślne, a plik nie jest przepisywany automatycznie. Po zapisaniu ustawień w nowej wersji plik zawiera nowe pola, których **starsza wersja aplikacji nie przyjmie** (walidacja odrzuca nieznane pola) — przed cofnięciem wersji zrób kopię `config.json`.

Sekrety można podać w interfejsie (zakładka Ustawienia — pola tylko do zapisu, wartości nigdy nie wracają do przeglądarki) albo w zmiennych środowiskowych, które mają pierwszeństwo:

```bash
export HNP_OUTLINE_TOKEN='…'       # klucz API Outline
export HNP_HACKNPLAN_API_KEY='…'   # klucz API HacknPlan
export HNP_LLM_API_KEY='…'         # klucz endpointu zgodnego z OpenAI (niepotrzebny dla Ollamy)
export HNP_OPENAI_API_KEY='…'      # klucz OpenAI API (tryb Responses)
export HNP_ANTHROPIC_API_KEY='…'   # klucz Anthropic API
npm start
```

### Projekty i zakres kolekcji Outline

Każdy projekt w konfiguracji wiąże **jeden projekt HacknPlan** (`hacknplanProjectId`) z **listą kolekcji Outline** (`outlineCollectionIds`). Zakres jest egzekwowany po stronie serwera:

- wyszukiwanie w Outline jest wykonywane osobno dla każdej przypisanej kolekcji (filtr `collectionId`),
- każdy wynik i każdy pobrany dokument jest dodatkowo sprawdzany — dokument spoza kolekcji (lub bez `collectionId`) jest odrzucany i nie trafia do modelu,
- odczyty i zapisy HacknPlan dotyczą wyłącznie skonfigurowanego projektu; propozycje są powiązane z ID projektu HacknPlan i stają się niewykonalne, jeśli konfiguracja projektu się zmieni.

ID kolekcji można wybrać w Ustawieniach przyciskiem „Wybierz z listy kolekcji Outline” (narzędzie MCP `list_collections`) albo skopiować z Outline.

## Szablon opisu zadań

Każdy projekt może mieć własny szablon Markdown (`projects[].descriptionTemplate`; brak = szablon domyślny). Edytujesz go w **Ustawienia → projekt → „Szablon opisu zadań (Markdown)”** z podglądem na przykładowych danych i walidacją na bieżąco.

Model **nie pisze opisu ręcznie** — zwraca części (`summary`, `acceptanceCriteria`, `technicalNotes`, `sourceRefs`), a serwer składa z nich opis według szablonu.

| Znacznik | Znaczenie |
|---|---|
| `{{title}}` | tytuł zadania |
| `{{summary}}` | opis / cel zadania (od modelu) |
| `{{acceptance_criteria}}` | kryteria akceptacji jako lista `- …` (od modelu) |
| `{{technical_notes}}` | uwagi techniczne (od modelu) |
| `{{sources}}` | lista linków `- [tytuł](url)` — **budowana przez serwer wyłącznie z dokumentów i zadań, które faktycznie trafiły do modelu** |
| `{{project}}` | nazwa projektu |
| `{{date}}` | data przygotowania propozycji (RRRR-MM-DD) |
| `{{#pole}}…{{/pole}}` | sekcja wyświetlana tylko, gdy pole jest niepuste |
| `{{^pole}}…{{/pole}}` | sekcja wyświetlana tylko, gdy pole jest puste (np. „Brak źródeł”) |
| `{{! komentarz }}` | pomijany |

Szablon domyślny:

```
{{summary}}
{{#acceptance_criteria}}

## Kryteria akceptacji
{{acceptance_criteria}}
{{/acceptance_criteria}}
{{#technical_notes}}

## Uwagi techniczne
{{technical_notes}}
{{/technical_notes}}
{{#sources}}

## Źródła
{{sources}}
{{/sources}}
```

Zasady:

- Nieznane pola, niezamknięte lub źle zamknięte sekcje i niedomknięte `{{` są **odrzucane** przy zapisie ustawień (z komunikatem). Maks. 10 000 znaków szablonu, 20 000 znaków wyniku.
- Wartości są wstawiane dosłownie — tekst od modelu zawierający `{{…}}` nie jest interpretowany. Tytuły i adresy źródeł są oczyszczane, aby nie łamały składni linku; linkowane są tylko adresy `http(s)`.
- Odwołanie modelu do źródła spoza kontekstu (np. `D9`, którego nie było) **odrzuca propozycję**.
- Renderowanie jest deterministyczne i następuje **przed** obliczeniem hasha propozycji — zatwierdzasz dokładnie wyświetlony tekst.
- **Zmiana szablonu nie zmienia istniejących propozycji ani zadań** (propozycje są niezmienne; karta propozycji pokazuje wersję szablonu, z której powstał opis).
- Zgodność wsteczna: zwykłe pole `description` od modelu jest traktowane jako `summary`. Przy edycji zadania opis z szablonu powstaje tylko, gdy model poda `descriptionParts`; `changes.description` jest przyjmowane dosłownie.

## Outline — MCP (transport i uwierzytelnienie)

Aplikacja łączy się z **oficjalnym, wbudowanym serwerem MCP Outline** za pomocą oficjalnego SDK [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (1.32.x).

- **Transport:** wyłącznie **Streamable HTTP** (jedyny wspierany przez Outline). STDIO i stary transport SSE nie są obsługiwane.
- **Adres:** `https://<zespół>.getoutline.com/mcp`; dla instalacji własnej `https://<twoja-domena>/mcp`.
- **Włączenie:** administrator workspace włącza MCP w Outline: **Settings → AI** (jeśli wyłączone, połączenie zostanie odrzucone).
- **Uwierzytelnienie:** **klucz API** wysyłany jako `Authorization: Bearer <klucz>`. Klucz tworzysz w Outline: **Settings → API Keys**.
  - Zalecany zakres klucza: **`read`** (albo węższe `documents:read collections:read`). Przy takim zakresie serwer Outline w ogóle nie udostępnia narzędzi zapisu.
  - **OAuth (domyślny tryb Outline dla klientów interaktywnych) nie jest obsługiwany** — użyj klucza API.
- **Narzędzia:** po połączeniu aplikacja dynamicznie pobiera listę narzędzi (`tools/list`). Wywołuje wyłącznie `list_documents`, `fetch` (zasób `document`) i `list_collections`, i tylko jeśli serwer oznacza je `readOnlyHint: true`. Wszystkie inne narzędzia są blokowane i wykazywane w Ustawieniach → „Sprawdź połączenia” jako „wykryte narzędzia zapisu (zablokowane)”.
- Wyszukiwanie z zapytaniem (`list_documents` z `query`) jest zapisywane przez Outline w historii wyszukiwań użytkownika — to nie zmienia dokumentów.

Przycisk **„Sprawdź połączenia”** wykonuje prawdziwe `initialize` + `tools/list` (MCP) oraz 4 zapytania GET o metadane pierwszego projektu HacknPlan. **Nie łączy się z modelem** — do tego służy osobny test (niżej).

## HacknPlan — REST API v0

- Adres: `https://api.hacknplan.com/v0`, nagłówek `Authorization: ApiKey <klucz>`.
- Klucz: w HacknPlan **Avatar → Settings → API → Create**.
- **Zakresy klucza:** **Projects Read** (kategorie, etapy, priorytety, tablice) i **Work Items Read** — wystarczą do czatu i listy zadań. **Work Items Write** jest potrzebny tylko do wykonywania zatwierdzonych propozycji; bez niego zatwierdzenie kończy się błędem 403 („nieudana”, nic nie zapisano) — to dobry sposób na pracę ściśle tylko do odczytu.
- Używane endpointy: `GET /projects/{id}/workitems`, `GET/PATCH /projects/{id}/workitems/{wid}`, `POST /projects/{id}/workitems`, `GET /projects/{id}/categories|stages|importancelevels|boards`.
- API HacknPlan jest w wersji beta i działa na danych produkcyjnych — nie ma piaskownicy. Testy w tym repozytorium używają wyłącznie lokalnej atrapy.
- Link do zadania budowany jest z szablonu `webUrlTemplate` (domyślnie `https://app.hacknplan.com/p/{projectId}/kanban?taskId={workItemId}`); format adresów aplikacji webowej HacknPlan nie jest częścią API — dostosuj szablon, jeśli link nie otwiera zadania.

### Propozycje i zatwierdzanie (jedyna ścieżka zapisu)

1. Model zwraca JSON z odpowiedzią i listą propozycji (`create` / `update`).
2. Serwer waliduje każdą propozycję: dozwolone pola (nieznane → odrzucenie), długości, daty, ID kategorii/etapów/priorytetów/tablic istniejące w projekcie, zadanie edytowane musi należeć do projektu, brak duplikatu tytułu, edycja musi coś zmieniać, odwołania do źródeł tylko z kontekstu. Odrzucone propozycje są pokazane z powodem.
3. Opis jest składany z szablonu projektu; poprawne propozycje są zapisywane w SQLite jako **oczekujące** wraz z hashem SHA‑256 treści oraz (dla edycji) migawką bieżących wartości i `updateDate`.
4. Interfejs pokazuje dokładny podgląd (przed → po). **Zatwierdź** wysyła tylko ID i hash; serwer wykonuje wyłącznie zapisaną treść, jeśli hash się zgadza.
5. Przejście `oczekuje → wykonywanie` jest atomowe — ponowne lub równoczesne zatwierdzenie zwraca 409 i **nie wykonuje zapisu drugi raz**.
6. Edycja: przed `PATCH` zadanie jest odczytywane ponownie; jeśli zmieniło się `updateDate` lub którekolwiek edytowane pole — propozycja jest **nieaktualna** i nic nie jest zapisywane. Wysyłane są tylko zmienione pola.
7. Wynik: *wykonana*, *nieudana* (HacknPlan jednoznacznie odrzucił, np. 4xx — nic nie zapisano), albo **wynik nieznany** (brak odpowiedzi/5xx). Wynik nieznany **nigdy nie jest ponawiany automatycznie**: przycisk „Sprawdź w HacknPlan” szuka zadania; dopiero gdy go nie ma, możesz potwierdzić i utworzyć **nową** propozycję, wymagającą ponownego zatwierdzenia.
8. „Zatwierdź wszystkie” wykonuje propozycje po kolei i pokazuje wynik każdej (częściowe powodzenie jest widoczne).
9. Każdy krok trafia do **historii operacji**. Propozycje przerwane przez zamknięcie aplikacji są po restarcie oznaczane jako „wynik nieznany”.

## Model językowy — dostawcy i uwierzytelnienie

| Dostawca (Ustawienia → Model) | API | Uwierzytelnienie | Sekret |
|---|---|---|---|
| Demo | — (reguły, bez AI) | — | — |
| Model lokalny / własny endpoint | OpenAI **Chat Completions** (`POST {baseUrl}/chat/completions`) — Ollama, LM Studio, vLLM, własny serwer | opcjonalny klucz (Bearer) | `llmApiKey` / `HNP_LLM_API_KEY` |
| OpenAI API | oficjalne **Responses API** (`POST /v1/responses`) przez SDK `openai`, `store: false` | **klucz API** z platform.openai.com (rozliczany wg zużycia API) | `openaiApiKey` / `HNP_OPENAI_API_KEY` |
| Anthropic Claude API | oficjalne **Messages API** (`POST /v1/messages`) przez SDK `@anthropic-ai/sdk` | **klucz API** z Claude Console | `anthropicApiKey` / `HNP_ANTHROPIC_API_KEY` |

Każdy dostawca ma osobny sekret przechowywany wyłącznie po stronie serwera.

**Wybór modelu:** pole „Model” podpowiada identyfikatory pobrane przyciskiem **„Pobierz listę modeli”** (`GET /models` u dostawcy — bez generowania tokenów). Domyślne propozycje: `llama3.1:8b` (Ollama), `gpt-6-astra` (OpenAI), `claude-opus-5-5` (Anthropic) — zmień na model dostępny dla Twojego klucza. Dla Anthropic można ustawić **poziom wysiłku** (`effort`); `temperature` nie jest wysyłane (API Anthropic je odrzuca). Wybrany model pozostaje wybrany; aplikacja nie włącza automatycznej zamiany modelu po odmowie.

**Test połączenia:** przycisk **„Testuj połączenie z modelem”** wysyła **jedno krótkie, neutralne zapytanie** („Reply with the single word OK.”) **bez dokumentów i zadań projektu** i pokazuje odpowiedź, model i czas. Może to wiązać się z opłatami za API. Test jest zapisywany w historii operacji (bez treści i kluczy). Ogólny status („Sprawdź połączenia”) **nie** łączy się z modelem i pokazuje to wprost.

### Logowanie kontem (ChatGPT / Claude) zamiast klucza API

- **Claude (Anthropic):** **nieobsługiwane i niedozwolone.** Zgodnie z [zasadami Anthropic](https://code.claude.com/docs/en/legal-and-compliance) aplikacje zewnętrzne nie mogą oferować logowania kontem Claude.ai ani kierować żądań przez plany Free/Pro/Max — wymagany jest klucz API (lub dostawca chmurowy). Aplikacja nie odczytuje ani nie używa tokenów Claude Code.
- **ChatGPT (OpenAI):** OpenAI dokumentuje (w wersji **preview**) [„ChatGPT plan usage” przez Sign in with ChatGPT dla aplikacji open source i hostowanych lokalnie](https://developers.openai.com/siwc/token-sharing-open-source) — OAuth z PKCE i przekierowaniem na `http://127.0.0.1:<port>/…`, a następnie Responses API z `store: false` i `stream: true`, z [ograniczeniami preview](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). **Ten tryb nie jest jeszcze zaimplementowany** — czeka na decyzję, czy go dodać. Aplikacja nie odczytuje tokenów Codex CLI ani innych programów z dysku.
- Codex (CLI/app-server) nie jest używany.

### Lokalnie — Ollama

```bash
ollama pull llama3.1:8b
ollama serve                    # domyślnie http://127.0.0.1:11434
```

Ustawienia → Model: „Model lokalny / własny endpoint”, adres `http://127.0.0.1:11434/v1` (natywnie) lub `http://host.docker.internal:11434/v1` (z Dockera), model `llama3.1:8b`, klucz pusty. Jeśli serwer odrzuca `response_format`, wyłącz „Tryb JSON” — aplikacja i tak prosi o JSON w instrukcji i parsuje odpowiedź odpornie.

### Prywatność: model lokalny a zdalny

- **Lokalny** (`127.0.0.1`, `localhost`, `host.docker.internal`): pytania, fragmenty dokumentów Outline i lista zadań nie opuszczają komputera (poza samymi wywołaniami do Outline i HacknPlan).
- **Zdalny** (OpenAI, Anthropic, dowolny endpoint w sieci): do dostawcy wysyłane są: Twoje pytanie, ostatnie wiadomości rozmowy, do `maxDocuments` fragmentów dokumentów z przypisanych kolekcji (każdy do `maxCharsPerDocument` znaków) oraz lista do `maxTasksInContext` zadań z metadanymi projektu. Interfejs oznacza to czerwonym znacznikiem „model zdalny — dane wysyłane”. Przetwarzanie podlega warunkom danego dostawcy.
- Klucze API nigdy nie są wysyłane do modelu ani do przeglądarki.

## Bezpieczeństwo lokalnego API

- Natywnie nasłuch tylko na `127.0.0.1`; w Dockerze port publikowany tylko na `127.0.0.1` hosta. Nagłówek `Host` musi wskazywać `127.0.0.1`/`localhost` na właściwym porcie (lub źródło z `HNP_PUBLIC_ORIGINS`) — ochrona przed DNS rebinding.
- Każde żądanie zmieniające stan wymaga: zgodnego `Origin` (jeśli wysłany), `Sec-Fetch-Site: same-origin` (jeśli wysłany), `Content-Type: application/json` i nagłówka `X-CSRF-Token` (losowy token generowany przy starcie, pobierany przez stronę z tego samego źródła). Brak nagłówków CORS; preflight z obcych źródeł jest odrzucany.
- Nagłówki CSP (`default-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, `no-referrer`. Interfejs nie używa `innerHTML` dla danych z zewnątrz; linki tylko `http(s)`.
- Sekrety: maskowane w komunikatach błędów i logach; `GET /api/settings` zwraca tylko informację, czy sekret jest ustawiony i skąd.

## Ograniczenia (uczciwie)

- **Sekrety są przechowywane jawnym tekstem** w `secrets.json` (chronione wyłącznie uprawnieniami pliku `0600` / wolumenem Dockera), bez szyfrowania i bez integracji z pękiem kluczy systemu. Każdy proces działający jako Twój użytkownik (lub administrator, lub ktoś z dostępem do Dockera) może je odczytać. Kopie zapasowe zawierają klucze. Na Windows uprawnienia POSIX nie są stosowane.
- Baza SQLite nie jest szyfrowana (zawiera treść rozmów i fragmenty odpowiedzi modelu).
- Token CSRF chroni przed stronami w przeglądarce, ale **nie** przed innymi programami lokalnymi działającymi jako ten sam użytkownik (mogą odczytać token z `/api/session`). Aplikacja nie ma logowania — zakłada komputer jednoosobowy.
- Outline: tylko klucz API (bez OAuth); tylko Streamable HTTP; brak indeksu wektorowego — kontekst to wynik pełnotekstowego wyszukiwania Outline.
- HacknPlan: w kontekście są ostatnio zmieniane zadania (domyślnie 60) plus zadania wskazane w pytaniu jako `#123`. API nie oferuje warunkowego zapisu (ETag) ani kluczy idempotencji — sprawdzenie aktualności przed `PATCH` ma niewielkie okno wyścigu, a wykrywanie duplikatów po nieznanym wyniku opiera się na wyszukaniu po tytule.
- Obsługiwane pola zadań: tytuł, opis, kategoria, etap (tylko edycja), priorytet, tablica, szacowany koszt, daty, „story” (tylko tworzenie). Brak przypisywania osób, tagów, podzadań, zależności i usuwania.
- Model: logowanie kontem ChatGPT niezaimplementowane (preview OpenAI, czeka na decyzję); logowanie subskrypcją Claude niedozwolone. Jakość odpowiedzi zależy od modelu; małe modele lokalne mogą zwracać niepoprawny JSON (aplikacja pokazuje ostrzeżenie i nie tworzy propozycji). Odpowiedzi nie są strumieniowane.
- Docker: przetestowano na Docker Desktop (macOS arm64). Dostęp do Ollamy z kontenera na Linuksie wymaga ręcznej zmiany adresu nasłuchu Ollamy (nie testowano).
- Zmiana portu w Ustawieniach działa po restarcie.

## Testy i atrapy

`npm test` uruchamia **70 testów** (5 plików) bez poświadczeń, bez płatnych wywołań i bez dostępu do internetu:

- **Atrapa Outline MCP** (`test/mocks.ts`) — prawdziwy serwer MCP z SDK (`McpServer` + `StreamableHTTPServerTransport`) z narzędziami odczytu i narzędziem zapisu `create_document`, wymagający nagłówka Bearer.
- **Atrapa HacknPlan** — serwer HTTP z endpointami v0, kontrolą `ApiKey` i wstrzykiwaniem awarii (400/500, zerwane połączenie, utracona odpowiedź po zapisie).
- **Atrapy dostawców modeli** — `/v1/chat/completions` (zgodny z OpenAI), `/v1/responses` (OpenAI) i `/v1/messages` + `/v1/models` (Anthropic) w formatach oficjalnych API; prawdziwe SDK łączą się z nimi przez `baseURL`.

Pokrycie m.in.: wymaganie zatwierdzenia, niezgodny hash, wstrzyknięcie treści, brak innych ścieżek zapisu, podwójne i równoczesne zatwierdzenie (jeden zapis), integralność, zmiana zakresu projektu, nieaktualna edycja, wynik nieznany + weryfikacja, częściowe wyniki zbiorcze, zakres kolekcji, blokada narzędzi zapisu MCP, trwałość i odzyskiwanie, CSRF/Origin/Host/Content-Type i `HNP_PUBLIC_ORIGINS`, brak sekretów w odpowiedziach, uprawnienia plików; **szablony** (składnia, walidacja, bezpieczne linki, determinizm, renderowanie przed hashem, brak zmian wstecz, źródła tylko z kontekstu); **dostawcy** (kształt żądań Responses/Messages, brak `temperature` i automatycznej zamiany modelu, effort, odmowa, 401/404/429/500, lista modeli, prawdziwy test połączenia, brak klucza bez wywołania sieci); **zgodność wsteczna konfiguracji**.

Testy **nie** weryfikują połączenia z prawdziwymi usługami Outline, HacknPlan ani z prawdziwymi modelami.

## Struktura

```
src/server/        backend (Express 5, better-sqlite3, zod)
  app.ts           trasy API
  security.ts      Host/Origin/CSRF/nagłówki, HNP_PUBLIC_ORIGINS
  config.ts        konfiguracja, sekrety, uprawnienia plików
  db.ts            schemat SQLite i migracje
  chat.ts          czat ugruntowany w źródłach
  proposals.ts     walidacja i wykonywanie propozycji
  template.ts      szablony opisów zadań
  llm.ts           wspólny prompt, dostawca zgodny z OpenAI, model demo
  providers.ts     OpenAI Responses i Anthropic Messages (oficjalne SDK)
  outline/         klient MCP, zakres kolekcji, dane demo
  hacknplan/       klient REST v0, dane demo
src/web/           interfejs (TypeScript bez frameworka)
test/              testy vitest i atrapy usług
Dockerfile, compose.yaml, .dockerignore
```
