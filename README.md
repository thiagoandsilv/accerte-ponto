# Ponto Accerte

Kiosk de ponto compartilhado para equipes: cada pessoa seleciona seu nome e registra entrada, intervalo e saída; um painel de relatórios mostra o histórico com totais de horas e exportação em CSV.

Stack: Node.js + Express servindo uma API REST e o frontend estático, com PostgreSQL como banco de dados.

## Rodando localmente

Pré-requisitos: Node.js 18+ e um Postgres acessível (local ou remoto).

```bash
npm install
cp .env.example .env
# edite o .env com a URL do seu Postgres local
npm start
```

O servidor cria as tabelas automaticamente na primeira inicialização (`db/schema.sql`). Acesse `http://localhost:3000`.

## Deploy no Render (Postgres + Web Service, via GitHub)

1. **Suba este código para um repositório no GitHub** (veja instruções que o Claude te passou na conversa).
2. **Crie um banco Postgres no Render** (plano Free): Dashboard → New → PostgreSQL. Copie a "Internal Database URL" depois de criado.
3. **Crie um Web Service no Render** apontando para o repositório do GitHub:
   - Build command: `npm install`
   - Start command: `npm start`
   - Runtime: Node
   - Variáveis de ambiente:
     - `DATABASE_URL`: cole a Internal Database URL do passo 2.
     - `SESSION_SECRET`: uma string aleatória longa (usada para assinar o cookie de sessão).
     - `ADMIN_PASSWORD`: a senha que você (admin) vai digitar toda vez que cadastrar uma pessoa nova.
     - `ADMIN_EMPLOYEE_NAME` (opcional): nome exato de uma pessoa já cadastrada que deve virar gestora
       automaticamente sempre que o servidor iniciar. Útil para o primeiro gestor (bootstrap) — depois disso
       você pode marcar outras pessoas como gestoras direto no cadastro.
4. O deploy automático fica ligado por padrão — todo push na branch principal gera um novo deploy.
5. Acesse a URL pública que o Render gerar (algo como `https://ponto-certo.onrender.com`).

**Nota sobre o plano gratuito do Render:** o Web Service "dorme" após um período de inatividade (a primeira requisição depois disso demora alguns segundos) e o banco Postgres gratuito expira 30 dias após a criação — depois disso é preciso recriar o banco ou migrar para um plano pago.

## Estrutura

```
server.js        servidor Express + rotas da API
db/schema.sql     schema do Postgres (criado automaticamente na inicialização)
public/index.html frontend (kiosk de ponto + relatórios)
```

## Login

Cada pessoa entra com nome + senha (evita que alguém bata ponto pela outra). Você (admin) cadastra cada pessoa
informando o nome, uma senha inicial para ela e a `ADMIN_PASSWORD` configurada no Render — a pessoa pode usar
essa senha inicial normalmente depois (trocar a própria senha ainda não está implementado).

## Gestor e aprovações

Ao cadastrar uma pessoa você pode marcá-la como gestora ("Esta pessoa também é gestora"). Gestores veem uma
aba extra, **Aprovações**: toda edição manual de um registro (feita pelos Relatórios) fica com status
`pendente` até um gestor aprovar ou rejeitar. Pontos batidos normalmente (inclusive retroativos) não passam
por aprovação — só edições manuais.

## Ponto retroativo

Na tela "Bater ponto" tem um seletor de data (padrão: hoje). Dá pra escolher um dia anterior e registrar
entrada/intervalo/saída normalmente para aquele dia, caso a pessoa tenha esquecido de bater o ponto na hora.

## Horas extras

Qualquer jornada acima de 8h no dia é contabilizada como hora extra automaticamente (sem precisar de
aprovação separada) — aparece como uma coluna "Extra" nos relatórios e como total no painel de estatísticas.

## API

- `GET /api/config` — configurações públicas (ex.: `horasNormaisMin`, limite diário antes de contar hora extra)
- `GET /api/employees` — lista funcionários (pública, usada para preencher o seletor de nome no login)
- `POST /api/employees` — cadastra funcionário `{ name, password, adminPassword, isAdmin? }` (requer `adminPassword` correta)
- `POST /api/login` — autentica `{ name, password }`, cria sessão
- `POST /api/logout` — encerra a sessão
- `GET /api/me` — retorna o usuário da sessão atual, incluindo `isAdmin` (ou `null`)
- `GET /api/records/today?date=` — registro de uma data do usuário logado (requer sessão)
- `POST /api/records/punch` — bate ponto `{ date, type, observacao? }` (`type`: `entrada` | `intervaloIni` | `intervaloFim` | `saida`) (requer sessão; `date` pode ser um dia anterior)
- `PATCH /api/records/:id/observacao` — atualiza a observação de um registro `{ observacao }` (requer sessão)
- `PUT /api/records/:id` — edição manual `{ entrada, inicioIntervalo, fimIntervalo, saida, observacao }` (requer sessão; marca o registro como `pendente`)
- `GET /api/records?start=&end=&employeeId=` — relatório por período (requer sessão)
- `GET /api/records/pending` — lista registros `pendente` (requer sessão de gestor)
- `POST /api/records/:id/approve` — aprova um registro pendente (requer sessão de gestor)
- `POST /api/records/:id/reject` — rejeita um registro pendente (requer sessão de gestor)
