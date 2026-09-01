# Ponto Certo

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
   - Variável de ambiente `DATABASE_URL`: cole a Internal Database URL do passo 2.
4. O deploy automático fica ligado por padrão — todo push na branch principal gera um novo deploy.
5. Acesse a URL pública que o Render gerar (algo como `https://ponto-certo.onrender.com`).

**Nota sobre o plano gratuito do Render:** o Web Service "dorme" após um período de inatividade (a primeira requisição depois disso demora alguns segundos) e o banco Postgres gratuito expira 30 dias após a criação — depois disso é preciso recriar o banco ou migrar para um plano pago.

## Estrutura

```
server.js        servidor Express + rotas da API
db/schema.sql     schema do Postgres (criado automaticamente na inicialização)
public/index.html frontend (kiosk de ponto + relatórios)
```

## API

- `GET /api/employees` — lista funcionários
- `POST /api/employees` — cria funcionário `{ name }`
- `GET /api/records/today?employeeId=&date=` — registro do dia de um funcionário
- `POST /api/records/punch` — bate ponto `{ employeeId, date, type, observacao? }` (`type`: `entrada` | `intervaloIni` | `intervaloFim` | `saida`)
- `PATCH /api/records/:id/observacao` — atualiza a observação de um registro `{ observacao }`
- `PUT /api/records/:id` — edição manual (admin) `{ entrada, inicioIntervalo, fimIntervalo, saida, observacao }`
- `GET /api/records?start=&end=&employeeId=` — relatório por período
